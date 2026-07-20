import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import type { StudioRuntime, StudioRuntimeReadiness } from './schemas'
import { buildRuntimeInvocation, type RuntimeInvocationRequest } from './runtime-command'
import { spawnStudioRuntimeProcess } from './runtime-keeper'
import {
  readStudioRuntimeProcessIdentity,
  STUDIO_RUNTIME_TERMINATION_GRACE_MS,
  STUDIO_RUNTIME_TREE_POLL_MS,
} from './runtime-reaper'
import type { StudioRuntimeProcessIdentity, StudioRuntimeProcessOwnership } from './runtime-ownership'
import { buildStudioRuntimeEnv, resolveStudioWorkspacePath } from './runtime-security'

export { STUDIO_RUNTIME_TERMINATION_GRACE_MS, STUDIO_RUNTIME_TREE_POLL_MS } from './runtime-reaper'

// allow: SIZE_OK — this module owns one spawned-process lifecycle and its typed test boundary.
export interface RuntimeChunk {
  readonly kind: 'output' | 'error' | 'meta'
  readonly text: string
}

export interface StudioRuntimeProcessSpawn {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly detached: boolean
  readonly argv0: string
}

export interface StudioRuntimeProcess {
  readonly pid: number | null
  onStdout(listener: (chunk: Buffer) => void): void
  onStderr(listener: (chunk: Buffer) => void): void
  onError(listener: (error: Error) => void): void
  onRuntimeClose(listener: (code: number) => void): void
  onClose(listener: (code: number | null) => void): void
  endStdin(input: string | null): void
  kill(signal: NodeJS.Signals): boolean
}

export interface StudioRuntimeProcessBoundary {
  spawn(specification: StudioRuntimeProcessSpawn): StudioRuntimeProcess
  terminateTree(child: StudioRuntimeProcess, signal: NodeJS.Signals): void
  isTreeAlive(child: StudioRuntimeProcess): boolean
  identify(child: StudioRuntimeProcess): StudioRuntimeProcessIdentity
}

export interface StudioRuntimeExecution {
  readonly signal: AbortSignal
  readonly onChunk: (chunk: RuntimeChunk) => void
  readonly processBoundary?: StudioRuntimeProcessBoundary
  readonly ownership?: StudioRuntimeProcessOwnership
}

export interface StudioRuntimeRequest extends RuntimeInvocationRequest {
  readonly workspaceId: number
}

export const STUDIO_RUNTIME_TIMEOUT_MS = {
  codex: 10 * 60_000,
  antigravity: 11 * 60_000,
} as const satisfies Record<StudioRuntime, number>

export class StudioRuntimeTimeoutError extends Error {
  readonly name = 'StudioRuntimeTimeoutError'

  constructor(
    readonly runtime: StudioRuntime,
    readonly timeoutMs: number,
  ) {
    super(`${runtime} execution timed out after ${timeoutMs}ms`)
  }
}

type RuntimeSettlement =
  | { readonly kind: 'resolve'; readonly output: string }
  | { readonly kind: 'reject'; readonly error: Error }

const codexEventSchema = z.object({
  type: z.string(),
  item: z.object({
    type: z.string(),
    text: z.string().optional(),
  }).passthrough().optional(),
  message: z.string().optional(),
}).passthrough()

const nodeProcessBoundary: StudioRuntimeProcessBoundary = {
  spawn: spawnStudioRuntimeProcess,
  terminateTree: (child, signal) => {
    if (child.pid === null) {
      child.kill(signal)
      return
    }
    if (process.platform === 'win32') {
      try {
        const force = signal === 'SIGKILL' ? ['/f'] : []
        const result = spawnSync(
          'taskkill.exe',
          ['/pid', String(child.pid), '/t', ...force],
          { stdio: 'ignore', timeout: 5_000 },
        )
        if (result.status === 0) return
      } catch (error) {
        if (!(error instanceof Error)) throw error
      }
      child.kill(signal)
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      child.kill(signal)
    }
  },
  isTreeAlive: (child) => {
    if (child.pid === null) return false
    if (process.platform === 'win32') {
      const result = spawnSync(
        'tasklist.exe',
        ['/fi', `PID eq ${child.pid}`, '/fo', 'csv', '/nh'],
        { encoding: 'utf8', timeout: 5_000 },
      )
      return result.status === 0 && result.stdout.includes(`"${child.pid}"`)
    }
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
      return true
    }
  },
  identify: (child) => {
    if (child.pid === null) {
      throw new TypeError('Spawned Agent Studio runtime has no process id')
    }
    return readStudioRuntimeProcessIdentity(child.pid)
  },
}

