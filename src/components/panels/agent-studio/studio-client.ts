import { apiFetch } from '@/lib/api-client'
import type {
  StudioAgent,
  StudioAgentCreate,
  StudioRun,
  StudioRunEvent,
  StudioRuntimeReadiness,
  StudioTeam,
  StudioTeamWrite,
  StudioWorkflow,
  StudioWorkflowWrite,
} from '@/lib/studio/schemas'

export interface StudioSnapshot {
  agents: StudioAgent[]
  teams: StudioTeam[]
  workflows: StudioWorkflow[]
  runs: StudioRun[]
  runtimes: StudioRuntimeReadiness[]
  workspacePath: string
}

export interface StudioRunDetail {
  run: StudioRun
  events: StudioRunEvent[]
}

export async function getStudioSnapshot(): Promise<StudioSnapshot> {
  const [agentData, teamData, workflowData, runData, runtimeData] = await Promise.all([
    apiFetch<{ agents: StudioAgent[] }>('/api/studio/agents'),
    apiFetch<{ teams: StudioTeam[] }>('/api/studio/teams'),
    apiFetch<{ workflows: StudioWorkflow[] }>('/api/studio/workflows'),
    apiFetch<{ runs: StudioRun[] }>('/api/studio/runs'),
    apiFetch<{ runtimes: StudioRuntimeReadiness[]; workspacePath: string }>('/api/studio/runtimes'),
  ])
  return {
    agents: agentData.agents,
    teams: teamData.teams,
    workflows: workflowData.workflows,
    runs: runData.runs,
    runtimes: runtimeData.runtimes,
    workspacePath: runtimeData.workspacePath,
  }
}

export async function createAgent(input: StudioAgentCreate): Promise<StudioAgent> {
  return (await apiFetch<{ agent: StudioAgent }>('/api/studio/agents', {
    method: 'POST',
    body: JSON.stringify(input),
  })).agent
}

export async function removeAgent(agentId: number): Promise<void> {
  await apiFetch(`/api/studio/agents/${agentId}`, { method: 'DELETE' })
}

export async function saveTeam(input: StudioTeamWrite, teamId: number | null): Promise<StudioTeam> {
  const path = teamId === null ? '/api/studio/teams' : `/api/studio/teams/${teamId}`
  return (await apiFetch<{ team: StudioTeam }>(path, {
    method: teamId === null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  })).team
}

export async function removeTeam(teamId: number): Promise<void> {
  await apiFetch(`/api/studio/teams/${teamId}`, { method: 'DELETE' })
}

export async function saveWorkflow(
  input: StudioWorkflowWrite,
  workflowId: number | null,
): Promise<StudioWorkflow> {
  const path = workflowId === null ? '/api/studio/workflows' : `/api/studio/workflows/${workflowId}`
  return (await apiFetch<{ workflow: StudioWorkflow }>(path, {
    method: workflowId === null ? 'POST' : 'PUT',
    body: JSON.stringify(input),
  })).workflow
}

export async function startRun(workflowId: number, input: string): Promise<StudioRun> {
  return (await apiFetch<{ run: StudioRun }>('/api/studio/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowId, input }),
  })).run
}

export async function getRunDetail(runId: number): Promise<StudioRunDetail> {
  return apiFetch<StudioRunDetail>(`/api/studio/runs/${runId}`)
}

export async function actOnRun(runId: number, action: 'approve' | 'cancel'): Promise<void> {
  await apiFetch(`/api/studio/runs/${runId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
}
