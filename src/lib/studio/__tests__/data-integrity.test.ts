import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { deleteStudioAgent } from '../agent-store'
import { deleteStudioWorkflow } from '../workflow-store'
import { deleteStudioTeam, saveStudioTeam } from '../team-store'

let db: Database.Database | null = null

afterEach(() => {
  db?.close()
  db = null
})

function createDatabase(): Database.Database {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(`
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
    CREATE TABLE agent_teams (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_team_members (
      team_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (team_id, agent_id),
      FOREIGN KEY (team_id) REFERENCES agent_teams(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
    CREATE TABLE agent_workflows (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      team_id INTEGER,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      nodes TEXT NOT NULL,
      edges TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (team_id) REFERENCES agent_teams(id) ON DELETE SET NULL
    );
    CREATE TABLE agent_workflow_runs (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      workflow_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      node_states TEXT NOT NULL,
      workflow_snapshot TEXT,
      requested_by TEXT NOT NULL,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE
    );
  `)
  return database
}

function insertAgent(database: Database.Database, agentId = 10): void {
  database.prepare(`
    INSERT INTO agents (
      id, name, role, status, created_at, updated_at, config,
      workspace_id, workspace_path, runtime_type
    ) VALUES (?, 'Builder', 'developer', 'offline', 1, 1, ?, 1, '/tmp', 'codex')
  `).run(agentId, JSON.stringify({ instructions: '', model: null }))
}

function insertTeam(database: Database.Database, teamId = 20): void {
  database.prepare(`
    INSERT INTO agent_teams (id, workspace_id, name, description, created_at, updated_at)
    VALUES (?, 1, 'Builders', '', 1, 1)
  `).run(teamId)
  database.prepare(`
    INSERT INTO agent_team_members (team_id, agent_id, position) VALUES (?, 10, 0)
  `).run(teamId)
}

function insertWorkflow(database: Database.Database, workflowId = 30, teamId: number | null = 20): void {
  const nodes = [
    { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
    {
      id: 'agent',
      kind: 'agent',
      label: 'Builder',
      agentId: 10,
      prompt: 'Build it.',
      position: { x: 100, y: 0 },
    },
    { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 200, y: 0 } },
  ]
  database.prepare(`
    INSERT INTO agent_workflows (
      id, workspace_id, team_id, name, description, nodes, edges, created_at, updated_at
    ) VALUES (?, 1, ?, 'Build workflow', '', ?, ?, 1, 1)
  `).run(
    workflowId,
    teamId,
    JSON.stringify(nodes),
    JSON.stringify([
      { id: 'start-agent', source: 'start', target: 'agent' },
      { id: 'agent-finish', source: 'agent', target: 'finish' },
    ]),
  )
}