function configuredBinary(runtime: StudioRuntime): string | null {
  const value = runtime === 'codex'
    ? process.env.AGENT_STUDIO_CODEX_BIN
    : process.env.AGENT_STUDIO_ANTIGRAVITY_BIN
  return value?.trim() || null
}

function resolveBinary(runtime: StudioRuntime): string {
  const configured = configuredBinary(runtime)
  if (configured) return configured
  const name = runtime === 'codex' ? 'codex' : 'agy'
  const local = join(homedir(), '.local', 'bin', name)
  return existsSync(local) ? local : name
}

function parseCodexLine(line: string): RuntimeChunk | null {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return line.trim() ? { kind: 'output', text: line } : null
  }
  const event = codexEventSchema.safeParse(json)
  if (!event.success) return null
  if (event.data.item?.type === 'agent_message' && event.data.item.text) {
    return { kind: 'output', text: event.data.item.text }
  }
  if (event.data.message) return { kind: 'meta', text: event.data.message }
  return { kind: 'meta', text: event.data.type }
}

function appendCapped(current: string, next: string): string {
  const combined = current + next
  return combined.length > 200_000 ? combined.slice(-200_000) : combined
}

export function normalizeRuntimeOutput(runtime: StudioRuntime, stdout: string): string {
  if (runtime === 'antigravity') return stdout.trim()
  const messages = stdout
    .split('\n')
    .map(parseCodexLine)
    .filter((chunk): chunk is RuntimeChunk => chunk?.kind === 'output')
    .map((chunk) => chunk.text)
  return messages.join('\n\n').trim() || stdout.trim()
}

