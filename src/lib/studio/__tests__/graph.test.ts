import { describe, expect, it } from 'vitest'

import { createInitialNodeStates, findReadyNodes, validateWorkflowGraph } from '../graph'
import type { StudioWorkflow } from '../schemas'

const workflow: StudioWorkflow = {
  id: 1,
  workspaceId: 1,
  name: 'Parallel delivery',
  description: '',
  teamId: 1,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
    {
      id: 'build',
      kind: 'agent',
      label: 'Build',
      agentId: 10,
      prompt: 'Build it.',
      position: { x: 240, y: -80 },
    },
    {
      id: 'review',
      kind: 'agent',
      label: 'Review',
      agentId: 11,
      prompt: 'Review it.',
      position: { x: 240, y: 80 },
    },
    { id: 'approval', kind: 'approval', label: 'Approve', position: { x: 500, y: 0 } },
    { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 740, y: 0 } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'build' },
    { id: 'e2', source: 'start', target: 'review' },
    { id: 'e3', source: 'build', target: 'approval' },
    { id: 'e4', source: 'review', target: 'approval' },
    { id: 'e5', source: 'approval', target: 'finish' },
  ],
}

describe('Agent Studio graph scheduling', () => {
  it('finds parallel nodes after their predecessor completes', () => {
    const states = createInitialNodeStates(workflow.nodes)
    states.start = { status: 'completed', output: null, error: null }

    expect(findReadyNodes(workflow, states).map((node) => node.id)).toEqual(['build', 'review'])
  })

  it('waits for every inbound branch before approval', () => {
    const states = createInitialNodeStates(workflow.nodes)
    states.start = { status: 'completed', output: null, error: null }
    states.build = { status: 'completed', output: 'built', error: null }

    expect(findReadyNodes(workflow, states).map((node) => node.id)).toEqual(['review'])

    states.review = { status: 'completed', output: 'reviewed', error: null }
    expect(findReadyNodes(workflow, states).map((node) => node.id)).toEqual(['approval'])
  })

  it('rejects cycles and dangling edges before execution', () => {
    const invalid: StudioWorkflow = {
      ...workflow,
      edges: [
        ...workflow.edges,
        { id: 'cycle', source: 'approval', target: 'build' },
        { id: 'missing', source: 'ghost', target: 'finish' },
      ],
    }

    expect(validateWorkflowGraph(invalid)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('cycle'),
        expect.stringContaining('ghost'),
      ]),
    )
  })
})
