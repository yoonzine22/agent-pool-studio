import type Database from 'better-sqlite3'
import { z } from 'zod'

import {
  studioWorkflowNodeSchema,
  studioWorkflowSchema,
  type StudioAgent,
  type StudioAgentCreate,
  type StudioWorkflowNode,
} from './schemas'
import { getStudioWorkspaceRoot, resolveStudioWorkspacePath } from './runtime-security'
import { parseJson, toIsoDate } from './store-utils'

const agentRowSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  role: z.string(),
  status: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  config: z.string().nullable(),
  workspace_path: z.string().nullable(),
  runtime_type: z.enum(['codex', 'antigravity']),
})

const storedConfigSchema = z.object({
  instructions: z.string().catch(''),
  model: z.string().nullable().catch(null),
})

const workflowReferenceRowSchema = z.object({
  id: z.number().int().positive(),
  nodes: z.string(),
})

const activeRunReferenceRowSchema = z.object({
  id: z.number().int().positive(),
  workflow_snapshot: z.string(),
})

function mapAgent(row: unknown, workspaceId: number): StudioAgent {
  const parsed = agentRowSchema.parse(row)
  const config = storedConfigSchema.catch({ instructions: '', model: null }).parse(
    parsed.config ? JSON.parse(parsed.config) : {},
  )

  return {
    id: parsed.id,
    name: parsed.name,
    role: parsed.role,
    runtime: parsed.runtime_type,
    instructions: config.instructions,
    model: config.model,
    workspacePath: parsed.workspace_path ?? getStudioWorkspaceRoot(workspaceId),
    status: parsed.status,
    createdAt: toIsoDate(parsed.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoDate(parsed.updated_at) ?? new Date(0).toISOString(),
  }
}

export function listStudioAgents(db: Database.Database, workspaceId: number): StudioAgent[] {
  const rows = db.prepare(`
    SELECT id, name, role, status, created_at, updated_at, config, workspace_path, runtime_type
    FROM agents
    WHERE workspace_id = ? AND hidden = 0 AND runtime_type IN ('codex', 'antigravity')
    ORDER BY created_at DESC
  `).all(workspaceId)
  return rows.map((row) => mapAgent(row, workspaceId))
}

export function getStudioAgent(
  db: Database.Database,
  workspaceId: number,
  agentId: number,
): StudioAgent | null {
  const row = db.prepare(`
    SELECT id, name, role, status, created_at, updated_at, config, workspace_path, runtime_type
    FROM agents
    WHERE id = ? AND workspace_id = ? AND runtime_type IN ('codex', 'antigravity')
  `).get(agentId, workspaceId)
  return row ? mapAgent(row, workspaceId) : null
}

export function createStudioAgent(
  db: Database.Database,
  workspaceId: number,
  input: StudioAgentCreate,
): StudioAgent {
  const workspacePath = resolveStudioWorkspacePath(input.workspacePath, workspaceId)
  const now = Math.floor(Date.now() / 1_000)
  const result = db.prepare(`
    INSERT INTO agents (
      name, role, status, created_at, updated_at, config, workspace_id, workspace_path, runtime_type, source
    ) VALUES (?, ?, 'offline', ?, ?, ?, ?, ?, ?, 'agent-studio')
  `).run(
    input.name,
    input.role,
    now,
    now,
    JSON.stringify({ instructions: input.instructions, model: input.model ?? null }),
    workspaceId,
    workspacePath,
    input.runtime,
  )
  const agent = getStudioAgent(db, workspaceId, Number(result.lastInsertRowid))
  if (!agent) throw new Error('Created agent could not be loaded')
  return agent
}

function parseStoredWorkflowNodes(row: z.infer<typeof workflowReferenceRowSchema>): StudioWorkflowNode[] {
  try {
    return parseJson(row.nodes, z.array(studioWorkflowNodeSchema))
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new Error(
        `Cannot delete agent: saved workflow ${row.id} contains invalid graph data`,
        { cause: error },
      )
    }
    throw error
  }
}

function assertAgentIsNotReferenced(
  db: Database.Database,
  workspaceId: number,
  agentId: number,
): void {
  const workflows = z.array(workflowReferenceRowSchema).parse(db.prepare(`
    SELECT id, nodes
    FROM agent_workflows
    WHERE workspace_id = ?
  `).all(workspaceId))
  for (const workflow of workflows) {
    const nodes = parseStoredWorkflowNodes(workflow)
    if (nodes.some((node) => node.kind === 'agent' && node.agentId === agentId)) {
      throw new Error(`Cannot delete agent ${agentId}: saved workflow ${workflow.id} references this agent`)
    }
  }

  const activeRuns = z.array(activeRunReferenceRowSchema).parse(db.prepare(`
    SELECT id, workflow_snapshot
    FROM agent_workflow_runs
    WHERE workspace_id = ? AND status IN ('pending', 'running', 'waiting_approval')
  `).all(workspaceId))
  for (const run of activeRuns) {
    const snapshot = parseJson(run.workflow_snapshot, studioWorkflowSchema)
    if (snapshot.nodes.some((node) => node.kind === 'agent' && node.agentId === agentId)) {
      throw new Error(`Cannot delete agent ${agentId}: active run ${run.id} references this agent`)
    }
  }

  const teamWorkflow = z.object({ id: z.number().int().positive() }).optional().parse(db.prepare(`
    SELECT aw.id
    FROM agent_workflows aw
    JOIN agent_team_members tm ON tm.team_id = aw.team_id
    WHERE aw.workspace_id = ? AND tm.agent_id = ?
    LIMIT 1
  `).get(workspaceId, agentId))
  if (teamWorkflow) {
    throw new Error(`Cannot delete agent ${agentId}: saved workflow ${teamWorkflow.id} uses its team`)
  }
}

export function deleteStudioAgent(
  db: Database.Database,
  workspaceId: number,
  agentId: number,
): boolean {
  return db.transaction(() => {
    assertAgentIsNotReferenced(db, workspaceId, agentId)
    const result = db.prepare(`
      DELETE FROM agents
      WHERE id = ? AND workspace_id = ? AND runtime_type IN ('codex', 'antigravity')
    `).run(agentId, workspaceId)
    return result.changes > 0
  })()
}
