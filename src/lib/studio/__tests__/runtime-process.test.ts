import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtime-security', () => ({
  buildStudioRuntimeEnv: () => ({}),
  resolveStudioWorkspacePath: (workspacePath: string, _workspaceId: number) => workspacePath,
}))

import {
  runStudioRuntime,
  STUDIO_RUNTIME_TERMINATION_GRACE_MS,
  STUDIO_RUNTIME_TIMEOUT_MS,
  type RuntimeChunk,
  type StudioRuntimeProcess,
  type StudioRuntimeProcessBoundary,
  type StudioRuntimeProcessSpawn,
} from '../runtime-process'
import type { StudioRuntimeProcessOwnership } from '../runtime-ownership'
import type { StudioRuntime } from '../schemas'

class FakeRuntimeProcess implements StudioRuntimeProcess {
  readonly pid = 731
  readonly directSignals: NodeJS.Signals[] = []
  readonly stdin: Array<string | null> = []
  stdinError: Error | null = null
  private stdoutListener: ((chunk: Buffer) => void) | null = null
  private runtimeCloseListener: ((code: number) => void) | null = null
  private closeListener: ((code: number | null) => void) | null = null
  private errorListener: ((error: Error) => void) | null = null

  onStdout(listener: (chunk: Buffer) => void): void {
    this.stdoutListener = listener
  }

  onStderr(_listener: (chunk: Buffer) => void): void {}

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener
  }

  onRuntimeClose(listener: (code: number) => void): void {
    this.runtimeCloseListener = listener
  }

  onClose(listener: (code: number | null) => void): void {
    this.closeListener = listener
  }

  endStdin(input: string | null): void {
    if (this.stdinError) throw this.stdinError
    this.stdin.push(input)
  }

  kill(signal: NodeJS.Signals): boolean {
    this.directSignals.push(signal)
    return true
  }

  emitStdout(text: string): void {
    this.stdoutListener?.(Buffer.from(text))
  }

  emitClose(code: number | null): void {
    this.closeListener?.(code)
  }

  emitRuntimeClose(code: number): void {
    this.runtimeCloseListener?.(code)
  }

  emitError(error: Error): void {
    this.errorListener?.(error)
  }
}

class FakeProcessBoundary implements StudioRuntimeProcessBoundary {
  readonly child = new FakeRuntimeProcess()
  readonly spawns: StudioRuntimeProcessSpawn[] = []
  readonly treeSignals: NodeJS.Signals[] = []
  treeAlive = true

  spawn(specification: StudioRuntimeProcessSpawn): StudioRuntimeProcess {
    this.spawns.push(specification)
    return this.child
  }

  terminateTree(_child: StudioRuntimeProcess, signal: NodeJS.Signals): void {
    this.treeSignals.push(signal)
  }

  isTreeAlive(_child: StudioRuntimeProcess): boolean {
    return this.treeAlive
  }

  identify(_child: StudioRuntimeProcess) {
    return {
      pid: this.child.pid,
      pgid: this.child.pid,
      startedAt: 'Tue Jul 21 01:00:00 2026',
    }
  }
}

function runtimeRequest(runtime: StudioRuntime) {
  return {
    runtime,
    prompt: 'Perform the deterministic test assignment.',
    workspaceId: 7,
    workspacePath: process.cwd(),
    model: null,
  }
}

