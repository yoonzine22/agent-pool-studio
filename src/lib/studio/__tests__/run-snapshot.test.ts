import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { eventBus, type ServerEvent } from '@/lib/event-bus'

import {
  createStudioRun,
  getStudioRun,
  getStudioRunWorkflowSnapshot,
} from '../run-store'
import {
  studioWorkflowWriteSchema,
  type StudioNodeStates,
  type StudioWorkflow,
} from '../schemas'

let db: Database.Database | null = null

afterEach(() => {
  db?.close()
  db = null
  vi.doUnmock('@/lib/db')
  vi.doUnmock('../runtime-process')
  vi.resetModules()
})

const originalWorkflow = {
  id: 10,
  workspaceId: 7,
  teamId: null,
  name: 'Immutable workflow',
  description: 'Original definition',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
    { id: 'approval', kind: 'approval', label: 'Approve', position: { x: 100, y: 0 } },
    {
      id: 'agent',
      kind: 'agent',
      label: 'Original builder',
      agentId: 91,
      prompt: 'Execute the original assignment.',
      position: { x: 200, y: 0 },
    },
    { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 300, y: 0 } },
  ],
  edges: [
    { id: 'start-approval', source: 'start', target: 'approval' },
    { id: 'approval-agent', source: 'approval', target: 'agent' },
    { id: 'agent-finish', source: 'agent', target: 'finish' },
  ],
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
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
    ) VALUES (
      91, 'Builder', 'developer', 'idle', 100, 100,
      '{"instructions":"Use the persisted workflow.","model":null}',
      7, '/tmp', 'codex'
    );
  `)
  database.prepare(`
    INSERT INTO agent_workflows (
      id, workspace_id, team_id, name, description, nodes, edges, created_at, updated_at
    ) VALUES (10, 7, NULL, ?, ?, ?, ?, 100, 100)
  `).run(
    originalWorkflow.name,
    originalWorkflow.description,
    JSON.stringify(originalWorkflow.nodes),
    JSON.stringify(originalWorkflow.edges),
  )
  return database
}

function mutateStoredWorkflow(database: Database.Database): void {
  const mutatedNodes = [
    { id: 'start', kind: 'start', label: 'Mutated start', position: { x: 0, y: 0 } },
    { id: 'finish', kind: 'finish', label: 'Mutated finish', position: { x: 100, y: 0 } },
  ]
  database.prepare(`
    UPDATE agent_workflows
    SET name = 'Mutated workflow', description = 'Changed after run creation',
        nodes = ?, edges = ?, updated_at = 200
    WHERE id = 10
  `).run(
    JSON.stringify(mutatedNodes),
    JSON.stringify([{ id: 'start-finish', source: 'start', target: 'finish' }]),
  )
}

describe('Agent Studio workflow run snapshots', () => {
  it('persists the workflow definition that existed when the run was created', () => {
    // Given
    db = createRunDatabase()
    const run = createStudioRun(db, 7, originalWorkflow, 'input', 'operator')

    // When
    mutateStoredWorkflow(db)
    const snapshot = getStudioRunWorkflowSnapshot(db, 7, run.id)

    // Then
    expect(snapshot).toEqual(originalWorkflow)
    expect(getStudioRun(db, 7, run.id)?.workflowName).toBe(originalWorkflow.name)
  })

  it('resumes an approval-paused run from its snapshot after the workflow is edited', async () => {
    // Given
    db = createRunDatabase()
    const run = createStudioRun(db, 7, originalWorkflow, 'input', 'operator')
    const waitingStates: StudioNodeStates = {
      start: { status: 'completed', output: 'Start', error: null },
      approval: { status: 'waiting_approval', output: null, error: null },
      agent: { status: 'pending', output: null, error: null },
      finish: { status: 'pending', output: null, error: null },
    }
    db.prepare(`
      UPDATE agent_workflow_runs
      SET status = 'waiting_approval', node_states = ?, started_at = 100
      WHERE id = ?
    `).run(JSON.stringify(waitingStates), run.id)
    mutateStoredWorkflow(db)

    const runtimeRequests: Array<{ readonly prompt: string; readonly workspaceId: number }> = []
    vi.doMock('@/lib/db', () => ({ getDatabase: () => db }))
    vi.doMock('../runtime-process', () => ({
      runStudioRuntime: (request: { readonly prompt: string; readonly workspaceId: number }) => {
        runtimeRequests.push(request)
        return Promise.resolve('snapshot result')
      },
    }))
    const engine = await import('../engine')
    const pausedRun = getStudioRun(db, 7, run.id)
    if (!pausedRun) throw new TypeError('Expected the paused run to exist')
    let onCompleted = (_event: ServerEvent): void => undefined
    const completed = new Promise<void>((resolve) => {
      onCompleted = (event) => {
        if (event.type !== 'run.completed' || event.data.run_id !== run.id) return
        eventBus.off('server-event', onCompleted)
        resolve()
      }
      eventBus.on('server-event', onCompleted)
    })

    try {
      // When
      expect(engine.approveStudioRun(pausedRun)).toBe(true)
      await completed

      // Then
      expect(runtimeRequests).toHaveLength(1)
      expect(runtimeRequests[0]?.workspaceId).toBe(7)
      expect(getStudioRun(db, 7, run.id)?.status).toBe('completed')
    } finally {
      eventBus.off('server-event', onCompleted)
    }
  })
})

describe('Agent Studio workflow request bounds', () => {
  it('rejects a workflow body with more than one hundred nodes', () => {
    // Given
    const nodes = Array.from({ length: 101 }, (_, index) => ({
      id: `node-${index}`,
      kind: 'start' as const,
      label: `Node ${index}`,
      position: { x: index, y: 0 },
    }))

    // When
    const parsed = studioWorkflowWriteSchema.safeParse({
      name: 'Oversized workflow',
      description: '',
      teamId: null,
      nodes,
      edges: [{ id: 'edge', source: 'node-0', target: 'node-1' }],
    })

    // Then
    expect(parsed.success).toBe(false)
  })
})
