import { describe, expect, it } from 'vitest'

import { validateWorkflowGraph } from '../graph'
import type { StudioWorkflow } from '../schemas'

const baseWorkflow: StudioWorkflow = {
  id: 1,
  workspaceId: 1,
  name: 'Integrity checks',
  description: '',
  teamId: null,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
    {
      id: 'agent',
      kind: 'agent',
      label: 'Agent',
      agentId: 10,
      prompt: 'Do the work.',
      position: { x: 120, y: 0 },
    },
    { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 240, y: 0 } },
  ],
  edges: [
    { id: 'start-agent', source: 'start', target: 'agent' },
    { id: 'agent-finish', source: 'agent', target: 'finish' },
  ],
}

describe('Agent Studio graph integrity', () => {
  it('rejects duplicate node identifiers before execution', () => {
    // Given
    const duplicateNodeWorkflow: StudioWorkflow = {
      ...baseWorkflow,
      nodes: [baseWorkflow.nodes[0], baseWorkflow.nodes[1], {
        id: 'agent',
        kind: 'approval',
        label: 'Duplicate',
        position: { x: 180, y: 0 },
      }, baseWorkflow.nodes[2]],
    }

    // When
    const issues = validateWorkflowGraph(duplicateNodeWorkflow)

    // Then
    expect(issues).toContain('Workflow contains duplicate node id agent')
  })

  it('rejects duplicate edge identifiers before execution', () => {
    // Given
    const duplicateEdgeWorkflow: StudioWorkflow = {
      ...baseWorkflow,
      edges: [
        ...baseWorkflow.edges,
        { id: 'agent-finish', source: 'start', target: 'finish' },
      ],
    }

    // When
    const issues = validateWorkflowGraph(duplicateEdgeWorkflow)

    // Then
    expect(issues).toContain('Workflow contains duplicate edge id agent-finish')
  })

  it('rejects a graph where start cannot reach finish', () => {
    // Given
    const missingFinishPathWorkflow: StudioWorkflow = {
      ...baseWorkflow,
      edges: [{ id: 'start-agent', source: 'start', target: 'agent' }],
    }

    // When
    const issues = validateWorkflowGraph(missingFinishPathWorkflow)

    // Then
    expect(issues).toContain('Workflow node finish is unreachable from the start node')
    expect(issues).toContain('Workflow has no path from the start node to the finish node')
  })

  it('rejects disconnected nodes even when the main path is valid', () => {
    // Given
    const disconnectedWorkflow: StudioWorkflow = {
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        { id: 'orphan', kind: 'approval', label: 'Orphan', position: { x: 120, y: 120 } },
      ],
    }

    // When
    const issues = validateWorkflowGraph(disconnectedWorkflow)

    // Then
    expect(issues).toContain('Workflow node orphan is unreachable from the start node')
    expect(issues).toContain('Workflow node orphan cannot reach the finish node')
  })
})
