import { spawn, spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import {
  isStudioProcessGroupAlive,
  readStudioRuntimeProcessIdentity,
  reapStudioRuntimeProcessGroups,
  type StudioProcessRecoveryBoundary,
  type StudioSystemProcess,
} from '../runtime-reaper'
import { spawnStudioRuntimeProcess } from '../runtime-keeper'
import type { StudioRuntimeProcessRow } from '../runtime-ownership'

const spawnedGroups = new Set<number>()

function spawnOrphanedProcess(argv0: string): number {
  const script = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn('/bin/sleep', ['30'], { argv0: process.argv[1], detached: true, stdio: 'ignore' })",
    'child.unref()',
    'process.stdout.write(String(child.pid))',
  ].join(';')
  const result = spawnSync(process.execPath, ['-e', script, argv0], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (result.status !== 0) throw new TypeError(`Unable to create orphan fixture: ${result.stderr}`)
  const pid = Number(result.stdout)
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('Orphan fixture returned an invalid PID')
  spawnedGroups.add(pid)
  return pid
}

async function spawnExitedLeaderWithDescendant(argv0: string): Promise<{
  readonly descendantPid: number
  readonly leaderIdentity: ReturnType<typeof readStudioRuntimeProcessIdentity>
}> {
  const script = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn('/bin/sleep', ['30'], { detached: false, stdio: 'ignore' })",
    'child.unref()',
    "process.stdout.write(`${child.pid}\\n`)",
    'process.stdin.resume()',
  ].join(';')
  const leader = spawn(process.execPath, ['-e', script], {
    argv0,
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  if (!leader.pid) throw new TypeError('Leader fixture has no process id')
  spawnedGroups.add(leader.pid)

  const descendantPid = await new Promise<number>((resolve, reject) => {
    let output = ''
    leader.once('error', reject)
    leader.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const lineEnd = output.indexOf('\n')
      if (lineEnd < 0) return
      const pid = Number(output.slice(0, lineEnd))
      if (!Number.isInteger(pid) || pid <= 0) {
        reject(new TypeError('Leader fixture returned an invalid descendant PID'))
        return
      }
      resolve(pid)
    })
  })
  const leaderIdentity = readStudioRuntimeProcessIdentity(leader.pid)
  leader.stdin.end()
  await new Promise<void>((resolve, reject) => {
    leader.once('error', reject)
    leader.once('close', () => resolve())
  })
  return { descendantPid, leaderIdentity }
}

async function spawnKeptRuntimeWithDescendant(argv0: string): Promise<{
  readonly descendantPid: number
  readonly keeperIdentity: ReturnType<typeof readStudioRuntimeProcessIdentity>
}> {
  const script = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn('/bin/sleep', ['30'], { detached: false, stdio: 'ignore' })",
    'child.unref()',
    "process.stdout.write(`${child.pid}\\n`)",
  ].join(';')
  const runtime = spawnStudioRuntimeProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    argv0,
  })
  if (runtime.pid === null) throw new TypeError('Runtime keeper fixture has no process id')
  spawnedGroups.add(runtime.pid)
  const keeperIdentity = readStudioRuntimeProcessIdentity(runtime.pid)

  const descendantPid = await new Promise<number>((resolve, reject) => {
    let output = ''
    let parsedPid: number | null = null
    let runtimeCode: number | null = null
    const finish = (): void => {
      if (parsedPid === null || runtimeCode === null) return
      if (runtimeCode !== 0) {
        reject(new TypeError(`Runtime keeper fixture exited with code ${runtimeCode}`))
        return
      }
      resolve(parsedPid)
    }
    runtime.onStdout((chunk) => {
      output += chunk.toString('utf8')
      const lineEnd = output.indexOf('\n')
      if (lineEnd < 0 || parsedPid !== null) return
      const pid = Number(output.slice(0, lineEnd))
      if (!Number.isInteger(pid) || pid <= 0) {
        reject(new TypeError('Runtime keeper fixture returned an invalid descendant PID'))
        return
      }
      parsedPid = pid
      finish()
    })
    runtime.onRuntimeClose((code) => {
      runtimeCode = code
      finish()
    })
    runtime.onError(reject)
    runtime.onClose((code) => {
      reject(new TypeError(`Runtime keeper exited before recovery with code ${code ?? 'unknown'}`))
    })
    runtime.endStdin(null)
  })
  return { descendantPid, keeperIdentity }
}

function terminateFixtureGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

afterEach(() => {
  for (const pgid of spawnedGroups) terminateFixtureGroup(pgid)
  spawnedGroups.clear()
})

