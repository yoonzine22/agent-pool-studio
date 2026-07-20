import type Database from 'better-sqlite3'
import { z } from 'zod'

import { eventBus } from '../event-bus'
import { createInitialNodeStates } from './graph'
import { reconcileOrphanedStudioRuns } from './run-reconciliation'
import type { StudioProcessRecoveryBoundary } from './runtime-reaper'
import {
  studioNodeStatesSchema,
  studioRunStatusSchema,
  studioWorkflowSchema,
  type StudioNodeStates,
  type StudioRun,
  type StudioRunEvent,
  type StudioRunStatus,
  type StudioWorkflow,
} from './schemas'
import { parseJson, toIsoDate } from './store-utils'

// allow: SIZE_OK — one SQLite run repository owns snapshot parsing and CAS-backed persistence.
const runRowSchema = z.object({
  id: z.number().int().positive(),
  workspace_id: z.number().int().positive(),
  workflow_id: z.number().int().positive(),
  status: studioRunStatusSchema,
  input: z.string(),
  node_states: z.string(),
  workflow_snapshot: z.string(),
  requested_by: z.string(),
  error: z.string().nullable(),
  started_at: z.number().int().nullable(),
  completed_at: z.number().int().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
})

const eventRowSchema = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  node_id: z.string().nullable(),
  event_type: z.string(),
  message: z.string(),
  data: z.string().nullable(),
  created_at: z.number().int(),
})

const workflowSnapshotRowSchema = z.object({
  workflow_snapshot: z.string(),
})

