import type {
  StudioAgent,
  StudioTeam,
  StudioWorkflowEdge,
  StudioWorkflowNode,
} from '@/lib/studio/schemas'

export function createStarterGraph(
  team: StudioTeam,
  agents: StudioAgent[],
): { nodes: StudioWorkflowNode[]; edges: StudioWorkflowEdge[] } {
  const members = team.agentIds
    .map((agentId) => agents.find((agent) => agent.id === agentId))
    .filter((agent): agent is StudioAgent => Boolean(agent))
  const midpoint = ((members.length - 1) * 104) / 2
  const start: StudioWorkflowNode = {
    id: 'start',
    kind: 'start',
    label: 'Start',
    position: { x: 24, y: midpoint },
  }
  const agentNodes: StudioWorkflowNode[] = members.map((agent, index) => ({
    id: `agent-${agent.id}`,
    kind: 'agent',
    label: agent.role,
    agentId: agent.id,
    prompt: `Act as ${agent.role}. Complete your part of the run input and report evidence.`,
    position: { x: 224, y: index * 104 },
  }))
  const approval: StudioWorkflowNode = {
    id: 'approval',
    kind: 'approval',
    label: 'Human approval',
    position: { x: 424, y: midpoint },
  }
  const finish: StudioWorkflowNode = {
    id: 'finish',
    kind: 'finish',
    label: 'Complete',
    position: { x: 624, y: midpoint },
  }
  return {
    nodes: [start, ...agentNodes, approval, finish],
    edges: [
      ...agentNodes.map((node) => ({ id: `start-${node.id}`, source: start.id, target: node.id })),
      ...agentNodes.map((node) => ({ id: `${node.id}-approval`, source: node.id, target: approval.id })),
      { id: 'approval-finish', source: approval.id, target: finish.id },
    ],
  }
}