describe('Agent Studio data integrity', () => {
  it('rejects deleting an agent referenced by a saved workflow', () => {
    // Given
    const database = createDatabase()
    db = database
    insertAgent(database)
    insertTeam(database)
    insertWorkflow(database)

    // When
    expect(() => deleteStudioAgent(database, 1, 10)).toThrow(
      'Cannot delete agent 10: saved workflow 30 references this agent',
    )

    // Then
    expect(database.prepare('SELECT COUNT(*) AS count FROM agents WHERE id = 10').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM agent_workflows WHERE id = 30').get()).toEqual({ count: 1 })
  })

  it('rejects deleting an agent referenced by an active run snapshot', () => {
    const database = createDatabase()
    db = database
    insertAgent(database, 10)
    insertAgent(database, 11)
    insertWorkflow(database, 30, null)
    const replacementNodes = [
      { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
      { id: 'agent', kind: 'agent', label: 'Replacement', agentId: 11, prompt: 'Build it.', position: { x: 100, y: 0 } },
      { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 200, y: 0 } },
    ]
    database.prepare('UPDATE agent_workflows SET nodes = ? WHERE id = 30')
      .run(JSON.stringify(replacementNodes))
    const snapshot = {
      id: 30,
      workspaceId: 1,
      teamId: null,
      name: 'Build workflow',
      description: '',
      nodes: [
        { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
        { id: 'agent', kind: 'agent', label: 'Builder', agentId: 10, prompt: 'Build it.', position: { x: 100, y: 0 } },
        { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 200, y: 0 } },
      ],
      edges: [
        { id: 'start-agent', source: 'start', target: 'agent' },
        { id: 'agent-finish', source: 'agent', target: 'finish' },
      ],
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
    }
    database.prepare(`
      INSERT INTO agent_workflow_runs (
        id, workspace_id, workflow_id, status, input, node_states, workflow_snapshot,
        requested_by, error, started_at, completed_at, created_at, updated_at
      ) VALUES (41, 1, 30, 'waiting_approval', '', '{}', ?, 'operator', NULL, 1, NULL, 1, 1)
    `).run(JSON.stringify(snapshot))

    expect(() => deleteStudioAgent(database, 1, 10)).toThrow(
      'Cannot delete agent 10: active run 41 references this agent',
    )
    expect(database.prepare('SELECT COUNT(*) AS count FROM agents WHERE id = 10').get())
      .toEqual({ count: 1 })
  })

  it('rejects mutating a team referenced by a saved workflow', () => {
    // Given
    const database = createDatabase()
    db = database
    insertAgent(database)
    insertTeam(database)
    insertWorkflow(database)

    // When
    expect(() => saveStudioTeam(database, 1, {
      name: 'Renamed builders',
      description: 'Updated description',
      agentIds: [10],
    }, 20)).toThrow('Cannot update team 20: saved workflow 30 references this team')

    // Then
    expect(database.prepare('SELECT name FROM agent_teams WHERE id = 20').get()).toEqual({ name: 'Builders' })
  })

  it('rejects deleting a team referenced by a saved workflow', () => {
    // Given
    const database = createDatabase()
    db = database
    insertAgent(database)
    insertTeam(database)
    insertWorkflow(database)

    // When
    expect(() => deleteStudioTeam(database, 1, 20)).toThrow(
      'Cannot delete team 20: saved workflow 30 references this team',
    )

    // Then
    expect(database.prepare('SELECT COUNT(*) AS count FROM agent_teams WHERE id = 20').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT team_id FROM agent_workflows WHERE id = 30').get()).toEqual({ team_id: 20 })
  })

  it('rejects deleting a workflow while run history references it', () => {
    // Given
    const database = createDatabase()
    db = database
    insertAgent(database)
    insertTeam(database)
    insertWorkflow(database)
    database.prepare(`
      INSERT INTO agent_workflow_runs (
        id, workspace_id, workflow_id, status, input, node_states, requested_by,
        error, started_at, completed_at, created_at, updated_at
      ) VALUES (40, 1, 30, 'running', '', '{}', 'operator', NULL, 1, NULL, 1, 1)
    `).run()

    // When
    expect(() => deleteStudioWorkflow(database, 1, 30)).toThrow(
      'Cannot delete workflow 30: saved runs reference this workflow',
    )

    // Then
    expect(database.prepare('SELECT COUNT(*) AS count FROM agent_workflows WHERE id = 30').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM agent_workflow_runs WHERE id = 40').get()).toEqual({ count: 1 })
  })

  it('returns false for a foreign workflow even when its workspace has run history', () => {
    // Given
    const database = createDatabase()
    db = database
    database.prepare(`
      INSERT INTO agent_workflows (
        id, workspace_id, team_id, name, description, nodes, edges, created_at, updated_at
      ) VALUES (50, 2, NULL, 'Foreign workflow', '', ?, ?, 1, 1)
    `).run(
      JSON.stringify([
        { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
        { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 100, y: 0 } },
      ]),
      JSON.stringify([{ id: 'start-finish', source: 'start', target: 'finish' }]),
    )
    database.prepare(`
      INSERT INTO agent_workflow_runs (
        id, workspace_id, workflow_id, status, input, node_states, requested_by,
        error, started_at, completed_at, created_at, updated_at
      ) VALUES (51, 2, 50, 'completed', '', '{}', 'foreign-operator', NULL, 1, 1, 1, 1)
    `).run()

    // When
    const deleted = deleteStudioWorkflow(database, 1, 50)

    // Then
    expect(deleted).toBe(false)
    expect(database.prepare('SELECT COUNT(*) AS count FROM agent_workflows WHERE id = 50').get())
      .toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM agent_workflow_runs WHERE id = 51').get())
      .toEqual({ count: 1 })
  })
})
