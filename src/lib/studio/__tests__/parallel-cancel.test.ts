import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  hasStudioRunController,
} from '../run-controller'
import { createStudioRun, getStudioRun } from '../run-store'
import type {
  StudioRuntimeExecution,
  StudioRuntimeRequest,
} from '../runtime-process'
import type { StudioWorkflow } from '../schemas'

let db: Database.Database | null = null

afterEach(() => {
  db?.close()
  db = null
  vi.doUnmock('@/lib/db')
  vi.doUnmock('../runtime-process')
  vi.resetModules()
})

const parallelWorkflow = {
  id: 10,
  workspaceId: 7,
  teamId: null,
  name: 'Parallel cancellation workflow',
  description: '',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
    {
      id: 'first',
      kind: 'agent',
      label: 'First runtime',
      agentId: 91,
      prompt: 'Run the first assignment.',
      position: { x: 100, y: -50 },
    },
    {
      id: 'second',
      kind: 'agent',
      label: 'Second runtime',
      agentId: 92,
      prompt: 'Run the second assignment.',
      position: { x: 100, y: 50 },
    },
    { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: 'start-first', source: 'start', target: 'first' },
    { id: 'start-second', source: 'start', target: 'second' },
    { id: 'first-finish', source: 'first', target: 'finish' },
    { id: 'second-finish', source: 'second', target: 'finish' },
  ],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
} satisfies StudioWorkflow

function createParallelRunDatabase(): Database.Database {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE agent_workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      config TEXT,
      workspace_id INTEGER NOT NULL,
      workspace_path TEXT,
      runtime_type TEXT NOT NULL
    );
    INSERT INTO agents (
      id, name, role, status, created_at, updated_at, config,
      workspace_id, workspace_path, runtime_type
    ) VALUES
      (91, 'First', 'developer', 'idle', 100, 100,
       '{"instructions":"First instructions","model":null}', 7, '/tmp', 'codex'),
      (92, 'Second', 'reviewer', 'idle', 100, 100,
       '{"instructions":"Second instructions","model":null}', 7, '/tmp', 'codex');
  `)
  return database
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

describe('Agent Studio parallel cancellation', () => {
  it('awaits every started runtime termination before cancellation acknowledgement and controller release', async () => {
    // Given
    db = createParallelRunDatabase()
    const run = createStudioRun(db, 7, parallelWorkflow, '', 'operator')
    const firstTermination = deferred()
    const secondTermination = deferred()
    const bothStarted = deferred()
    const terminations = [firstTermination, secondTermination]
    const events: string[] = []
    let startedCount = 0
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db }))
    vi.doMock('../runtime-process', () => ({
      runStudioRuntime: (
        _request: StudioRuntimeRequest,
        execution: StudioRuntimeExecution,
      ): Promise<string> => {
        const termination = terminations[startedCount]
        if (!termination) return Promise.reject(new TypeError('Unexpected runtime invocation'))
        startedCount += 1
        const runtimeNumber = startedCount
        if (startedCount === terminations.length) bothStarted.resolve()
        return new Promise<string>((_resolve, reject) => {
          execution.signal.addEventListener('abort', async () => {
            await termination.promise
            events.push(`runtime.${runtimeNumber}.terminated`)
            reject(new DOMException('Run cancelled', 'AbortError'))
          }, { once: true })
        })
      },
    }))
    const engine = await import('../engine')
    engine.queueStudioRun(run.id, run.workspaceId)
    await bothStarted.promise
    const runningRun = getStudioRun(db, run.workspaceId, run.id)
    if (!runningRun) throw new TypeError('Expected the running test run to exist')
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_workflow_runtime_processes WHERE run_id = ?
    `).get(run.id)).toEqual({ count: 2 })

    // When
    const cancellationResult = engine.cancelStudioRun(runningRun)
    if (typeof cancellationResult === 'boolean') {
      throw new TypeError('Expected active cancellation to be asynchronous')
    }
    const cancellation = cancellationResult.then((cancelled) => {
      events.push('cancel.acknowledged')
      return cancelled
    })
    firstTermination.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))

    // Then
    expect.soft(events).not.toContain('cancel.acknowledged')
    expect.soft(hasStudioRunController(run.id)).toBe(true)
    secondTermination.resolve()
    await expect(cancellation).resolves.toBe(true)
    expect(events).toEqual([
      'runtime.1.terminated',
      'runtime.2.terminated',
      'cancel.acknowledged',
    ])
    expect(hasStudioRunController(run.id)).toBe(false)
    expect(getStudioRun(db, run.workspaceId, run.id)?.status).toBe('cancelled')
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_workflow_runtime_processes WHERE run_id = ?
    `).get(run.id)).toEqual({ count: 0 })
  })
})