function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new TypeError('Expected runtime execution to reject'),
    (error: unknown) => error,
  )
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Agent Studio runtime process cleanup', () => {
  it('persists the detached PID and PGID under the preclaimed argv marker', async () => {
    // Given
    const boundary = new FakeProcessBoundary()
    const identities: Parameters<StudioRuntimeProcessOwnership['processStarted']>[0][] = []
    const ownership: StudioRuntimeProcessOwnership = {
      marker: 'agent-studio:claim-token',
      processStarted: (identity) => identities.push(identity),
      release: vi.fn(),
    }
    const runtime = runStudioRuntime(runtimeRequest('codex'), {
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      processBoundary: boundary,
      ownership,
    })

    // When
    boundary.treeAlive = false
    boundary.child.emitClose(0)

    // Then
    await expect(runtime).resolves.toBe('')
    expect(boundary.spawns[0]?.argv0).toBe(ownership.marker)
    expect(identities).toEqual([{
      pid: 731,
      pgid: 731,
      startedAt: 'Tue Jul 21 01:00:00 2026',
    }])
  })

  it('preserves Antigravity stdout whitespace across adjacent output chunks', async () => {
    // Given
    const boundary = new FakeProcessBoundary()
    const chunks: RuntimeChunk[] = []
    const runtime = runStudioRuntime(runtimeRequest('antigravity'), {
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
      processBoundary: boundary,
    })

    // When
    boundary.child.emitStdout('hello ')
    boundary.child.emitStdout('world')
    boundary.child.emitStdout(' \n ')
    boundary.treeAlive = false
    boundary.child.emitClose(0)

    // Then
    await expect(runtime).resolves.toBe('hello world')
    expect(chunks).toEqual([
      { kind: 'output', text: 'hello ' },
      { kind: 'output', text: 'world' },
    ])
  })

  it('reclaims lingering descendants before resolving a successful invocation', async () => {
    // Given
    const boundary = new FakeProcessBoundary()
    const runtime = runStudioRuntime(runtimeRequest('codex'), {
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      processBoundary: boundary,
    })
    let completed = false
    void runtime.then(() => {
      completed = true
    })

    // When
    boundary.child.emitRuntimeClose(0)
    await Promise.resolve()

    // Then
    expect(completed).toBe(false)
    expect(boundary.treeSignals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(STUDIO_RUNTIME_TERMINATION_GRACE_MS)
    expect(boundary.treeSignals).toEqual(['SIGTERM', 'SIGKILL'])
    boundary.treeAlive = false
    await vi.runOnlyPendingTimersAsync()
    await expect(runtime).resolves.toBe('')
  })

  it('keeps TERM-to-KILL escalation armed after the leader closes while a descendant remains', async () => {
    // Given
    const boundary = new FakeProcessBoundary()
    const controller = new AbortController()
    const runtime = runStudioRuntime(runtimeRequest('codex'), {
      signal: controller.signal,
      onChunk: vi.fn(),
      processBoundary: boundary,
    })
    const rejection = captureRejection(runtime)
    let acknowledged = false
    void rejection.then(() => {
      acknowledged = true
    })

    // When
    controller.abort()
    boundary.child.emitClose(null)
    await Promise.resolve()

    // Then
    expect(acknowledged).toBe(false)
    await vi.advanceTimersByTimeAsync(STUDIO_RUNTIME_TERMINATION_GRACE_MS)
    expect(boundary.treeSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(acknowledged).toBe(false)

    boundary.treeAlive = false
    await vi.runOnlyPendingTimersAsync()
    expect(await rejection).toMatchObject({ name: 'AbortError' })
    expect(boundary.spawns[0]?.detached).toBe(true)
  })

  it('terminates the detached tree before rejecting a synchronous stdin failure', async () => {
    // Given
    const boundary = new FakeProcessBoundary()
    const stdinError = new TypeError('stdin closed before prompt delivery')
    boundary.child.stdinError = stdinError

    // When
    const rejection = captureRejection(runStudioRuntime(runtimeRequest('codex'), {
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      processBoundary: boundary,
    }))
    let acknowledged = false
    void rejection.then(() => {
      acknowledged = true
    })
    await Promise.resolve()

    // Then
    expect(boundary.treeSignals).toEqual(['SIGTERM'])
    expect(acknowledged).toBe(false)
    await vi.advanceTimersByTimeAsync(STUDIO_RUNTIME_TERMINATION_GRACE_MS)
    expect(boundary.treeSignals).toEqual(['SIGTERM', 'SIGKILL'])
    boundary.treeAlive = false
    await vi.runOnlyPendingTimersAsync()
    expect(await rejection).toBe(stdinError)
  })

  it('acknowledges cancellation after graceful process-tree termination', async () => {
    // Given
    const boundary = new FakeProcessBoundary()
    const controller = new AbortController()
    const runtime = runStudioRuntime(runtimeRequest('codex'), {
      signal: controller.signal,
      onChunk: vi.fn(),
      processBoundary: boundary,
    })
    const rejection = captureRejection(runtime)

    // When
    controller.abort()
    boundary.treeAlive = false
    boundary.child.emitClose(null)
    await vi.runOnlyPendingTimersAsync()

    // Then
    expect(boundary.treeSignals).toEqual(['SIGTERM'])
    expect(await rejection).toMatchObject({ name: 'AbortError' })
  })

  it.each([
    ['codex', STUDIO_RUNTIME_TIMEOUT_MS.codex],
    ['antigravity', STUDIO_RUNTIME_TIMEOUT_MS.antigravity],
  ] as const)('bounds %s execution with graceful and forced tree termination', async (runtime, timeoutMs) => {
    // Given
    const boundary = new FakeProcessBoundary()
    const execution = runStudioRuntime(runtimeRequest(runtime), {
      signal: new AbortController().signal,
      onChunk: vi.fn(),
      processBoundary: boundary,
    })
    const rejection = captureRejection(execution)

    // When
    await vi.advanceTimersByTimeAsync(timeoutMs)
    expect(boundary.treeSignals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(STUDIO_RUNTIME_TERMINATION_GRACE_MS)
    boundary.treeAlive = false
    await vi.runOnlyPendingTimersAsync()

    // Then
    expect(boundary.treeSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(await rejection).toMatchObject({
      name: 'StudioRuntimeTimeoutError',
      runtime,
      timeoutMs,
    })
  })
})
