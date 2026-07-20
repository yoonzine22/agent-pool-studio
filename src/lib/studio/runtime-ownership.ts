import { randomUUID } from 'node:crypto'

import type Database from 'better-sqlite3'
import { z } from 'zod'

export const STUDIO_RUNTIME_PROCESS_MARKER_PREFIX = 'agent-studio:'

export const studioRuntimeProcessRowSchema = z.object({
  ownership_token: z.string().min(1),
  workspace_id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  node_id: z.string().min(1),
  agent_id: z.number().int().positive(),
  process_pid: z.number().int().positive().nullable(),
  process_pgid: z.number().int().positive().nullable(),
  process_started_at: z.string().min(1).nullable(),
})

export type StudioRuntimeProcessRow = z.infer<typeof studioRuntimeProcessRowSchema>

export type StudioRuntimeProcessIdentity = {
  readonly pid: number
  readonly pgid: number
  readonly startedAt: string | null
}

export interface StudioRuntimeProcessOwnership {
  readonly marker: string
  processStarted(identity: StudioRuntimeProcessIdentity): void
  release(): void
}

export type StudioRuntimeProcessClaim = {
  readonly workspaceId: number
  readonly runId: number
  readonly nodeId: string
  readonly agentId: number
}

export class StudioRuntimeOwnershipError extends Error {
  readonly name = 'StudioRuntimeOwnershipError'

  constructor(readonly runId: number, readonly nodeId: string) {
    super(`Runtime ownership for run ${runId} node ${nodeId} was lost before spawn persistence`)
  }
}

export function studioRuntimeProcessMarker(ownershipToken: string): string {
  return `${STUDIO_RUNTIME_PROCESS_MARKER_PREFIX}${ownershipToken}`
}

export function claimStudioRuntimeProcess(
  db: Database.Database,
  claim: StudioRuntimeProcessClaim,
): StudioRuntimeProcessOwnership {
  const ownershipToken = randomUUID()
  db.prepare(`
    INSERT INTO agent_workflow_runtime_processes (
      ownership_token, workspace_id, run_id, node_id, agent_id,
      process_pid, process_pgid, process_started_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, unixepoch(), unixepoch())
  `).run(
    ownershipToken,
    claim.workspaceId,
    claim.runId,
    claim.nodeId,
    claim.agentId,
  )

  return {
    marker: studioRuntimeProcessMarker(ownershipToken),
    processStarted: (identity) => {
      const result = db.prepare(`
        UPDATE agent_workflow_runtime_processes
        SET process_pid = ?, process_pgid = ?, process_started_at = ?, updated_at = unixepoch()
        WHERE ownership_token = ? AND workspace_id = ? AND run_id = ?
          AND process_pid IS NULL AND process_pgid IS NULL
      `).run(
        identity.pid,
        identity.pgid,
        identity.startedAt,
        ownershipToken,
        claim.workspaceId,
        claim.runId,
      )
      if (result.changes !== 1) {
        throw new StudioRuntimeOwnershipError(claim.runId, claim.nodeId)
      }
    },
    release: () => {
      db.prepare(`
        DELETE FROM agent_workflow_runtime_processes
        WHERE ownership_token = ? AND workspace_id = ? AND run_id = ?
      `).run(ownershipToken, claim.workspaceId, claim.runId)
    },
  }
}
