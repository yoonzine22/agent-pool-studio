import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { reconcileOrphanedStudioRuns } from '../run-reconciliation'
import type { StudioProcessRecoveryBoundary, StudioSystemProcess } from '../runtime-reaper'
import {
  AGENT_ID,
  createRestartRunDatabase,
  OWNED_PROCESS,
  RUN_ID,
  WORKSPACE_ID,
} from './restart-cancel-fixture'

let db: Database.Database | null = null

afterEach(() => {
  db?.close()
  db = null
  vi.doUnmock('@/lib/db')
  vi.resetModules()
})

class SequencedRecoveryBoundary implements StudioProcessRecoveryBoundary {
  readonly signals: Array<readonly [number, NodeJS.Signals]> = []
  private live = true
  private killAttempts = 0

  constructor(private readonly killOnAttempt: number | null,
    private readonly afterSuccessfulKill: (() => void) | null = null) {}

  snapshot(): readonly StudioSystemProcess[] {
    return this.live ? [OWNED_PROCESS] : []
  }

  signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
    this.signals.push([pgid, signal])
    if (signal === 'SIGKILL') {
      this.killAttempts += 1
      if (this.killAttempts === this.killOnAttempt) {
        this.live = false
        this.afterSuccessfulKill?.()
      }
    }
    return true
  }

  isGroupAlive(): boolean {
    return this.live
  }

  wait(_milliseconds: number): void {}
}

async function loadEngine(database: Database.Database): Promise<typeof import('../engine')> {
  vi.doMock('@/lib/db', () => ({ getDatabase: () => database }))
  return import('../engine')
}

