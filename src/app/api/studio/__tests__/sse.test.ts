import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { z } from 'zod'

import { eventBus } from '@/lib/event-bus'
import type { StudioAgent } from '@/lib/studio/schemas'

const mocks = vi.hoisted(() => {
  const db = { prepare: vi.fn() }
  return {
    db,
    requireRole: vi.fn(),
    getDatabase: vi.fn(() => db),
    mutationLimiter: vi.fn(() => null),
    createStudioAgent: vi.fn(),
  }
})

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mocks.mutationLimiter }))
vi.mock('@/lib/studio/agent-store', () => ({ createStudioAgent: mocks.createStudioAgent }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const sseEnvelopeSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  timestamp: z.number(),
})

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

type TestRequestInit = {
  readonly method?: string
  readonly headers?: HeadersInit
  readonly body?: BodyInit | null
}

function request(path: string, init: TestRequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, init)
}

function configureAuthenticatedRequests(): void {
  mocks.requireRole.mockImplementation((incoming: Request) => ({
    user: {
      id: 1,
      username: 'operator',
      role: incoming.method === 'GET' ? 'viewer' : 'operator',
      workspace_id: Number(incoming.headers.get('x-workspace-id') ?? '7'),
      tenant_id: 1,
    },
  }))
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const result = await reader.read()
  if (result.done || !result.value) throw new Error('SSE stream closed unexpectedly')
  return new TextDecoder().decode(result.value)
}

function parseSseChunk(chunk: string) {
  const line = chunk.split('\n').find((candidate) => candidate.startsWith('data: '))
  if (!line) throw new Error(`SSE chunk did not contain a data line: ${chunk}`)
  return sseEnvelopeSchema.parse(JSON.parse(line.slice('data: '.length)))
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.mutationLimiter.mockReturnValue(null)
})

afterEach(() => {
  eventBus.removeAllListeners('server-event')
})

describe('Agent Studio mutation SSE delivery', () => {
  it('delivers agent.created only to the authenticated mutation workspace', async () => {
    // Given
    configureAuthenticatedRequests()
    mocks.createStudioAgent.mockReturnValue(agent)
    const { GET: getEvents } = await import('@/app/api/events/route')
    const { POST: createAgent } = await import('@/app/api/studio/agents/route')
    const primary = await getEvents(request('/api/events', {
      headers: { 'x-workspace-id': '19' },
    }))
    const other = await getEvents(request('/api/events', {
      headers: { 'x-workspace-id': '23' },
    }))
    const primaryBody = primary.body
    const otherBody = other.body
    if (!primaryBody || !otherBody) throw new Error('SSE route did not return response bodies')
    const primaryReader = primaryBody.getReader()
    const otherReader = otherBody.getReader()
    expect(parseSseChunk(await readStreamChunk(primaryReader))).toMatchObject({ type: 'connected' })
    expect(parseSseChunk(await readStreamChunk(otherReader))).toMatchObject({ type: 'connected' })

    // When
    const response = await createAgent(request('/api/studio/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': '19' },
      body: JSON.stringify({
        name: agent.name,
        role: agent.role,
        runtime: agent.runtime,
        instructions: agent.instructions,
        workspacePath: agent.workspacePath,
      }),
    }))
    const delivered = parseSseChunk(await readStreamChunk(primaryReader))
    const otherWorkspaceRead = await Promise.race([
      otherReader.read().then(() => 'delivered' as const),
      Promise.resolve('not-delivered' as const),
    ])

    // Then
    expect(response.status).toBe(201)
    expect(delivered.type).toBe('agent.created')
    expect(delivered.data).toEqual(expect.objectContaining({
      id: agent.id,
      name: agent.name,
      workspace_id: 19,
    }))
    expect(otherWorkspaceRead).toBe('not-delivered')
    await primaryReader.cancel()
    await otherReader.cancel()
  })
})
