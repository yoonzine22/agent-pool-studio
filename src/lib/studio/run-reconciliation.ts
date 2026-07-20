import type Database from 'better-sqlite3'
import { z } from 'zod'

import { eventBus } from '../event-bus'
import {
  hasStudioRunController,
  isStudioAgentOwnedByLiveController,
} from './run-controller'
import {
  nodeStudioProcessRecoveryBoundary,
  reapStudioRuntimeProcessGroups,
  type StudioProcessRecoveryBoundary,
} from './runtime-reaper'
import { studioRuntimeProcessRowSchema } from './runtime-ownership'
import { studioWorkflowSchema } from './schemas'
import { parseJson } from './store-utils'

const activeRunRowSchema = z.object({
  id: z.number().int().positive(),
  workflow_snapshot: z.string(),
})

const MAX_RECONCILED_RUNS_PER_READ = 50
const INTERRUPTED_RUN_ERROR = 'Agent Studio run was interrupted by a server restart.'

class StudioRuntimeClaimIdentityChangedError extends Error {}

export type StudioRunRuntimeReclaimRequest = {
  readonly workspaceId: number
  readonly runId: number
  readonly boundary: StudioProcessRecoveryBoundary
}

export function reclaimStudioRunRuntimeProcesses(
  db: Database.Database,
  request: StudioRunRuntimeReclaimRequest,
): readonly number[] | null {
  const processRows = z.array(studioRuntimeProcessRowSchema).parse(db.prepare(`
    SELECT ownership_token, workspace_id, run_id, node_id, agent_id,
           process_pid, process_pgid, process_started_at
    FROM agent_workflow_runtime_processes
    WHERE workspace_id = ? AND run_id = ?
  `).all(request.workspaceId, request.runId))
  const reclaimed = reapStudioRuntimeProcessGroups(processRows, request.boundary)
  if (!processRows.every((row) => reclaimed.get(row.ownership_token) === true)) return null

  try {
    db.transaction(() => {
      for (const row of processRows) {
        const result = db.prepare(`
          DELETE FROM agent_workflow_runtime_processes
          WHERE ownership_token = ? AND workspace_id = ? AND run_id = ?
            AND process_pid IS ? AND process_pgid IS ? AND process_started_at IS ?
        `).run(
          row.ownership_token,
          request.workspaceId,
          request.runId,
          row.process_pid,
          row.process_pgid,
          row.process_started_at,
        )
        if (result.changes !== 1) throw new StudioRuntimeClaimIdentityChangedError()
      }
    })()
  } catch (error) {
    if (error instanceof StudioRuntimeClaimIdentityChangedError) return null
    throw error
  }
  return [...new Set(processRows.map((row) => row.agent_id))]
}

export function releaseReclaimedStudioAgents(
  db: Database.Database,
  workspaceId: number,
  agentIds: readonly number[],
): void {
  const now = Math.floor(Date.now() / 1_000)
  for (const agentId of new Set(agentIds)) {
    if (isStudioAgentOwnedByLiveController(agentId)) continue
    db.prepare(`
      UPDATE agents SET status = 'idle', updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status = 'busy'
        AND NOT EXISTS (
          SELECT 1 FROM agent_workflow_runtime_processes AS process
          INNER JOIN agent_workflow_runs AS run
            ON run.id = process.run_id AND run.workspace_id = process.workspace_id
          WHERE process.workspace_id = ? AND process.agent_id = ?
            AND run.status IN ('pending', 'running')
        )
    `).run(now, agentId, workspaceId, workspaceId, agentId)
  }
}

export function reconcileOrphanedStudioRuns(
  db: Database.Database,
  workspaceId: number,
  boundary: StudioProcessRecoveryBoundary = nodeStudioProcessRecoveryBoundary,
): void {
  const candidates = z.array(activeRunRowSchema).parse(db.prepare(`
    SELECT id, workflow_snapshot
    FROM agent_workflow_runs
    WHERE workspace_id = ? AND status IN ('pending', 'running')
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(workspaceId, MAX_RECONCILED_RUNS_PER_READ * 2))
  const orphaned = candidates
    .filter(({ id }) => !hasStudioRunController(id))
    .slice(0, MAX_RECONCILED_RUNS_PER_READ)
  if (orphaned.length === 0) return

  const orphanedIds = new Set(orphaned.map(({ id }) => id))
  const processRows = z.array(studioRuntimeProcessRowSchema).parse(db.prepare(`
    SELECT p.ownership_token, p.workspace_id, p.run_id, p.node_id, p.agent_id,
           p.process_pid, p.process_pgid, p.process_started_at
    FROM agent_workflow_runtime_processes AS p
    INNER JOIN agent_workflow_runs AS r
      ON r.id = p.run_id AND r.workspace_id = p.workspace_id
    WHERE p.workspace_id = ? AND r.workspace_id = ?
      AND r.status IN ('pending', 'running')
  `).all(workspaceId, workspaceId)).filter((row) => orphanedIds.has(row.run_id))
  const reclaimed = reapStudioRuntimeProcessGroups(processRows, boundary)
  const reclaimable = orphaned.filter((candidate) => processRows
    .filter((row) => row.run_id === candidate.id)
    .every((row) => reclaimed.get(row.ownership_token) === true))
  if (reclaimable.length === 0) return

  const now = Math.floor(Date.now() / 1_000)
  const reconciledIds: number[] = []
  const orphanedAgentIds = new Set<number>()
  db.transaction(() => {
    for (const candidate of reclaimable) {
      const result = db.prepare(`
        UPDATE agent_workflow_runs
        SET status = 'failed', error = ?, cancellation_requested_at = NULL,
            completed_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status IN ('pending', 'running')
      `).run(INTERRUPTED_RUN_ERROR, now, now, candidate.id, workspaceId)
      if (result.changes === 0) continue
      db.prepare(`
        DELETE FROM agent_workflow_runtime_processes
        WHERE workspace_id = ? AND run_id = ?
      `).run(workspaceId, candidate.id)
      const workflow = parseJson(candidate.workflow_snapshot, studioWorkflowSchema)
      for (const node of workflow.nodes) {
        if (node.kind === 'agent') orphanedAgentIds.add(node.agentId)
      }
      db.prepare(`
        INSERT INTO agent_workflow_events
          (workspace_id, run_id, node_id, event_type, message, data)
        VALUES (?, ?, NULL, 'run.interrupted', ?, NULL)
      `).run(workspaceId, candidate.id, INTERRUPTED_RUN_ERROR)
      reconciledIds.push(candidate.id)
    }
    releaseReclaimedStudioAgents(db, workspaceId, [...orphanedAgentIds])
  })()

  for (const runId of reconciledIds) {
    eventBus.broadcast('run.completed', {
      workspace_id: workspaceId,
      run_id: runId,
      status: 'failed',
      source: 'agent-studio',
    })
  }
}
