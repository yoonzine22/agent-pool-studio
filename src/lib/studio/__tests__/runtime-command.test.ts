import { describe, expect, it } from 'vitest'

import { buildRuntimeInvocation } from '../runtime-command'
import { normalizeRuntimeOutput } from '../runtime-process'

describe('Agent Studio runtime commands', () => {
  it('builds a machine-readable, non-interactive Codex invocation', () => {
    expect(
      buildRuntimeInvocation({
        runtime: 'codex',
        prompt: 'Implement the node.',
        workspacePath: '/tmp/project',
        model: null,
      }),
    ).toEqual({
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--cd',
        '/tmp/project',
        '-',
      ],
      stdin: 'Implement the node.',
    })
  })

  it('places the Antigravity print prompt after every option so it is not mistaken for a flag', () => {
    expect(
      buildRuntimeInvocation({
        runtime: 'antigravity',
        prompt: 'Research the request.',
        workspacePath: '/tmp/project',
        model: 'gemini-3.1-pro',
      }),
    ).toEqual({
      command: 'agy',
      args: [
        '--sandbox',
        '--mode',
        'accept-edits',
        '--print-timeout',
        '10m',
        '--model',
        'gemini-3.1-pro',
        '--print',
        'Research the request.',
      ],
      stdin: null,
      cwd: '/tmp/project',
    })
  })

  it('stores only Codex agent messages instead of the JSONL protocol transcript', () => {
    const transcript = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ENGINE_READY' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
    ].join('\n')

    expect(normalizeRuntimeOutput('codex', transcript)).toBe('ENGINE_READY')
  })
})