describe('Agent Studio restart cancellation', () => {
  it('preserves a running orphan and busy agent when its durable process claim cannot be reclaimed', async () => {
    // Given
    const fixture = createRestartRunDatabase()
    db = fixture.database
    const boundary = new SequencedRecoveryBoundary(null)
    reconcileOrphanedStudioRuns(db, WORKSPACE_ID, boundary)
    const engine = await loadEngine(db)

    // When
    const cancelled = await engine.cancelStudioRun(fixture.run, boundary)

    // Then
    expect(cancelled).toBe(false)
    expect(db.prepare(`
      SELECT status, cancellation_requested_at, completed_at
      FROM agent_workflow_runs WHERE id = ?
    `).get(RUN_ID)).toEqual({
      status: 'running',
      cancellation_requested_at: expect.any(Number),
      completed_at: null,
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_workflow_runtime_processes WHERE run_id = ?
    `).get(RUN_ID)).toEqual({ count: 1 })
    expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT_ID))
      .toEqual({ status: 'busy' })
    expect(boundary.signals).toEqual([
      [OWNED_PROCESS.pgid, 'SIGTERM'],
      [OWNED_PROCESS.pgid, 'SIGKILL'],
      [OWNED_PROCESS.pgid, 'SIGTERM'],
      [OWNED_PROCESS.pgid, 'SIGKILL'],
    ])
  })

  it('completes restart cancellation only after a retry safely reclaims every durable process claim', async () => {
    // Given
    const fixture = createRestartRunDatabase()
    db = fixture.database
    const boundary = new SequencedRecoveryBoundary(2)
    reconcileOrphanedStudioRuns(db, WORKSPACE_ID, boundary)
    const engine = await loadEngine(db)

    // When
    const cancelled = await engine.cancelStudioRun(fixture.run, boundary)

    // Then
    expect(cancelled).toBe(true)
    expect(db.prepare(`
      SELECT status, cancellation_requested_at, completed_at
      FROM agent_workflow_runs WHERE id = ?
    `).get(RUN_ID)).toEqual({
      status: 'cancelled',
      cancellation_requested_at: null,
      completed_at: expect.any(Number),
    })
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM agent_workflow_runtime_processes WHERE run_id = ?
    `).get(RUN_ID)).toEqual({ count: 0 })
    expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT_ID))
      .toEqual({ status: 'idle' })
    expect(boundary.signals).toEqual([
      [OWNED_PROCESS.pgid, 'SIGTERM'],
      [OWNED_PROCESS.pgid, 'SIGKILL'],
      [OWNED_PROCESS.pgid, 'SIGTERM'],
      [OWNED_PROCESS.pgid, 'SIGKILL'],
    ])
  })

  it('preserves supervision when a new durable claim appears after the reaper snapshot', async () => {
    // Given
    const fixture = createRestartRunDatabase()
    db = fixture.database
    const boundary = new SequencedRecoveryBoundary(2, () => {
      fixture.database.prepare(`
        INSERT INTO agent_workflow_runtime_processes (
          ownership_token, workspace_id, run_id, node_id, agent_id,
          process_pid, process_pgid, process_started_at, created_at, updated_at
        ) VALUES ('concurrent-claim', ?, ?, 'agent', ?, NULL, NULL, NULL, 101, 101)
      `).run(WORKSPACE_ID, RUN_ID, AGENT_ID)
    })
    reconcileOrphanedStudioRuns(db, WORKSPACE_ID, boundary)
    const engine = await loadEngine(db)

    // When
    const cancelled = await engine.cancelStudioRun(fixture.run, boundary)

    // Then
    expect(cancelled).toBe(false)
    expect(db.prepare(`
      SELECT status, cancellation_requested_at, completed_at
      FROM agent_workflow_runs WHERE id = ?
    `).get(RUN_ID)).toEqual({
      status: 'running',
      cancellation_requested_at: expect.any(Number),
      completed_at: null,
    })
    expect(db.prepare(`
      SELECT ownership_token FROM agent_workflow_runtime_processes WHERE run_id = ?
    `).all(RUN_ID)).toEqual([{ ownership_token: 'concurrent-claim' }])
    expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT_ID))
      .toEqual({ status: 'busy' })
  })

  it('preserves supervision when the same claim token attaches a new process identity after the reaper snapshot', async () => {
    // Given
    const fixture = createRestartRunDatabase()
    db = fixture.database
    fixture.database.prepare(`
      UPDATE agent_workflow_runtime_processes
      SET process_pid = NULL, process_pgid = NULL, process_started_at = NULL, updated_at = 101
      WHERE ownership_token = 'restart-cancel-token'
    `).run()
    let attachmentChanges = 0
    const boundary = new SequencedRecoveryBoundary(2, () => {
      const result = fixture.database.prepare(`
        UPDATE agent_workflow_runtime_processes
        SET process_pid = ?, process_pgid = ?, process_started_at = ?, updated_at = unixepoch()
        WHERE ownership_token = ? AND workspace_id = ? AND run_id = ?
          AND process_pid IS NULL AND process_pgid IS NULL
      `).run(
        OWNED_PROCESS.pid,
        OWNED_PROCESS.pgid,
        OWNED_PROCESS.startedAt,
        'restart-cancel-token',
        WORKSPACE_ID,
        RUN_ID,
      )
      attachmentChanges = result.changes
    })
    reconcileOrphanedStudioRuns(db, WORKSPACE_ID, boundary)
    const engine = await loadEngine(db)

    // When
    const cancelled = await engine.cancelStudioRun(fixture.run, boundary)

    // Then
    expect(cancelled).toBe(false)
    expect(attachmentChanges).toBe(1)
    expect(db.prepare(`
      SELECT status, cancellation_requested_at, completed_at
      FROM agent_workflow_runs WHERE id = ?
    `).get(RUN_ID)).toEqual({
      status: 'running',
      cancellation_requested_at: expect.any(Number),
      completed_at: null,
    })
    expect(db.prepare(`
      SELECT ownership_token, process_pid, process_pgid, process_started_at
      FROM agent_workflow_runtime_processes WHERE run_id = ?
    `).all(RUN_ID)).toEqual([{
      ownership_token: 'restart-cancel-token',
      process_pid: OWNED_PROCESS.pid,
      process_pgid: OWNED_PROCESS.pgid,
      process_started_at: OWNED_PROCESS.startedAt,
    }])
    expect(db.prepare('SELECT status FROM agents WHERE id = ?').get(AGENT_ID))
      .toEqual({ status: 'busy' })
  })
})
