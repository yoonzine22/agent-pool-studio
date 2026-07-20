import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  claimStudioRuntimeProcess,
  studioRuntimeProcessRowSchema,
} from '../runtime-ownership'

let db: Database.Database | null = null

function createOwnershipDatabase(): Database.Database {
  const database = new Database(':memory:')
  database.exec(`
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
    )
  `)
  return database
}

afterEach(() => {
  db?.close()
  db = null
})

describe('Agent Studio runtime ownership', () => {
  it('persists a discoverable claim before the process PID exists', () => {
    // Given
    db = createOwnershipDatabase()

    // When
    const ownership = claimStudioRuntimeProcess(db, {
      workspaceId: 7,
      runId: 24,
      nodeId: 'builder',
      agentId: 91,
    })

    // Then
    const row = studioRuntimeProcessRowSchema.parse(
      db.prepare('SELECT * FROM agent_workflow_runtime_processes').get(),
    )
    expect(row).toMatchObject({
      workspace_id: 7,
      run_id: 24,
      node_id: 'builder',
      agent_id: 91,
      process_pid: null,
      process_pgid: null,
      process_started_at: null,
    })
    expect(ownership.marker).toBe(`agent-studio:${row.ownership_token}`)
  })

  it('removes attached PID ownership after normal invocation completion', () => {
    // Given
    db = createOwnershipDatabase()
    const ownership = claimStudioRuntimeProcess(db, {
      workspaceId: 7,
      runId: 24,
      nodeId: 'builder',
      agentId: 91,
    })
    ownership.processStarted({
      pid: 731,
      pgid: 731,
      startedAt: 'Tue Jul 21 01:00:00 2026',
    })

    // When
    ownership.release()

    // Then
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_workflow_runtime_processes').get())
      .toEqual({ count: 0 })
  })
})
