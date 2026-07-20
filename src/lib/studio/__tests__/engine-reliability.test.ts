import Database from 'better-sqlite3'
import { NextRequest, NextResponse } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  acquireStudioRunController,
  releaseStudioRunController,
  runStudioAgentInvocation,
} from '../run-controller'
import { getStudioRun, transitionStudioRun } from '../run-store'
import type { StudioNodeStates, StudioRun, StudioWorkflow } from '../schemas'

let db: Database.Database | null = null

afterEach(() => {
  db?.close()
  db = null
  vi.doUnmock('@/lib/db')
  vi.doUnmock('@/lib/auth')
  vi.doUnmock('@/lib/rate-limit')
  vi.doUnmock('@/lib/studio/engine')
  vi.doUnmock('@/lib/studio/http')
  vi.resetModules()
})

const workflowSnapshot = {
  id: 10,
  workspaceId: 7,
  teamId: null,
  name: 'Reliable workflow',
  description: '',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
    { id: 'approval', kind: 'approval', label: 'Approve', position: { x: 100, y: 0 } },
    { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: 'start-approval', source: 'start', target: 'approval' },
    { id: 'approval-finish', source: 'approval', target: 'finish' },
  ],
  createdAt: '1970-01-01T00:01:40.000Z',
  updatedAt: '1970-01-01T00:01:40.000Z',
} satisfies StudioWorkflow