function mapRun(row: unknown): StudioRun {
  const parsed = runRowSchema.parse(row)
  const workflow = parseJson(parsed.workflow_snapshot, studioWorkflowSchema)
  return {
    id: parsed.id,
    workspaceId: parsed.workspace_id,
    workflowId: parsed.workflow_id,
    workflowName: workflow.name,
    status: parsed.status,
    input: parsed.input,
    nodeStates: parseJson(parsed.node_states, studioNodeStatesSchema),
    requestedBy: parsed.requested_by,
    error: parsed.error,
    startedAt: toIsoDate(parsed.started_at),
    completedAt: toIsoDate(parsed.completed_at),
    createdAt: toIsoDate(parsed.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoDate(parsed.updated_at) ?? new Date(0).toISOString(),
  }
}

const selectRun = `
  SELECT r.* FROM agent_workflow_runs r
`

export function listStudioRuns(
  db: Database.Database,
  workspaceId: number,
  recoveryBoundary?: StudioProcessRecoveryBoundary,
): StudioRun[] {
  reconcileOrphanedStudioRuns(db, workspaceId, recoveryBoundary)
  return db.prepare(`${selectRun}
    WHERE r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 50
  `).all(workspaceId).map(mapRun)
}

export function getStudioRun(
  db: Database.Database,
  workspaceId: number,
  runId: number,
): StudioRun | null {
  reconcileOrphanedStudioRuns(db, workspaceId)
  return loadStudioRun(db, workspaceId, runId)
}

function loadStudioRun(
  db: Database.Database,
  workspaceId: number,
  runId: number,
): StudioRun | null {
  const row = db.prepare(`${selectRun} WHERE r.id = ? AND r.workspace_id = ?`)
    .get(runId, workspaceId)
  return row ? mapRun(row) : null
}

export function getStudioRunWorkflowSnapshot(
  db: Database.Database,
  workspaceId: number,
  runId: number,
): StudioWorkflow | null {
  const row = db.prepare(`
    SELECT workflow_snapshot FROM agent_workflow_runs
    WHERE id = ? AND workspace_id = ?
  `).get(runId, workspaceId)
  if (!row) return null
  const parsed = workflowSnapshotRowSchema.parse(row)
  return parseJson(parsed.workflow_snapshot, studioWorkflowSchema)
}

export function createStudioRun(
  db: Database.Database,
  workspaceId: number,
  workflow: StudioWorkflow,
  input: string,
  requestedBy: string,
): StudioRun {
  const now = Math.floor(Date.now() / 1_000)
  const states = createInitialNodeStates(workflow.nodes)
  const result = db.prepare(`
    INSERT INTO agent_workflow_runs
      (workspace_id, workflow_id, status, input, node_states, workflow_snapshot,
       requested_by, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    workspaceId,
    workflow.id,
    input,
    JSON.stringify(states),
    JSON.stringify(workflow),
    requestedBy,
    now,
    now,
  )
  const run = loadStudioRun(db, workspaceId, Number(result.lastInsertRowid))
  if (!run) throw new Error('Created run could not be loaded')
  eventBus.broadcast('run.created', { workspace_id: workspaceId, run_id: run.id, source: 'agent-studio' })
  return run
}

export interface StudioRunUpdate {
  readonly status: StudioRunStatus
  readonly nodeStates: StudioNodeStates
  readonly error: string | null
}

export function transitionStudioRun(
  db: Database.Database,
  expected: StudioRun,
  update: StudioRunUpdate,
): boolean {
  const now = Math.floor(Date.now() / 1_000)
  const started = update.status !== 'pending'
  const completed = ['completed', 'failed', 'cancelled'].includes(update.status)
  const result = db.prepare(`
    UPDATE agent_workflow_runs
    SET status = ?, node_states = ?, error = ?,
        started_at = CASE WHEN ? = 1 THEN COALESCE(started_at, ?) ELSE started_at END,
        completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
        updated_at = ?
    WHERE id = ? AND workspace_id = ? AND status = ? AND node_states = ?
      AND error IS ? AND cancellation_requested_at IS NULL
  `).run(
    update.status,
    JSON.stringify(update.nodeStates),
    update.error,
    started ? 1 : 0,
    now,
    completed ? 1 : 0,
    now,
    now,
    expected.id,
    expected.workspaceId,
    expected.status,
    JSON.stringify(expected.nodeStates),
    expected.error,
  )
  if (result.changes === 0) return false
  const eventType = completed ? 'run.completed' : 'run.updated'
  eventBus.broadcast(eventType, {
    workspace_id: expected.workspaceId,
    run_id: expected.id,
    status: update.status,
    source: 'agent-studio',
  })
  return true
}

export function requestStudioRunCancellation(
  db: Database.Database,
  expected: StudioRun,
): boolean {
  const now = Math.floor(Date.now() / 1_000)
  const result = db.prepare(`
    UPDATE agent_workflow_runs
    SET cancellation_requested_at = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND status = ? AND node_states = ?
      AND error IS ? AND cancellation_requested_at IS NULL
  `).run(
    now,
    now,
    expected.id,
    expected.workspaceId,
    expected.status,
    JSON.stringify(expected.nodeStates),
    expected.error,
  )
  if (result.changes === 0) return false
  eventBus.broadcast('run.updated', {
    workspace_id: expected.workspaceId,
    run_id: expected.id,
    status: expected.status,
    source: 'agent-studio',
  })
  return true
}

export function completeStudioRunCancellation(
  db: Database.Database,
  expected: StudioRun,
  nodeStates: StudioNodeStates,
): boolean {
  const now = Math.floor(Date.now() / 1_000)
  const result = db.prepare(`
    UPDATE agent_workflow_runs
    SET status = 'cancelled', node_states = ?, error = NULL,
        cancellation_requested_at = NULL,
        started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND status = ? AND node_states = ?
      AND error IS ? AND cancellation_requested_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_workflow_runtime_processes AS process
        WHERE process.workspace_id = ? AND process.run_id = ?
      )
  `).run(
    JSON.stringify(nodeStates),
    now,
    now,
    now,
    expected.id,
    expected.workspaceId,
    expected.status,
    JSON.stringify(expected.nodeStates),
    expected.error,
    expected.workspaceId,
    expected.id,
  )
  if (result.changes === 0) return false
  eventBus.broadcast('run.completed', {
    workspace_id: expected.workspaceId,
    run_id: expected.id,
    status: 'cancelled',
    source: 'agent-studio',
  })
  return true
}

export function recordStudioRunEvent(
  db: Database.Database,
  workspaceId: number,
  runId: number,
  nodeId: string | null,
  eventType: string,
  message: string,
  data: Record<string, unknown> | null = null,
): void {
  db.prepare(`
    INSERT INTO agent_workflow_events
      (workspace_id, run_id, node_id, event_type, message, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(workspaceId, runId, nodeId, eventType, message, data ? JSON.stringify(data) : null)
  eventBus.broadcast('run.updated', {
    workspace_id: workspaceId,
    run_id: runId,
    node_id: nodeId,
    event_type: eventType,
    message,
    source: 'agent-studio',
  })
}

export function listStudioRunEvents(
  db: Database.Database,
  workspaceId: number,
  runId: number,
): StudioRunEvent[] {
  return z.array(eventRowSchema).parse(db.prepare(`
    SELECT id, run_id, node_id, event_type, message, data, created_at
    FROM agent_workflow_events
    WHERE workspace_id = ? AND run_id = ? ORDER BY id ASC
  `).all(workspaceId, runId)).map((event) => ({
    id: event.id,
    runId: event.run_id,
    nodeId: event.node_id,
    eventType: event.event_type,
    message: event.message,
    data: event.data ? z.record(z.string(), z.unknown()).parse(JSON.parse(event.data)) : null,
    createdAt: toIsoDate(event.created_at) ?? new Date(0).toISOString(),
  }))
}
