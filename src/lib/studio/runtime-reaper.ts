import { spawnSync } from 'node:child_process'

import { z } from 'zod'

import {
  studioRuntimeProcessMarker,
  type StudioRuntimeProcessIdentity,
  type StudioRuntimeProcessRow,
} from './runtime-ownership'

export const STUDIO_RUNTIME_TERMINATION_GRACE_MS = 1_000
export const STUDIO_RUNTIME_TREE_POLL_MS = 25

export type StudioSystemProcess = {
  readonly pid: number
  readonly pgid: number
  readonly state: string
  readonly startedAt: string
  readonly commandLine: string
}

export interface StudioProcessRecoveryBoundary {
  snapshot(): readonly StudioSystemProcess[]
  signalGroup(pgid: number, signal: NodeJS.Signals): boolean
  isGroupAlive(pgid: number): boolean
  wait(milliseconds: number): void
}

const systemProcessSchema = z.object({
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  state: z.string().min(1),
  startedAt: z.string().min(1),
  commandLine: z.string().min(1),
})

export class StudioProcessInspectionError extends Error {
  readonly name = 'StudioProcessInspectionError'

  constructor(readonly detail: string) {
    super(`Unable to inspect Agent Studio process ownership: ${detail}`)
  }
}

function parseProcessLine(line: string): StudioSystemProcess | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
  if (!match) return null
  const parsed = systemProcessSchema.safeParse({
    pid: Number(match[1]),
    pgid: Number(match[2]),
    state: match[3],
    startedAt: match[4],
    commandLine: match[5],
  })
  return parsed.success ? parsed.data : null
}

function processSnapshot(): readonly StudioSystemProcess[] {
  if (process.platform === 'win32') return []
  const result = spawnSync('ps', ['-axo', 'pid=,pgid=,state=,lstart=,command='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 5_000,
  })
  if (result.error) throw new StudioProcessInspectionError(result.error.message)
  if (result.status !== 0) {
    throw new StudioProcessInspectionError(`ps exited with status ${result.status ?? 'unknown'}`)
  }
  const processes = result.stdout.split('\n').flatMap((line) => {
    const parsed = parseProcessLine(line)
    return parsed ? [parsed] : []
  })
  if (processes.length === 0) {
    throw new StudioProcessInspectionError('ps returned no parseable processes')
  }
  return processes.filter((processEntry) => !processEntry.state.startsWith('Z'))
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pgid, signal)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
    return false
  }
}

export function isStudioProcessGroupAlive(pgid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    return processSnapshot().some((processEntry) => processEntry.pgid === pgid)
  } catch (error) {
    if (!(error instanceof StudioProcessInspectionError)) throw error
  }
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

export const nodeStudioProcessRecoveryBoundary: StudioProcessRecoveryBoundary = {
  snapshot: processSnapshot,
  signalGroup: signalProcessGroup,
  isGroupAlive: isStudioProcessGroupAlive,
  wait: (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  },
}

export function readStudioRuntimeProcessIdentity(pid: number): StudioRuntimeProcessIdentity {
  const processEntry = processSnapshot().find((candidate) => candidate.pid === pid)
  return {
    pid,
    pgid: processEntry?.pgid ?? pid,
    startedAt: processEntry?.startedAt ?? null,
  }
}

function commandHasOwnershipMarker(commandLine: string, ownershipToken: string): boolean {
  const marker = studioRuntimeProcessMarker(ownershipToken)
  return commandLine === marker || commandLine.startsWith(`${marker} `)
}

function ownedProcess(
  row: StudioRuntimeProcessRow,
  processes: readonly StudioSystemProcess[],
): StudioSystemProcess | null {
  if (row.process_pid === null || row.process_pgid === null) {
    return processes.find((candidate) => (
      commandHasOwnershipMarker(candidate.commandLine, row.ownership_token)
    )) ?? null
  }
  const candidate = processes.find((processEntry) => processEntry.pid === row.process_pid)
  if (!candidate || candidate.pgid !== row.process_pgid) return null
  if (row.process_started_at !== null && candidate.startedAt !== row.process_started_at) return null
  return commandHasOwnershipMarker(candidate.commandLine, row.ownership_token)
    ? candidate
    : null
}

