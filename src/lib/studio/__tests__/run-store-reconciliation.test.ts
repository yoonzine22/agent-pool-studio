import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireStudioRunController,
  releaseStudioRunController,
  setStudioRunControllerAgents,
} from '../run-controller'
import { getStudioRun, listStudioRuns } from '../run-store'
import type {
  StudioProcessRecoveryBoundary,
  StudioSystemProcess,
} from '../runtime-reaper'
import type { StudioWorkflow } from '../schemas'

let db: Database.Database | null = null

afterEach(() => {
  db?.close()
  db = null
})

const workflowSnapshot = {
  id: 10,
  workspaceId: 7,
  teamId: null,
  name: 'Interrupted workflow',
  description: '',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
    {
      id: 'agent',
      kind: 'agent',
      label: 'Builder',
      agentId: 91,
      prompt: 'Build it.',
      position: { x: 100, y: 0 },
    },
    { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 200, y: 0 } },
  ],
  edges: [
    { id: 'start-agent', source: 'start', target: 'agent' },
    { id: 'agent-finish', source: 'agent', target: 'finish' },
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
    INSERT INTO agents (id, workspace_id, status, updated_at)
    VALUES (91, 7, 'busy', 100);
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

class FakeProcessRecoveryBoundary implements StudioProcessRecoveryBoundary {
  readonly signals: Array<readonly [number, NodeJS.Signals]> = []
  readonly statusAtSignal: string[] = []
  private readonly liveGroups: Set<number>

  constructor(
    private readonly database: Database.Database,
    readonly processes: readonly StudioSystemProcess[],
    private readonly killSucceeds = true,
  ) {
    this.liveGroups = new Set(processes.map((process) => process.pgid))
  }

  snapshot(): readonly StudioSystemProcess[] {
    return this.processes
  }

  signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
    this.signals.push([pgid, signal])
    const row = this.database.prepare(`
      SELECT status FROM agent_workflow_runs WHERE workspace_id = 7 ORDER BY id LIMIT 1
    `).get()
    this.statusAtSignal.push(String((row as { status: string }).status))
    if (signal === 'SIGKILL' && this.killSucceeds) this.liveGroups.delete(pgid)
    return true
  }

  isGroupAlive(pgid: number): boolean {
    return this.liveGroups.has(pgid)
  }

  wait(_milliseconds: number): void {}
}

function insertActiveRun(
  database: Database.Database,
  runId: number,
  status: 'pending' | 'running',
  workspaceId = 7,
): void {
  database.prepare(`
    INSERT INTO agent_workflow_runs (
      id, workspace_id, workflow_id, status, input, node_states, workflow_snapshot,
      requested_by, error, cancellation_requested_at, started_at, completed_at,
      created_at, updated_at
    ) VALUES (?, ?, 10, ?, '', ?, ?, 'operator', NULL, NULL, 100, NULL, 100, 100)
  `).run(
    runId,
    workspaceId,
    status,
    '{"start":{"status":"completed","output":"Start","error":null},"agent":{"status":"running","output":null,"error":null}}',
    JSON.stringify(workflowSnapshot),
  )
}

