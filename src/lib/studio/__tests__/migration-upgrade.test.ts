import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { agentStudioMigrations } from '../migrations'
import { studioWorkflowSchema } from '../schemas'

describe('Agent Studio migration upgrades', () => {
  let database: Database.Database | null = null

  afterEach(() => {
    database?.close()
    database = null
  })

  it('backfills snapshots and cancellation state for a previously applied Studio schema', () => {
    database = new Database(':memory:')
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
        requested_by TEXT NOT NULL,
        error TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    const nodes = [
      { id: 'start', label: 'Start', position: { x: 0, y: 0 }, kind: 'start' },
      {
        id: 'agent',
        label: 'Agent',
        position: { x: 200, y: 0 },
        kind: 'agent',
        agentId: 1,
        prompt: 'Verify',
      },
      { id: 'finish', label: 'Finish', position: { x: 400, y: 0 }, kind: 'finish' },
    ]
    const edges = [
      { id: 'one', source: 'start', target: 'agent' },
      { id: 'two', source: 'agent', target: 'finish' },
    ]
    database.prepare(`
      INSERT INTO agent_workflows
        (id, workspace_id, team_id, name, description, nodes, edges, created_at, updated_at)
      VALUES (1, 1, NULL, 'Legacy flow', 'Before snapshots', ?, ?, 1700000000, 1700000000)
    `).run(JSON.stringify(nodes), JSON.stringify(edges))
    database.prepare(`
      INSERT INTO agent_workflow_runs
        (id, workspace_id, workflow_id, status, input, node_states, requested_by,
         error, started_at, completed_at, created_at, updated_at)
      VALUES (1, 1, 1, 'waiting_approval', '', '{}', 'tester', NULL, 1700000000,
              NULL, 1700000000, 1700000000)
    `).run()

    for (const id of [
      '056_agent_workflow_run_snapshots',
      '057_agent_workflow_run_cancellation',
      '058_agent_workflow_runtime_processes',
    ]) {
      const migration = agentStudioMigrations.find((candidate) => candidate.id === id)
      expect(migration).toBeDefined()
      migration?.up(database)
    }

    const columns = z.array(z.object({ name: z.string() })).parse(
      database.pragma('table_info(agent_workflow_runs)'),
    )
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'workflow_snapshot',
      'cancellation_requested_at',
    ]))
    const row = z.object({ workflow_snapshot: z.string() }).parse(
      database.prepare('SELECT workflow_snapshot FROM agent_workflow_runs WHERE id = 1').get(),
    )
    const snapshot = studioWorkflowSchema.parse(JSON.parse(row.workflow_snapshot))
    expect(snapshot).toMatchObject({ id: 1, workspaceId: 1, name: 'Legacy flow', nodes, edges })
    const ownershipColumns = z.array(z.object({ name: z.string() })).parse(
      database.pragma('table_info(agent_workflow_runtime_processes)'),
    )
    expect(ownershipColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'ownership_token',
      'run_id',
      'process_pid',
      'process_pgid',
      'process_started_at',
    ]))
  })
})