function waitForProcessGroups(
  pgids: Set<number>,
  boundary: StudioProcessRecoveryBoundary,
): void {
  let elapsed = 0
  while (pgids.size > 0 && elapsed < STUDIO_RUNTIME_TERMINATION_GRACE_MS) {
    for (const pgid of pgids) {
      if (!boundary.isGroupAlive(pgid)) pgids.delete(pgid)
    }
    if (pgids.size === 0) return
    const waitMs = Math.min(
      STUDIO_RUNTIME_TREE_POLL_MS,
      STUDIO_RUNTIME_TERMINATION_GRACE_MS - elapsed,
    )
    boundary.wait(waitMs)
    elapsed += waitMs
  }
  for (const pgid of pgids) {
    if (!boundary.isGroupAlive(pgid)) pgids.delete(pgid)
  }
}

export function reapStudioRuntimeProcessGroups(
  rows: readonly StudioRuntimeProcessRow[],
  boundary: StudioProcessRecoveryBoundary = nodeStudioProcessRecoveryBoundary,
): ReadonlyMap<string, boolean> {
  if (rows.length === 0) return new Map()
  const initialSnapshot = boundary.snapshot()
  const processByToken = new Map<string, StudioSystemProcess | null>()
  const unverifiedLiveTokens = new Set<string>()
  for (const row of rows) {
    const processEntry = ownedProcess(row, initialSnapshot)
    processByToken.set(row.ownership_token, processEntry)
    const persistedPid = row.process_pid === null
      ? null
      : initialSnapshot.find((candidate) => candidate.pid === row.process_pid) ?? null
    const identityWasReused = persistedPid !== null && (
      persistedPid.pgid !== row.process_pgid
      || (row.process_started_at !== null && persistedPid.startedAt !== row.process_started_at)
    )
    if (
      processEntry === null
      && row.process_pgid !== null
      && !identityWasReused
      && initialSnapshot.some((candidate) => candidate.pgid === row.process_pgid)
    ) {
      unverifiedLiveTokens.add(row.ownership_token)
    }
  }

  const liveGroups = new Set(
    [...processByToken.values()].flatMap((processEntry) => processEntry ? [processEntry.pgid] : []),
  )
  for (const pgid of liveGroups) boundary.signalGroup(pgid, 'SIGTERM')
  waitForProcessGroups(liveGroups, boundary)

  if (liveGroups.size > 0) {
    const beforeKill = boundary.snapshot()
    for (const pgid of liveGroups) {
      const stillOwned = [...processByToken].some(([token, initial]) => {
        if (initial?.pgid !== pgid) return false
        const current = beforeKill.find((candidate) => candidate.pid === initial.pid)
        return current?.pgid === initial.pgid
          && current.startedAt === initial.startedAt
          && commandHasOwnershipMarker(current.commandLine, token)
      })
      if (!stillOwned) {
        const initialOwner = [...processByToken.values()].find(
          (initial): initial is StudioSystemProcess => initial?.pgid === pgid,
        ) ?? null
        const currentPid = initialOwner
          ? beforeKill.find((candidate) => candidate.pid === initialOwner.pid) ?? null
          : null
        const identityWasReused = currentPid !== null && initialOwner !== null && (
          currentPid.pgid !== initialOwner.pgid
          || currentPid.startedAt !== initialOwner.startedAt
        )
        if (!identityWasReused && beforeKill.some((candidate) => candidate.pgid === pgid)) {
          for (const [token, initial] of processByToken) {
            if (initial?.pgid === pgid) unverifiedLiveTokens.add(token)
          }
        }
        liveGroups.delete(pgid)
        continue
      }
      boundary.signalGroup(pgid, 'SIGKILL')
    }
    waitForProcessGroups(liveGroups, boundary)
  }

  return new Map([...processByToken].map(([token, processEntry]) => [
    token,
    !unverifiedLiveTokens.has(token)
      && (processEntry === null || !liveGroups.has(processEntry.pgid)),
  ]))
}
