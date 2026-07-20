import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import type { StudioAgent, StudioRun, StudioWorkflow } from '@/lib/studio/schemas'

const mocks = vi.hoisted(() => {
  const db = { prepare: vi.fn() }
  return {
    db,
    requireRole: vi.fn(),
    getDatabase: vi.fn(() => db),
    mutationLimiter: vi.fn(() => null),
    createStudioAgent: vi.fn(),
    createStudioRun: vi.fn(),
    getStudioRun: vi.fn(),
    getStudioWorkflow: vi.fn(),
    queueStudioRun: vi.fn(),
    approveStudioRun: vi.fn(),
    cancelStudioRun: vi.fn(),
  }
})

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mocks.mutationLimiter }))
vi.mock('@/lib/studio/agent-store', () => ({ createStudioAgent: mocks.createStudioAgent }))
vi.mock('@/lib/studio/engine', () => ({
  approveStudioRun: mocks.approveStudioRun,
  cancelStudioRun: mocks.cancelStudioRun,
  queueStudioRun: mocks.queueStudioRun,
}))
vi.mock('@/lib/studio/run-store', () => ({
  createStudioRun: mocks.createStudioRun,
  getStudioRun: mocks.getStudioRun,
}))
vi.mock('@/lib/studio/workflow-store', () => ({ getStudioWorkflow: mocks.getStudioWorkflow }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const agent = {
  id: 17,
  name: 'Builder',
  role: 'Implementer',
  runtime: 'codex',
  instructions: 'Build the requested change.',
  model: null,
  workspacePath: '/workspace/primary',
  status: 'offline',
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
} satisfies StudioAgent

const workflow = {
  id: 31,
  workspaceId: 7,
  teamId: null,
  name: 'Release workflow',
  description: 'A test workflow',
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', position: { x: 0, y: 0 } },
    { id: 'agent', kind: 'agent', label: 'Build', agentId: 17, prompt: 'Build it', position: { x: 1, y: 0 } },
    { id: 'finish', kind: 'finish', label: 'Finish', position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'edge-start-agent', source: 'start', target: 'agent' },
    { id: 'edge-agent-finish', source: 'agent', target: 'finish' },
  ],
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
} satisfies StudioWorkflow

const run = {
  id: 42,
  workspaceId: 7,
  workflowId: 31,
  workflowName: workflow.name,
  status: 'pending',
  input: 'ship it',
  nodeStates: {
    start: { status: 'pending', output: null, error: null },
    agent: { status: 'pending', output: null, error: null },
    finish: { status: 'pending', output: null, error: null },
  },
  requestedBy: 'operator',
  error: null,
  startedAt: null,
  completedAt: null,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
} satisfies StudioRun

type TestRequestInit = {
  readonly method?: string
  readonly headers?: HeadersInit
  readonly body?: BodyInit | null
}

function request(path: string, init: TestRequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, init)
}

function authenticated(workspaceId: number, role: string = 'operator') {
  return {
    user: {
      id: 1,
      username: 'operator',
      role,
      workspace_id: workspaceId,
      tenant_id: 1,
    },
  }
}

function configureAuthenticatedRequests(): void {
  mocks.requireRole.mockImplementation((incoming: Request) => {
    const workspaceId = Number(incoming.headers.get('x-workspace-id') ?? '7')
    const role = incoming.method === 'GET' ? 'viewer' : 'operator'
    return authenticated(workspaceId, role)
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.mutationLimiter.mockReturnValue(null)
})

describe('Agent Studio API routes', () => {
  it('rejects an unauthenticated Studio mutation before parsing or storing', async () => {
    // Given
    mocks.requireRole.mockReturnValue({ error: 'Authentication required', status: 401 })
    const { POST } = await import('@/app/api/studio/agents/route')

    // When
    const response = await POST(request('/api/studio/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: agent.name,
        role: agent.role,
        runtime: agent.runtime,
        instructions: agent.instructions,
        workspacePath: agent.workspacePath,
      }),
    }))

    // Then
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required' })
    expect(mocks.createStudioAgent).not.toHaveBeenCalled()
  })

  it('rejects an invalid authenticated agent body before reaching the workspace store', async () => {
    // Given
    configureAuthenticatedRequests()
    const { POST } = await import('@/app/api/studio/agents/route')

    // When
    const response = await POST(request('/api/studio/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': '7' },
      body: JSON.stringify({ name: '', runtime: 'codex' }),
    }))

    // Then
    expect(response.status).toBe(400)
    expect(mocks.createStudioAgent).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('creates an authenticated agent with the caller workspace and returns the stored agent', async () => {
    // Given
    configureAuthenticatedRequests()
    mocks.createStudioAgent.mockReturnValue(agent)
    const { POST } = await import('@/app/api/studio/agents/route')
    const input = {
      name: agent.name,
      role: agent.role,
      runtime: agent.runtime,
      instructions: agent.instructions,
      workspacePath: agent.workspacePath,
    }

    // When
    const response = await POST(request('/api/studio/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': '19' },
      body: JSON.stringify(input),
    }))

    // Then
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ agent })
    expect(mocks.createStudioAgent).toHaveBeenCalledWith(mocks.db, 19, input)
  })

  it('validates run input and queues the created run in the caller workspace', async () => {
    // Given
    configureAuthenticatedRequests()
    mocks.getStudioWorkflow.mockReturnValue(workflow)
    mocks.createStudioRun.mockReturnValue(run)
    const { POST } = await import('@/app/api/studio/runs/route')

    // When
    const response = await POST(request('/api/studio/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': '7' },
      body: JSON.stringify({ workflowId: workflow.id, input: run.input }),
    }))

    // Then
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ run })
    expect(mocks.getStudioWorkflow).toHaveBeenCalledWith(mocks.db, 7, workflow.id)
    expect(mocks.createStudioRun).toHaveBeenCalledWith(mocks.db, 7, workflow, run.input, 'operator')
    expect(mocks.queueStudioRun).toHaveBeenCalledWith(run.id, 7)
  })

  it('rejects a run with an invalid body before workflow lookup or queueing', async () => {
    // Given
    configureAuthenticatedRequests()
    const { POST } = await import('@/app/api/studio/runs/route')

    // When
    const response = await POST(request('/api/studio/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': '7' },
      body: JSON.stringify({ workflowId: '31' }),
    }))

    // Then
    expect(response.status).toBe(400)
    expect(mocks.getStudioWorkflow).not.toHaveBeenCalled()
    expect(mocks.createStudioRun).not.toHaveBeenCalled()
    expect(mocks.queueStudioRun).not.toHaveBeenCalled()
  })

  it('returns a conflict when cancellation loses the run CAS transition', async () => {
    // Given
    configureAuthenticatedRequests()
    mocks.getStudioRun.mockReturnValue(run)
    mocks.cancelStudioRun.mockReturnValue(false)
    const { POST } = await import('@/app/api/studio/runs/[id]/action/route')

    // When
    const response = await POST(request('/api/studio/runs/42/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': '7' },
      body: JSON.stringify({ action: 'cancel' }),
    }), { params: Promise.resolve({ id: String(run.id) }) })

    // Then
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: expect.stringMatching(/\S+/) })
    expect(mocks.getStudioRun).toHaveBeenCalledWith(mocks.db, 7, run.id)
    expect(mocks.cancelStudioRun).toHaveBeenCalledWith(run)
  })
})