describe('Agent Studio run reconciliation', () => {
  it('marks an orphaned running row as failed when Studio runs are initialized', () => {
    // Given
    db = createRunDatabase()
    insertActiveRun(db, 20, 'running')

    // When
    const runs = listStudioRuns(db, 7)

    // Then
    expect(runs[0]?.status).toBe('failed')
    expect(runs[0]?.error).toContain('interrupted')
    expect(db.prepare('SELECT status FROM agents WHERE id = 91').get()).toEqual({ status: 'idle' })
  })

  it('reconciles an orphan and its busy agent on a detail read', () => {
    // Given
    db = createRunDatabase()
    insertActiveRun(db, 21, 'running')

    // When
    const run = getStudioRun(db, 7, 21)

    // Then
    expect(run?.status).toBe('failed')
    expect(db.prepare('SELECT status FROM agents WHERE id = 91').get()).toEqual({ status: 'idle' })
  })

  it('does not reset an orphaned agent while a live controller owns that agent', () => {
    // Given
    db = createRunDatabase()
    insertActiveRun(db, 22, 'running')
    insertActiveRun(db, 23, 'running')
    const controller = acquireStudioRunController(23)
    if (!controller) throw new TypeError('Expected a new controller for the test run')
    setStudioRunControllerAgents(23, controller, [91])

    try {
      // When
      const runs = listStudioRuns(db, 7)

      // Then
      expect(runs.find((run) => run.id === 22)?.status).toBe('failed')
      expect(runs.find((run) => run.id === 23)?.status).toBe('running')
      expect(db.prepare('SELECT status FROM agents WHERE id = 91').get()).toEqual({ status: 'busy' })
    } finally {
      releaseStudioRunController(23, controller)
    }
  })

  it('reconciles at most fifty orphaned runs in one Studio read', () => {
    // Given
    db = createRunDatabase()
    for (let runId = 1; runId <= 60; runId += 1) insertActiveRun(db, runId, 'pending')

    // When
    listStudioRuns(db, 7)

    // Then
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM agent_workflow_runs WHERE status = 'failed'").get(),
    ).toEqual({ count: 50 })
  })

  it('reclaims only a verified persisted process group before releasing the run agent', () => {
    // Given
    db = createRunDatabase()
    insertActiveRun(db, 24, 'running')
    insertActiveRun(db, 25, 'running')
    insertActiveRun(db, 26, 'running')
    db.prepare(`
      INSERT INTO agent_workflow_runtime_processes (
        ownership_token, workspace_id, run_id, node_id, agent_id,
        process_pid, process_pgid, process_started_at, created_at, updated_at
      ) VALUES (?, 7, ?, 'agent', 91, ?, ?, ?, 100, 100)
    `).run('owned-token', 24, 731, 731, 'Tue Jul 21 01:00:00 2026')
    db.prepare(`
      INSERT INTO agent_workflow_runtime_processes (
        ownership_token, workspace_id, run_id, node_id, agent_id,
        process_pid, process_pgid, process_started_at, created_at, updated_at
      ) VALUES (?, 7, ?, 'agent', 91, ?, ?, ?, 100, 100)
    `).run('stale-token', 25, 910, 910, 'Tue Jul 21 00:00:00 2026')
    db.prepare(`
      INSERT INTO agent_workflow_runtime_processes (
        ownership_token, workspace_id, run_id, node_id, agent_id,
        process_pid, process_pgid, process_started_at, created_at, updated_at
      ) VALUES (?, 7, ?, 'agent', 91, NULL, NULL, NULL, 100, 100)
    `).run('spawn-gap-token', 26)
    const boundary = new FakeProcessRecoveryBoundary(db, [
      {
        pid: 731,
        pgid: 731,
        state: 'S',
        startedAt: 'Tue Jul 21 01:00:00 2026',
        commandLine: 'agent-studio:owned-token exec --json',
      },
      {
        pid: 910,
        pgid: 910,
        state: 'S',
        startedAt: 'Tue Jul 21 02:00:00 2026',
        commandLine: '/usr/bin/unrelated-worker',
      },
      {
        pid: 811,
        pgid: 811,
        state: 'S',
        startedAt: 'Tue Jul 21 03:00:00 2026',
        commandLine: 'agent-studio:spawn-gap-token exec --json',
      },
    ])

    // When
    const runs = listStudioRuns(db, 7, boundary)

    // Then
    expect(boundary.signals.slice(0, 2)).toEqual(expect.arrayContaining([
      [731, 'SIGTERM'],
      [811, 'SIGTERM'],
    ]))
    expect(boundary.signals.slice(2)).toEqual(expect.arrayContaining([
      [731, 'SIGKILL'],
      [811, 'SIGKILL'],
    ]))
    expect(boundary.signals).toHaveLength(4)
    expect(boundary.statusAtSignal).toEqual(['running', 'running', 'running', 'running'])
    expect(runs.filter((run) => [24, 25, 26].includes(run.id)).map((run) => run.status))
      .toEqual(['failed', 'failed', 'failed'])
    expect(db.prepare('SELECT status FROM agents WHERE id = 91').get()).toEqual({ status: 'idle' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_workflow_runtime_processes').get())
      .toEqual({ count: 0 })
  })

  it('keeps the run active and agent busy when its verified process group survives KILL', () => {
    // Given
    db = createRunDatabase()
    insertActiveRun(db, 27, 'running')
    db.prepare(`
      INSERT INTO agent_workflow_runtime_processes (
        ownership_token, workspace_id, run_id, node_id, agent_id,
        process_pid, process_pgid, process_started_at, created_at, updated_at
      ) VALUES ('unkillable-token', 7, 27, 'agent', 91, 827, 827,
                'Tue Jul 21 04:00:00 2026', 100, 100)
    `).run()
    const boundary = new FakeProcessRecoveryBoundary(db, [{
      pid: 827,
      pgid: 827,
      state: 'S',
      startedAt: 'Tue Jul 21 04:00:00 2026',
      commandLine: 'agent-studio:unkillable-token exec --json',
    }], false)

    // When
    const runs = listStudioRuns(db, 7, boundary)

    // Then
    expect(boundary.signals).toEqual([
      [827, 'SIGTERM'],
      [827, 'SIGKILL'],
    ])
    expect(runs.find((run) => run.id === 27)?.status).toBe('running')
    expect(db.prepare('SELECT status FROM agents WHERE id = 91').get()).toEqual({ status: 'busy' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_workflow_runtime_processes').get())
      .toEqual({ count: 1 })
  })

  it('does not inspect or terminate persisted ownership from another workspace', () => {
    // Given
    db = createRunDatabase()
    insertActiveRun(db, 28, 'running', 8)
    db.prepare(`
      INSERT INTO agent_workflow_runtime_processes (
        ownership_token, workspace_id, run_id, node_id, agent_id,
        process_pid, process_pgid, process_started_at, created_at, updated_at
      ) VALUES ('workspace-eight-token', 8, 28, 'agent', 91, 828, 828,
                'Tue Jul 21 05:00:00 2026', 100, 100)
    `).run()
    const boundary = new FakeProcessRecoveryBoundary(db, [{
      pid: 828,
      pgid: 828,
      state: 'S',
      startedAt: 'Tue Jul 21 05:00:00 2026',
      commandLine: 'agent-studio:workspace-eight-token exec --json',
    }])

    // When
    listStudioRuns(db, 7, boundary)

    // Then
    expect(boundary.signals).toEqual([])
    expect(db.prepare('SELECT status FROM agent_workflow_runs WHERE id = 28').get())
      .toEqual({ status: 'running' })
  })
})
