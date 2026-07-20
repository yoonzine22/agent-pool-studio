import { spawn } from 'node:child_process'

import { z } from 'zod'

import type { StudioRuntimeProcess, StudioRuntimeProcessSpawn } from './runtime-process'

const runtimeCloseMessageSchema = z.object({
  type: z.literal('agent-studio-runtime-close'),
  code: z.number().int(),
}).strict()

const RUNTIME_KEEPER_SOURCE = [
  "'use strict'",
  "const { spawn, spawnSync } = require('node:child_process')",
  'const command = process.argv[1]',
  'const args = JSON.parse(process.argv[2])',
  'let runtimeExited = false',
  'let runtimeCode = 1',
  'let reported = false',
  'let groupPoll = null',
  'function hasGroupDescendant() {',
  "  const result = spawnSync('ps', ['-axo', 'pid=,pgid=,state='], {",
  "    encoding: 'utf8',",
  '    detached: true,',
  '    env: { ...process.env, LC_ALL: "C" },',
  '    timeout: 5000,',
  '  })',
  '  if (result.error || result.status !== 0) return true',
  '  let parsedOwnProcess = false',
  "  const live = result.stdout.split('\\n').some((line) => {",
  "    const fields = line.trim().split(/\\s+/)",
  '    if (fields.length !== 3) return false',
  '    const pid = Number(fields[0])',
  '    const pgid = Number(fields[1])',
  '    const state = fields[2]',
  '    if (pid === process.pid && pgid === process.pid) parsedOwnProcess = true',
  "    return pgid === process.pid && pid !== process.pid && !state.startsWith('Z')",
  '  })',
  '  return parsedOwnProcess ? live : true',
  '}',
  'function exitKeeper() {',
  '  if (groupPoll) clearInterval(groupPoll)',
  '  process.exit(runtimeCode)',
  '}',
  'function reportRuntimeClose() {',
  '  if (reported) return',
  '  reported = true',
  "  if (typeof process.send !== 'function' || !process.connected) return",
  '  try {',
  "    process.send({ type: 'agent-studio-runtime-close', code: runtimeCode }, () => undefined)",
  '  } catch (error) {',
  "    const code = error && typeof error === 'object' && 'code' in error ? error.code : null",
  "    if (code !== 'ERR_IPC_CHANNEL_CLOSED' && code !== 'ERR_IPC_DISCONNECTED') runtimeCode = 1",
  '  }',
  '}',
  'function finishRuntime(code) {',
  '  if (runtimeExited) return',
  '  runtimeExited = true',
  '  runtimeCode = Number.isInteger(code) && code >= 0 ? code : 1',
  '  if (!hasGroupDescendant()) {',
  '    exitKeeper()',
  '    return',
  '  }',
  '  reportRuntimeClose()',
  '  groupPoll = setInterval(() => {',
  '    if (!hasGroupDescendant()) exitKeeper()',
  '  }, 250)',
  '}',
  "process.on('SIGTERM', () => {",
  '  if (runtimeExited && !hasGroupDescendant()) exitKeeper()',
  '})',
  'const runtimeEnv = { ...process.env }',
  'delete runtimeEnv.NODE_CHANNEL_FD',
  'delete runtimeEnv.NODE_CHANNEL_SERIALIZATION_MODE',
  'const runtime = spawn(command, args, {',
  '  cwd: process.cwd(),',
  '  detached: false,',
  '  env: runtimeEnv,',
  '  shell: false,',
  "  stdio: ['inherit', 'inherit', 'inherit'],",
  '})',
  "runtime.once('error', (error) => {",
  "  process.stderr.write(`Unable to start runtime: ${error.message}\\n`)",
  '  finishRuntime(127)',
  '})',
  "runtime.once('close', (code) => finishRuntime(code))",
].join('\n')

function spawnDirectRuntime(specification: StudioRuntimeProcessSpawn): StudioRuntimeProcess {
  const child = spawn(specification.command, [...specification.args], {
    cwd: specification.cwd,
    env: specification.env,
    detached: specification.detached,
    argv0: specification.argv0,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return {
    pid: child.pid ?? null,
    onStdout: (listener) => { child.stdout.on('data', listener) },
    onStderr: (listener) => { child.stderr.on('data', listener) },
    onError: (listener) => { child.on('error', listener) },
    onRuntimeClose: () => undefined,
    onClose: (listener) => { child.on('close', listener) },
    endStdin: (input) => {
      if (input === null) child.stdin.end()
      else child.stdin.end(input)
    },
    kill: (signal) => child.kill(signal),
  }
}

export function spawnStudioRuntimeProcess(
  specification: StudioRuntimeProcessSpawn,
): StudioRuntimeProcess {
  if (process.platform === 'win32' || !specification.detached) {
    return spawnDirectRuntime(specification)
  }

  const child = spawn(
    process.execPath,
    ['-e', RUNTIME_KEEPER_SOURCE, specification.command, JSON.stringify(specification.args)],
    {
      cwd: specification.cwd,
      env: specification.env,
      detached: true,
      argv0: specification.argv0,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  )
  let runtimeCloseListener: ((code: number) => void) | null = null
  let pendingRuntimeCode: number | null = null
  const stdin = child.stdin
  const stdout = child.stdout
  const stderr = child.stderr
  if (!stdin || !stdout || !stderr) {
    child.kill('SIGKILL')
    throw new TypeError('Agent Studio runtime keeper has incomplete standard streams')
  }
  child.on('message', (message: unknown) => {
    const parsed = runtimeCloseMessageSchema.safeParse(message)
    if (!parsed.success || pendingRuntimeCode !== null) return
    pendingRuntimeCode = parsed.data.code
    runtimeCloseListener?.(parsed.data.code)
  })

  return {
    pid: child.pid ?? null,
    onStdout: (listener) => { stdout.on('data', listener) },
    onStderr: (listener) => { stderr.on('data', listener) },
    onError: (listener) => { child.on('error', listener) },
    onRuntimeClose: (listener) => {
      runtimeCloseListener = listener
      if (pendingRuntimeCode !== null) listener(pendingRuntimeCode)
    },
    onClose: (listener) => { child.on('close', listener) },
    endStdin: (input) => {
      if (input === null) stdin.end()
      else stdin.end(input)
    },
    kill: (signal) => child.kill(signal),
  }
}
