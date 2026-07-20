import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StudioRun, StudioRunStatus } from '../schemas'

const dbMocks = vi.hoisted(() => ({
  prepare: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => ({ prepare: dbMocks.prepare }),
}))

import { cancelStudioRun } from '../engine'

const terminalStatuses = ['completed', 'failed', 'cancelled'] as const satisfies readonly StudioRunStatus[]

beforeEach(() => {
  dbMocks.prepare.mockClear()
})

describe('Agent Studio run lifecycle', () => {
  it.each(terminalStatuses)('preserves a %s run when cancellation is requested', (status) => {
    // Given
    const run: StudioRun = {
      id: 12,
      workspaceId: 3,
      workflowId: 4,
      workflowName: 'Finished workflow',
      status,
      input: '',
      nodeStates: {
        finish: { status: 'completed', output: 'Finished', error: null },
      },
      requestedBy: 'operator',
      error: status === 'failed' ? 'Original failure' : null,
      startedAt: '2026-07-20T00:00:00.000Z',
      completedAt: '2026-07-20T00:01:00.000Z',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:01:00.000Z',
    }

    // When
    const cancelled = cancelStudioRun(run)

    // Then
    expect(cancelled).toBe(false)
    expect(dbMocks.prepare).not.toHaveBeenCalled()
  })
})