function createRunDatabase(): Database.Database {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE agent_workflows (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      team_id INTEGER,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      nodes TEXT NOT NULL,
      edges TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_workflow_runs (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      workflow_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      node_states TEXT NOT NULL,
      workflow_snapshot TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      error TEXT,
      cancellation_requested_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      run_id INTEGER NOT NULL,
      node_id TEXT,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE agent_workflow_runtime_processes (
      ownership_token TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      run_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      process_pid INTEGER,
      process_pgid INTEGER,
      process_started_at TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  database.prepare(`
    INSERT INTO agent_workflows (
      id, workspace_id, team_id, name, description, nodes, edges, created_at, updated_at
    ) VALUES (10, 7, NULL, ?, '', ?, ?, 100, 100)
  `).run(
    workflowSnapshot.name,
    JSON.stringify(workflowSnapshot.nodes),
    JSON.stringify(workflowSnapshot.edges),
  )
  return database
}

function insertRun(database: Database.Database, runId: number, status: StudioRun['status']): StudioRun {
  const nodeStates: StudioNodeStates = {
    approval: { status: 'waiting_approval', output: null, error: null },
  }
  database.prepare(`
    INSERT INTO agent_workflow_runs (
      id, workspace_id, workflow_id, status, input, node_states, workflow_snapshot,
      requested_by, error, cancellation_requested_at, started_at, completed_at,
      created_at, updated_at
    ) VALUES (?, 7, 10, ?, '', ?, ?, 'operator', NULL, NULL, 100, NULL, 100, 100)
  `).run(runId, status, JSON.stringify(nodeStates), JSON.stringify(workflowSnapshot))
  const run = getStudioRun(database, 7, runId)
  if (!run) throw new TypeError('Expected the test run to exist')
  return run
}

async function loadEngine(database: Database.Database): Promise<typeof import('../engine')> {
  vi.doMock('@/lib/db', () => ({ getDatabase: () => database }))
  return import('../engine')
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {
    throw new TypeError('Deferred promise was not initialized')
  }
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('Agent Studio atomic transitions', () => {
  it('lets approval win without a stale concurrent cancellation overwriting it', async () => {
    // Given
    db = createRunDatabase()
    const run = insertRun(db, 31, 'waiting_approval')
    const controller = acquireStudioRunController(run.id)
    if (!controller) throw new TypeError('Expected a controller for the test run')
    const engine = await loadEngine(db)

    try {
      // When
      const approved = engine.approveStudioRun(run)
      const cancelled = await engine.cancelStudioRun(run)

      // Then
      expect(approved).toBe(true)
      expect(cancelled).toBe(false)
      expect(getStudioRun(db, 7, run.id)?.status).toBe('running')
    } finally {
      releaseStudioRunController(run.id, controller)
    }
  })

  it('lets cancellation win without a stale concurrent approval reviving the run', async () => {
    // Given
    db = createRunDatabase()
    const run = insertRun(db, 32, 'waiting_approval')
    const engine = await loadEngine(db)

    // When
    const cancelled = await engine.cancelStudioRun(run)
    const approved = engine.approveStudioRun(run)

    // Then
    expect(cancelled).toBe(true)
    expect(approved).toBe(false)
    expect(getStudioRun(db, 7, run.id)?.status).toBe('cancelled')
  })

  it('allows only one terminal transition from the same run snapshot', () => {
    // Given
    db = createRunDatabase()
    const run = insertRun(db, 33, 'waiting_approval')
    const completedStates: StudioNodeStates = {
      approval: { status: 'completed', output: 'Approved', error: null },
    }

    // When
    const completed = transitionStudioRun(db, run, {
      status: 'completed',
      nodeStates: completedStates,
      error: null,
    })
    const cancelled = transitionStudioRun(db, run, {
      status: 'cancelled',
      nodeStates: { approval: { status: 'cancelled', output: null, error: null } },
      error: null,
    })

    // Then
    expect(completed).toBe(true)
    expect(cancelled).toBe(false)
    expect(getStudioRun(db, 7, run.id)?.status).toBe('completed')
  })

  it('does not persist cancelled until the live controller has completed shutdown', async () => {
    // Given
    db = createRunDatabase()
    const controller = acquireStudioRunController(34)
    if (!controller) throw new TypeError('Expected a controller for the running test run')
    const run = insertRun(db, 34, 'running')
    const engine = await loadEngine(db)

    // When
    const cancellation = engine.cancelStudioRun(run)
    if (typeof cancellation === 'boolean') {
      releaseStudioRunController(run.id, controller)
      throw new TypeError('Expected active cancellation to await controller completion')
    }
    let acknowledged = false
    void cancellation.then(() => {
      acknowledged = true
    })
    await Promise.resolve()

    // Then
    expect(acknowledged).toBe(false)
    expect(getStudioRun(db, 7, run.id)?.status).toBe('running')
    releaseStudioRunController(run.id, controller)
    await expect(cancellation).resolves.toBe(true)
    expect(getStudioRun(db, 7, run.id)?.status).toBe('cancelled')
  })
})

describe('Agent Studio per-agent execution', () => {
  it('serializes one agent and does not mark it idle while another invocation remains', async () => {
    // Given
    const firstGate = deferred()
    const secondGate = deferred()
    const firstStarted = deferred()
    const secondStarted = deferred()
    const events: string[] = []

    // When
    const first = runStudioAgentInvocation(91, {
      onStart: () => {
        events.push('first.started')
        firstStarted.resolve()
      },
      execute: async () => {
        events.push('first.executing')
        await firstGate.promise
        return 'first'
      },
      onIdle: () => events.push('first.idle'),
    })
    const second = runStudioAgentInvocation(91, {
      onStart: () => {
        events.push('second.started')
        secondStarted.resolve()
      },
      execute: async () => {
        events.push('second.executing')
        await secondGate.promise
        return 'second'
      },
      onIdle: () => events.push('second.idle'),
    })
    await firstStarted.promise

    // Then
    expect(events).toEqual(['first.started', 'first.executing'])
    firstGate.resolve()
    await expect(first).resolves.toBe('first')
    await secondStarted.promise
    expect(events).toEqual([
      'first.started',
      'first.executing',
      'second.started',
      'second.executing',
    ])
    secondGate.resolve()
    await expect(second).resolves.toBe('second')
    expect(events).toEqual([
      'first.started',
      'first.executing',
      'second.started',
      'second.executing',
      'second.idle',
    ])
  })
})

describe('Agent Studio run action boundary', () => {
  it('returns conflict when cancellation loses its compare-and-swap', async () => {
    // Given
    db = createRunDatabase()
    const run = insertRun(db, 35, 'waiting_approval')
    const limiter = vi.fn(() => null)
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db }))
    vi.doMock('@/lib/auth', () => ({
      requireRole: () => ({ user: { workspace_id: 7 } }),
    }))
    vi.doMock('@/lib/rate-limit', () => ({ mutationLimiter: limiter }))
    vi.doMock('@/lib/studio/http', () => ({
      parseStudioBody: () => Promise.resolve({ data: { action: 'cancel' as const } }),
    }))
    vi.doMock('@/lib/studio/engine', () => ({
      approveStudioRun: () => false,
      cancelStudioRun: () => Promise.resolve(false),
    }))
    const { POST } = await import('@/app/api/studio/runs/[id]/action/route')
    const request = new NextRequest('http://localhost/api/studio/runs/35/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'cancel' }),
    })

    // When
    const response = await POST(request, { params: Promise.resolve({ id: String(run.id) }) })

    // Then
    expect(limiter).toHaveBeenCalledOnce()
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Run cannot be cancelled' })
  })

  it('returns a rate-limit response before executing a run action', async () => {
    // Given
    db = createRunDatabase()
    const cancel = vi.fn(() => Promise.resolve(true))
    vi.doMock('@/lib/auth', () => ({
      requireRole: () => ({ user: { workspace_id: 7 } }),
    }))
    vi.doMock('@/lib/rate-limit', () => ({
      mutationLimiter: () => NextResponse.json({ error: 'limited' }, { status: 429 }),
    }))
    vi.doMock('@/lib/studio/engine', () => ({
      approveStudioRun: () => false,
      cancelStudioRun: cancel,
    }))
    const { POST } = await import('@/app/api/studio/runs/[id]/action/route')
    const request = new NextRequest('http://localhost/api/studio/runs/36/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'cancel' }),
    })

    // When
    const response = await POST(request, { params: Promise.resolve({ id: '36' }) })

    // Then
    expect(response.status).toBe(429)
    expect(cancel).not.toHaveBeenCalled()
  })
})