describe.skipIf(process.platform === 'win32')('Agent Studio real process-group recovery', () => {
  it('reclaims the owned orphan on restart without killing a reused unrelated PID', () => {
    // Given
    const ownedToken = 'owned-real-process'
    const ownedPid = spawnOrphanedProcess(`agent-studio:${ownedToken}`)
    const unrelatedPid = spawnOrphanedProcess('unrelated-runtime')
    const ownedIdentity = readStudioRuntimeProcessIdentity(ownedPid)
    const unrelatedIdentity = readStudioRuntimeProcessIdentity(unrelatedPid)
    const rows: readonly StudioRuntimeProcessRow[] = [
      {
        ownership_token: ownedToken,
        workspace_id: 7,
        run_id: 24,
        node_id: 'builder',
        agent_id: 91,
        process_pid: ownedPid,
        process_pgid: ownedIdentity.pgid,
        process_started_at: ownedIdentity.startedAt,
      },
      {
        ownership_token: 'stale-reused-process',
        workspace_id: 7,
        run_id: 25,
        node_id: 'reviewer',
        agent_id: 92,
        process_pid: unrelatedPid,
        process_pgid: unrelatedIdentity.pgid,
        process_started_at: 'Mon Jul 20 01:00:00 2026',
      },
    ]

    // When
    const reclaimed = reapStudioRuntimeProcessGroups(rows)

    // Then
    expect(reclaimed.get(ownedToken)).toBe(true)
    expect(reclaimed.get('stale-reused-process')).toBe(true)
    expect(isStudioProcessGroupAlive(ownedIdentity.pgid)).toBe(false)
    expect(isStudioProcessGroupAlive(unrelatedIdentity.pgid)).toBe(true)
    spawnedGroups.delete(ownedIdentity.pgid)
  })

  it('preserves an attached claim when its marked leader exits but the PGID still has a descendant', async () => {
    // Given
    const ownershipToken = 'exited-leader-live-descendant'
    const fixture = await spawnExitedLeaderWithDescendant(`agent-studio:${ownershipToken}`)
    const descendantIdentity = readStudioRuntimeProcessIdentity(fixture.descendantPid)
    expect(descendantIdentity.pgid).toBe(fixture.leaderIdentity.pgid)
    const row: StudioRuntimeProcessRow = {
      ownership_token: ownershipToken,
      workspace_id: 7,
      run_id: 26,
      node_id: 'builder',
      agent_id: 93,
      process_pid: fixture.leaderIdentity.pid,
      process_pgid: fixture.leaderIdentity.pgid,
      process_started_at: fixture.leaderIdentity.startedAt,
    }

    // When
    const reclaimed = reapStudioRuntimeProcessGroups([row])

    // Then
    expect(reclaimed.get(ownershipToken)).toBe(false)
    expect(isStudioProcessGroupAlive(fixture.leaderIdentity.pgid)).toBe(true)
  })

  it.each([
    ['attached', 'keeper-attached-live-descendant', true],
    ['pre-attachment', 'keeper-live-descendant', false],
  ] as const)('reclaims the %s keeper after the runtime exits with a live same-group descendant', async (
    _claimState,
    ownershipToken,
    attachIdentity,
  ) => {
    // Given
    const fixture = await spawnKeptRuntimeWithDescendant(`agent-studio:${ownershipToken}`)
    const descendantIdentity = readStudioRuntimeProcessIdentity(fixture.descendantPid)
    expect(descendantIdentity.pgid).toBe(fixture.keeperIdentity.pgid)
    expect(isStudioProcessGroupAlive(fixture.keeperIdentity.pgid)).toBe(true)
    const row: StudioRuntimeProcessRow = {
      ownership_token: ownershipToken,
      workspace_id: 7,
      run_id: 27,
      node_id: 'builder',
      agent_id: 94,
      process_pid: attachIdentity ? fixture.keeperIdentity.pid : null,
      process_pgid: attachIdentity ? fixture.keeperIdentity.pgid : null,
      process_started_at: attachIdentity ? fixture.keeperIdentity.startedAt : null,
    }

    // When
    const reclaimed = reapStudioRuntimeProcessGroups([row])

    // Then
    expect(reclaimed.get(ownershipToken)).toBe(true)
    expect(isStudioProcessGroupAlive(fixture.keeperIdentity.pgid)).toBe(false)
    spawnedGroups.delete(fixture.keeperIdentity.pgid)
  })
})

describe('Agent Studio process-group identity revalidation', () => {
  it('does not KILL a PGID reused after TERM for a pre-attachment claim', () => {
    // Given
    const ownershipToken = 'pre-spawn-claim'
    const initialProcess: StudioSystemProcess = {
      pid: 411,
      pgid: 411,
      state: 'S',
      startedAt: 'Tue Jul 21 01:00:00 2026',
      commandLine: `agent-studio:${ownershipToken} exec --json`,
    }
    const reusedProcess: StudioSystemProcess = {
      pid: 411,
      pgid: 411,
      state: 'S',
      startedAt: 'Tue Jul 21 02:00:00 2026',
      commandLine: '/usr/bin/unrelated-worker',
    }
    const signals: Array<readonly [number, NodeJS.Signals]> = []
    let snapshotCount = 0
    const boundary: StudioProcessRecoveryBoundary = {
      snapshot: () => {
        snapshotCount += 1
        return snapshotCount === 1 ? [initialProcess] : [reusedProcess]
      },
      signalGroup: (pgid, signal) => {
        signals.push([pgid, signal])
        return true
      },
      isGroupAlive: () => true,
      wait: () => undefined,
    }
    const row: StudioRuntimeProcessRow = {
      ownership_token: ownershipToken,
      workspace_id: 7,
      run_id: 24,
      node_id: 'builder',
      agent_id: 91,
      process_pid: null,
      process_pgid: null,
      process_started_at: null,
    }

    // When
    const reclaimed = reapStudioRuntimeProcessGroups([row], boundary)

    // Then
    expect(signals).toEqual([[411, 'SIGTERM']])
    expect(reclaimed.get(ownershipToken)).toBe(true)
  })
})
