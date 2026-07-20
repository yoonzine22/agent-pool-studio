import { z } from 'zod'

export const studioRuntimeSchema = z.enum(['codex', 'antigravity'])

export const studioAgentCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  role: z.string().trim().min(1).max(100),
  runtime: studioRuntimeSchema,
  instructions: z.string().trim().max(20_000),
  model: z.string().trim().min(1).max(100).nullable().optional(),
  workspacePath: z.string().trim().min(1).max(1_000),
})

export const studioTeamWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2_000),
    agentIds: z.array(z.number().int().positive()).min(1),
  })
  .refine((team) => new Set(team.agentIds).size === team.agentIds.length, {
    message: 'Each agent can only appear once',
    path: ['agentIds'],
  })

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

const nodeBaseSchema = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  position: positionSchema,
})

export const studioWorkflowNodeSchema = z.discriminatedUnion('kind', [
  nodeBaseSchema.extend({ kind: z.literal('start') }),
  nodeBaseSchema.extend({
    kind: z.literal('agent'),
    agentId: z.number().int().positive(),
    prompt: z.string().trim().min(1).max(20_000),
  }),
  nodeBaseSchema.extend({ kind: z.literal('approval') }),
  nodeBaseSchema.extend({ kind: z.literal('finish') }),
])

export const studioWorkflowEdgeSchema = z.object({
  id: z.string().trim().min(1).max(100),
  source: z.string().trim().min(1).max(100),
  target: z.string().trim().min(1).max(100),
})

export const studioWorkflowWriteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2_000),
  teamId: z.number().int().positive().nullable(),
  nodes: z.array(studioWorkflowNodeSchema).min(2).max(100),
  edges: z.array(studioWorkflowEdgeSchema).min(1).max(250),
})

export const studioAgentSchema = studioAgentCreateSchema.extend({
  id: z.number().int().positive(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const studioTeamSchema = studioTeamWriteSchema.extend({
  id: z.number().int().positive(),
  workspaceId: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const studioWorkflowSchema = studioWorkflowWriteSchema.extend({
  id: z.number().int().positive(),
  workspaceId: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const studioNodeStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
])

export const studioNodeStateSchema = z.object({
  status: studioNodeStatusSchema,
  output: z.string().nullable(),
  error: z.string().nullable(),
})

export const studioNodeStatesSchema = z.record(z.string(), studioNodeStateSchema)

export const studioRunStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
])

export const studioRunActionSchema = z.object({
  action: z.enum(['approve', 'cancel']),
})

export const studioRunCreateSchema = z.object({
  workflowId: z.number().int().positive(),
  input: z.string().trim().max(20_000).default(''),
})

export const studioRunSchema = z.object({
  id: z.number().int().positive(),
  workspaceId: z.number().int().positive(),
  workflowId: z.number().int().positive(),
  workflowName: z.string(),
  status: studioRunStatusSchema,
  input: z.string(),
  nodeStates: studioNodeStatesSchema,
  requestedBy: z.string(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const studioRunEventSchema = z.object({
  id: z.number().int().positive(),
  runId: z.number().int().positive(),
  nodeId: z.string().nullable(),
  eventType: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
})

export const studioRuntimeReadinessSchema = z.object({
  runtime: studioRuntimeSchema,
  available: z.boolean(),
  command: z.string(),
  version: z.string().nullable(),
  detail: z.string(),
})

export type StudioRuntime = z.infer<typeof studioRuntimeSchema>
export type StudioAgentCreate = z.infer<typeof studioAgentCreateSchema>
export type StudioAgent = z.infer<typeof studioAgentSchema>
export type StudioTeamWrite = z.infer<typeof studioTeamWriteSchema>
export type StudioTeam = z.infer<typeof studioTeamSchema>
export type StudioWorkflowNode = z.infer<typeof studioWorkflowNodeSchema>
export type StudioWorkflowEdge = z.infer<typeof studioWorkflowEdgeSchema>
export type StudioWorkflowWrite = z.infer<typeof studioWorkflowWriteSchema>
export type StudioWorkflow = z.infer<typeof studioWorkflowSchema>
export type StudioNodeState = z.infer<typeof studioNodeStateSchema>
export type StudioNodeStates = z.infer<typeof studioNodeStatesSchema>
export type StudioRunStatus = z.infer<typeof studioRunStatusSchema>
export type StudioRun = z.infer<typeof studioRunSchema>
export type StudioRunEvent = z.infer<typeof studioRunEventSchema>
export type StudioRuntimeReadiness = z.infer<typeof studioRuntimeReadinessSchema>
