import { describe, expect, it } from 'vitest'

import {
  studioAgentCreateSchema,
  studioTeamWriteSchema,
  studioWorkflowWriteSchema,
} from '../schemas'

describe('Agent Studio schemas', () => {
  it('accepts a Codex agent with a local workspace', () => {
    const result = studioAgentCreateSchema.parse({
      name: 'Builder',
      role: 'Implementation',
      runtime: 'codex',
      instructions: 'Implement the assigned node and report evidence.',
      workspacePath: '/tmp/project',
    })

    expect(result.runtime).toBe('codex')
    expect(result.workspacePath).toBe('/tmp/project')
  })

  it('accepts an Antigravity agent and rejects unsupported runtimes', () => {
    expect(
      studioAgentCreateSchema.parse({
        name: 'Researcher',
        role: 'Research',
        runtime: 'antigravity',
        instructions: 'Research before execution.',
        workspacePath: '/tmp/project',
      }).runtime,
    ).toBe('antigravity')

    expect(() =>
      studioAgentCreateSchema.parse({
        name: 'Unknown',
        role: 'Unknown',
        runtime: 'shell',
        instructions: '',
        workspacePath: '/tmp/project',
      }),
    ).toThrow()
  })

  it('requires unique agents in a team', () => {
    expect(() =>
      studioTeamWriteSchema.parse({
        name: 'Product team',
        description: '',
        agentIds: [7, 7],
      }),
    ).toThrow('Each agent can only appear once')
  })

  it('parses an executable visual workflow', () => {
    const workflow = studioWorkflowWriteSchema.parse({
      name: 'Ship feature',
      description: 'Build, review, and approve.',
      teamId: 1,
      nodes: [
        { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
        {
          id: 'build',
          kind: 'agent',
          label: 'Build',
          agentId: 2,
          prompt: 'Implement the requested feature.',
          position: { x: 260, y: 0 },
        },
        { id: 'approve', kind: 'approval', label: 'Approve', position: { x: 520, y: 0 } },
        { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 780, y: 0 } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'build' },
        { id: 'e2', source: 'build', target: 'approve' },
        { id: 'e3', source: 'approve', target: 'finish' },
      ],
    })

    expect(workflow.nodes).toHaveLength(4)
    expect(workflow.edges).toHaveLength(3)
  })
})
