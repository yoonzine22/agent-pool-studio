import Database from 'better-sqlite3'

import type { StudioSystemProcess } from '../runtime-reaper'
import type { StudioNodeStates, StudioRun, StudioWorkflow } from '../schemas'

export const RUN_ID = 41
export const WORKSPACE_ID = 7
export const AGENT_ID = 91
export const OWNED_PROCESS = {
  pid: 841,
  pgid: 841,
  state: 'S',
  startedAt: 'Tue Jul 21 06:00:00 2026',
  commandLine: 'agent-studio:restart-cancel-token exec --json',
} as const satisfies StudioSystemProcess

const workflowSnapshot = {
  id: 10,
  workspaceId: WORKSPACE_ID,
  teamId: null,
  name: 'Restart cancellation workflow',
  description: '',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
    { id: 'agent', kind: 'agent', label: 'Builder', agentId: AGENT_ID, prompt: 'Build it.', position: { x: 100, y: 0 } },
    { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 200, y: 0 } },
  ],
  edges: [{ id: 'start-agent', source: 'start', target: 'agent' },
    { id: 'agent-finish', source: 'agent', target: 'finish' }],
  createdAt: '1970-01-01T00:01:40.000Z',
  updatedAt: '1970-01-01T00:01:40.000Z',
} satisfies StudioWorkflow

const nodeStates = {
  start: { status: 'completed', output: 'Start', error: null },
  agent: { status: 'running', output: null, error: null },
  finish: { status: 'pending', output: null, error: null },
} as const satisfies StudioNodeStates

export function createRestartRunDatabase(): {
  readonly database: Database.Database
  readonly run: StudioRun
} {
  const database = new Database(':memory:')
  database.exec(`
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
  `)
  database.prepare(`
    INSERT INTO agent_workflow_runs (
      id, workspace_id, workflow_id, status, input, node_states, workflow_snapshot,
      requested_by, error, cancellation_requested_at, started_at, completed_at,
      created_at, updated_at
    ) VALUES (?, ?, 10, 'running', '', ?, ?, 'operator', NULL, NULL, 100, NULL, 100, 100)
  `).run(RUN_ID, WORKSPACE_ID, JSON.stringify(nodeStates), JSON.stringify(workflowSnapshot))
  database.prepare(`
    INSERT INTO agents (id, workspace_id, status, updated_at)
    VALUES (?, ?, 'busy', 100)
  `).run(AGENT_ID, WORKSPACE_ID)
  database.prepare(`
    INSERT INTO agent_workflow_runtime_processes (
      ownership_token, workspace_id, run_id, node_id, agent_id,
      process_pid, process_pgid, process_started_at, created_at, updated_at
    ) VALUES ('restart-cancel-token', ?, ?, 'agent', ?, ?, ?, ?, 100, 100)
  `).run(
    WORKSPACE_ID,
    RUN_ID,
    AGENT_ID,
    OWNED_PROCESS.pid,
    OWNED_PROCESS.pgid,
    OWNED_PROCESS.startedAt,
  )
  const run: StudioRun = {
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: workflowSnapshot.id,
    workflowName: workflowSnapshot.name,
    status: 'running',
    input: '',
    nodeStates,
    requestedBy: 'operator',
    error: null,
    startedAt: '1970-01-01T00:01:40.000Z',
    completedAt: null,
    createdAt: '1970-01-01T00:01:40.000Z',
    updatedAt: '1970-01-01T00:01:40.000Z',
  }
  return { database, run }
}
