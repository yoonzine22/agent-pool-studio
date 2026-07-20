import type { StudioRuntime } from './schemas'

export interface RuntimeInvocationRequest {
  runtime: StudioRuntime
  prompt: string
  workspacePath: string
  model: string | null
}

export interface RuntimeInvocation {
  command: 'codex' | 'agy'
  args: string[]
  stdin: string | null
  cwd?: string
}

export function buildRuntimeInvocation(request: RuntimeInvocationRequest): RuntimeInvocation {
  if (request.runtime === 'codex') {
    const modelArgs = request.model ? ['--model', request.model] : []
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--cd',
        request.workspacePath,
        ...modelArgs,
        '-',
      ],
      stdin: request.prompt,
    }
  }

  const modelArgs = request.model ? ['--model', request.model] : []
  return {
    command: 'agy',
    args: [
      '--sandbox',
      '--mode',
      'accept-edits',
      '--print-timeout',
      '10m',
      ...modelArgs,
      '--print',
      request.prompt,
    ],
    stdin: null,
    cwd: request.workspacePath,
  }
}
