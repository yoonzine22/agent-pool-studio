import type Database from 'better-sqlite3'
import { z } from 'zod'

import { validateWorkflowGraph } from './graph'
import {
  studioWorkflowEdgeSchema,
  studioWorkflowNodeSchema,
  type StudioWorkflow,
  type StudioWorkflowWrite,
} from './schemas'
import { parseJson, toIsoDate } from './store-utils'

const workflowRowSchema = z.object({
  id: z.number().int().positive(),
  workspace_id: z.number().int().positive(),
  team_id: z.number().int().positive().nullable(),
  name: z.string(),
  description: z.string(),
  nodes: z.string(),
  edges: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
})

function mapWorkflow(row: unknown): StudioWorkflow {
  const parsed = workflowRowSchema.parse(row)
  return {
    id: parsed.id,
    workspaceId: parsed.workspace_id,
    teamId: parsed.team_id,
    name: parsed.name,
    description: parsed.description,
    nodes: parseJson(parsed.nodes, z.array(studioWorkflowNodeSchema)),
    edges: parseJson(parsed.edges, z.array(studioWorkflowEdgeSchema)),
    createdAt: toIsoDate(parsed.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoDate(parsed.updated_at) ?? new Date(0).toISOString(),
  }
}

export function listStudioWorkflows(
  db: Database.Database,
  workspaceId: number,
): StudioWorkflow[] {
  return db.prepare(`
    SELECT id, workspace_id, team_id, name, description, nodes, edges, created_at, updated_at
    FROM agent_workflows WHERE workspace_id = ? ORDER BY updated_at DESC
  `).all(workspaceId).map(mapWorkflow)
}

export function getStudioWorkflow(
  db: Database.Database,
  workspaceId: number,
  workflowId: number,
): StudioWorkflow | null {
  const row = db.prepare(`
    SELECT id, workspace_id, team_id, name, description, nodes, edges, created_at, updated_at
    FROM agent_workflows WHERE id = ? AND workspace_id = ?
  `).get(workflowId, workspaceId)
  return row ? mapWorkflow(row) : null
}

function assertWorkflowMembers(
  db: Database.Database,
  workspaceId: number,
  input: StudioWorkflowWrite,
): void {
  const agentIds = [...new Set(
    input.nodes.flatMap((node) => node.kind === 'agent' ? [node.agentId] : []),
  )]
  if (agentIds.length === 0) throw new Error('Workflow must contain at least one agent node')

  const placeholders = agentIds.map(() => '?').join(', ')
  const membershipJoin = input.teamId === null
    ? ''
    : 'JOIN agent_team_members tm ON tm.agent_id = a.id AND tm.team_id = ?'
  const params = input.teamId === null
    ? [workspaceId, ...agentIds]
    : [input.teamId, workspaceId, ...agentIds]
  const count = z.object({ count: z.number().int() }).parse(db.prepare(`
    SELECT COUNT(DISTINCT a.id) AS count FROM agents a
    ${membershipJoin}
    WHERE a.workspace_id = ? AND a.id IN (${placeholders})
      AND a.runtime_type IN ('codex', 'antigravity')
  `).get(...params)).count
  if (count !== agentIds.length) throw new Error('Workflow uses an agent outside the selected team')
}

export function saveStudioWorkflow(
  db: Database.Database,
  workspaceId: number,
  input: StudioWorkflowWrite,
  workflowId: number | null,
): StudioWorkflow {
  const validationCandidate: StudioWorkflow = {
    ...input,
    id: workflowId ?? 1,
    workspaceId,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
  const issues = validateWorkflowGraph(validationCandidate)
  if (issues.length > 0) throw new Error(issues.join('; '))
  assertWorkflowMembers(db, workspaceId, input)

  const now = Math.floor(Date.now() / 1_000)
  let savedId = workflowId
  if (workflowId === null) {
    const result = db.prepare(`
      INSERT INTO agent_workflows
        (workspace_id, team_id, name, description, nodes, edges, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      input.teamId,
      input.name,
      input.description,
      JSON.stringify(input.nodes),
      JSON.stringify(input.edges),
      now,
      now,
    )
    savedId = Number(result.lastInsertRowid)
  } else {
    const result = db.prepare(`
      UPDATE agent_workflows
      SET team_id = ?, name = ?, description = ?, nodes = ?, edges = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(
      input.teamId,
      input.name,
      input.description,
      JSON.stringify(input.nodes),
      JSON.stringify(input.edges),
      now,
      workflowId,
      workspaceId,
    )
    if (result.changes === 0) throw new Error('Workflow not found')
  }

  const workflow = getStudioWorkflow(db, workspaceId, savedId ?? 0)
  if (!workflow) throw new Error('Saved workflow could not be loaded')
  return workflow
}

export function deleteStudioWorkflow(
  db: Database.Database,
  workspaceId: number,
  workflowId: number,
): boolean {
  return db.transaction(() => {
    const runReference = z.object({ count: z.number().int() }).parse(db.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_workflow_runs
      WHERE workspace_id = ? AND workflow_id = ?
    `).get(workspaceId, workflowId))
    if (runReference.count > 0) {
      throw new Error(`Cannot delete workflow ${workflowId}: saved runs reference this workflow`)
    }

    return db.prepare('DELETE FROM agent_workflows WHERE id = ? AND workspace_id = ?')
      .run(workflowId, workspaceId).changes > 0
  })()
}
