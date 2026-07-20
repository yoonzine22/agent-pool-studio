import type {
  StudioNodeStates,
  StudioWorkflow,
  StudioWorkflowNode,
} from './schemas'

export function createInitialNodeStates(nodes: StudioWorkflowNode[]): StudioNodeStates {
  return Object.fromEntries(
    nodes.map((node) => [
      node.id,
      { status: 'pending' as const, output: null, error: null },
    ]),
  )
}

export function findReadyNodes(
  workflow: StudioWorkflow,
  states: StudioNodeStates,
): StudioWorkflowNode[] {
  return workflow.nodes.filter((node) => {
    if (states[node.id]?.status !== 'pending') return false

    const predecessors = workflow.edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => edge.source)

    if (predecessors.length === 0) return node.kind === 'start'
    return predecessors.every((id) => states[id]?.status === 'completed')
  })
}

function findDanglingEdges(workflow: StudioWorkflow): string[] {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id))
  return workflow.edges.flatMap((edge) => {
    const missing = [edge.source, edge.target].filter((id) => !nodeIds.has(id))
    return missing.map((id) => `Edge ${edge.id} references missing node ${id}`)
  })
}

function findDuplicateIds(ids: string[], label: string): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  return [...duplicates].map((id) => `Workflow contains duplicate ${label} id ${id}`)
}

function createAdjacency(workflow: StudioWorkflow): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()
  for (const node of workflow.nodes) adjacency.set(node.id, [])
  for (const edge of workflow.edges) {
    const targets = adjacency.get(edge.source)
    if (targets) targets.push(edge.target)
  }
  return adjacency
}

function findReachable(startId: string, adjacency: Map<string, string[]>): Set<string> {
  const reachable = new Set<string>()
  const pending = [startId]
  while (pending.length > 0) {
    const id = pending.pop()
    if (!id || reachable.has(id)) continue
    reachable.add(id)
    pending.push(...(adjacency.get(id) ?? []))
  }
  return reachable
}

function findNodesThatCanReachFinish(workflow: StudioWorkflow, finishId: string): Set<string> {
  const reverseAdjacency = new Map<string, string[]>()
  for (const node of workflow.nodes) reverseAdjacency.set(node.id, [])
  for (const edge of workflow.edges) {
    const predecessors = reverseAdjacency.get(edge.target)
    if (predecessors) predecessors.push(edge.source)
  }
  return findReachable(finishId, reverseAdjacency)
}

function graphHasCycle(workflow: StudioWorkflow): boolean {
  const adjacency = new Map<string, string[]>()
  const indegree = new Map(workflow.nodes.map((node) => [node.id, 0]))

  for (const edge of workflow.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target])
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id)
  let visited = 0

  while (queue.length > 0) {
    const id = queue.shift()
    if (!id) continue
    visited += 1
    for (const target of adjacency.get(id) ?? []) {
      const nextDegree = (indegree.get(target) ?? 1) - 1
      indegree.set(target, nextDegree)
      if (nextDegree === 0) queue.push(target)
    }
  }

  return visited !== workflow.nodes.length
}

export function validateWorkflowGraph(workflow: StudioWorkflow): string[] {
  const issues = findDanglingEdges(workflow)
  issues.push(...findDuplicateIds(workflow.nodes.map((node) => node.id), 'node'))
  issues.push(...findDuplicateIds(workflow.edges.map((edge) => edge.id), 'edge'))
  const startCount = workflow.nodes.filter((node) => node.kind === 'start').length
  const finishCount = workflow.nodes.filter((node) => node.kind === 'finish').length

  if (startCount !== 1) issues.push('Workflow must contain exactly one start node')
  if (finishCount !== 1) issues.push('Workflow must contain exactly one finish node')

  const hasUniqueNodeIds = new Set(workflow.nodes.map((node) => node.id)).size === workflow.nodes.length
  if (hasUniqueNodeIds && graphHasCycle(workflow)) issues.push('Workflow graph contains a cycle')

  if (hasUniqueNodeIds && startCount === 1 && finishCount === 1) {
    const start = workflow.nodes.find((node) => node.kind === 'start')
    const finish = workflow.nodes.find((node) => node.kind === 'finish')
    if (start && finish) {
      const adjacency = createAdjacency(workflow)
      const reachable = findReachable(start.id, adjacency)
      for (const node of workflow.nodes) {
        if (!reachable.has(node.id)) {
          issues.push(`Workflow node ${node.id} is unreachable from the start node`)
        }
      }
      const canReachFinish = findNodesThatCanReachFinish(workflow, finish.id)
      for (const node of workflow.nodes) {
        if (!canReachFinish.has(node.id)) {
          issues.push(`Workflow node ${node.id} cannot reach the finish node`)
        }
      }
      if (!reachable.has(finish.id)) {
        issues.push('Workflow has no path from the start node to the finish node')
      }
    }
  }

  return issues
}