export async function runStudioRuntime(
  request: StudioRuntimeRequest,
  execution: StudioRuntimeExecution,
): Promise<string> {
  execution.signal.throwIfAborted()
  const workspacePath = resolveStudioWorkspacePath(request.workspacePath, request.workspaceId)
  const invocation = buildRuntimeInvocation({
    runtime: request.runtime,
    prompt: request.prompt,
    workspacePath,
    model: request.model,
  })
  const command = resolveBinary(request.runtime)
  const boundary = execution.processBoundary ?? nodeProcessBoundary
  const timeoutMs = STUDIO_RUNTIME_TIMEOUT_MS[request.runtime]

  return new Promise((resolve, reject) => {
    const child = boundary.spawn({
      command,
      args: invocation.args,
      cwd: workspacePath,
      env: buildStudioRuntimeEnv(request.runtime),
      detached: true,
      argv0: execution.ownership?.marker ?? command,
    })
    let stdout = ''
    let stderr = ''
    let lineBuffer = ''
    let terminationOutcome: RuntimeSettlement | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    let escalationTimer: ReturnType<typeof setTimeout> | null = null
    let terminationPollTimer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    let runtimeClosed = false

    const cleanup = (): void => {
      execution.signal.removeEventListener('abort', abort)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (escalationTimer) clearTimeout(escalationTimer)
      if (terminationPollTimer) clearTimeout(terminationPollTimer)
    }
    const finishReject = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const finishResolve = (output: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(output)
    }
    const settle = (outcome: RuntimeSettlement): void => {
      switch (outcome.kind) {
        case 'resolve':
          finishResolve(outcome.output)
          return
        case 'reject':
          finishReject(outcome.error)
          return
      }
    }
    const observeTreeTermination = (): void => {
      if (settled || !terminationOutcome) return
      if (!boundary.isTreeAlive(child)) {
        settle(terminationOutcome)
        return
      }
      if (terminationPollTimer) return
      terminationPollTimer = setTimeout(() => {
        terminationPollTimer = null
        observeTreeTermination()
      }, STUDIO_RUNTIME_TREE_POLL_MS)
    }
    const beginTermination = (outcome: RuntimeSettlement): void => {
      if (settled || terminationOutcome) return
      terminationOutcome = outcome
      boundary.terminateTree(child, 'SIGTERM')
      escalationTimer = setTimeout(() => {
        escalationTimer = null
        if (settled || !boundary.isTreeAlive(child)) {
          observeTreeTermination()
          return
        }
        boundary.terminateTree(child, 'SIGKILL')
        observeTreeTermination()
      }, STUDIO_RUNTIME_TERMINATION_GRACE_MS)
      observeTreeTermination()
    }
    const abort = (): void => beginTermination({
      kind: 'reject',
      error: new DOMException('Run cancelled', 'AbortError'),
    })
    execution.signal.addEventListener('abort', abort, { once: true })
    timeoutTimer = setTimeout(() => beginTermination({
      kind: 'reject',
      error: new StudioRuntimeTimeoutError(request.runtime, timeoutMs),
    }), timeoutMs)

    child.onStdout((chunk) => {
      const text = chunk.toString('utf8')
      stdout = appendCapped(stdout, text)
      if (request.runtime === 'antigravity') {
        if (text.trim()) execution.onChunk({ kind: 'output', text })
        return
      }
      lineBuffer += text
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const parsed = parseCodexLine(line)
        if (parsed) execution.onChunk(parsed)
      }
    })

    child.onStderr((chunk) => {
      const text = chunk.toString('utf8')
      stderr = appendCapped(stderr, text)
      if (text.trim()) execution.onChunk({ kind: 'error', text: text.trim() })
    })

    child.onError((error) => {
      if (terminationOutcome) {
        observeTreeTermination()
        return
      }
      const outcome = {
        kind: 'reject',
        error: new Error(`Unable to start ${request.runtime}: ${error.message}`),
      } as const satisfies RuntimeSettlement
      if (boundary.isTreeAlive(child)) beginTermination(outcome)
      else settle(outcome)
    })

    const handleRuntimeClose = (code: number | null): void => {
      if (terminationOutcome) {
        observeTreeTermination()
        return
      }
      if (runtimeClosed) return
      runtimeClosed = true
      if (request.runtime === 'codex' && lineBuffer.trim()) {
        const parsed = parseCodexLine(lineBuffer)
        if (parsed) execution.onChunk(parsed)
      }
      const outcome: RuntimeSettlement = code === 0
        ? { kind: 'resolve', output: normalizeRuntimeOutput(request.runtime, stdout) }
        : {
            kind: 'reject',
            error: new Error(stderr.trim() || `${request.runtime} exited with code ${code ?? 'unknown'}`),
      }
      if (boundary.isTreeAlive(child)) beginTermination(outcome)
      else settle(outcome)
    }
    child.onRuntimeClose(handleRuntimeClose)
    child.onClose(handleRuntimeClose)

    try {
      if (execution.ownership && child.pid !== null) {
        execution.ownership.processStarted(boundary.identify(child))
      }
      child.endStdin(invocation.stdin)
    } catch (error) {
      beginTermination({
        kind: 'reject',
        error: error instanceof Error
          ? error
          : new TypeError('Unable to initialize Agent Studio runtime process'),
      })
      return
    }
  })
}

export function getStudioRuntimeReadiness(runtime: StudioRuntime): StudioRuntimeReadiness {
  const command = resolveBinary(runtime)
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    env: buildStudioRuntimeEnv(runtime),
    timeout: 5_000,
  })
  const version = result.status === 0 ? result.stdout.trim() || result.stderr.trim() : null
  return {
    runtime,
    available: result.status === 0,
    command,
    version: version || null,
    detail: result.status === 0
      ? 'CLI detected and ready for local execution.'
      : result.error?.message ?? result.stderr.trim() ?? 'CLI is not available.',
  }
}
