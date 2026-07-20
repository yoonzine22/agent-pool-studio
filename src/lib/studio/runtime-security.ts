import { isAbsolute } from 'node:path'
import { z } from 'zod'

import { resolveCliDispatchCwd } from '../task-dispatch'
import type { StudioRuntime } from './schemas'
import { parseJson } from './store-utils'

const COMMON_RUNTIME_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

const RUNTIME_ENV_KEYS = {
  codex: [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
    'CODEX_HOME',
  ],
  antigravity: [
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'CLOUDSDK_CONFIG',
  ],
} as const satisfies Record<StudioRuntime, readonly string[]>

const workspaceRootsSchema = z.record(
  z.string().regex(/^[1-9]\d*$/),
  z.string().trim().min(1).refine(isAbsolute),
)

export type StudioWorkspaceErrorCode =
  | 'invalid_workspace_id'
  | 'workspace_roots_invalid'
  | 'workspace_root_not_configured'
  | 'workspace_root_invalid'
  | 'invalid_workspace_path'

const STUDIO_WORKSPACE_ERROR_MESSAGES = {
  invalid_workspace_id: () => 'Agent Studio workspace ID must be a positive integer.',
  workspace_roots_invalid: () =>
    'MC_STUDIO_WORKSPACE_ROOTS must be a JSON object mapping positive numeric workspace IDs to absolute directory paths.',
  workspace_root_not_configured: (workspaceId: number) => workspaceId === 1
    ? 'Agent Studio workspace 1 requires MC_STUDIO_WORKSPACE_ROOTS["1"] or MC_WORKSPACE_ROOT.'
    : `Agent Studio workspace ${workspaceId} requires MC_STUDIO_WORKSPACE_ROOTS["${workspaceId}"]; MC_WORKSPACE_ROOT is only valid for workspace 1.`,
  workspace_root_invalid: (workspaceId: number) =>
    `The configured Agent Studio root for workspace ${workspaceId} must be an existing, accessible absolute directory.`,
  invalid_workspace_path: (workspaceId: number) =>
    `Agent Studio workspace path must be an accessible directory inside the configured root for workspace ${workspaceId}.`,
} as const satisfies Record<StudioWorkspaceErrorCode, (workspaceId: number) => string>

export class StudioWorkspaceError extends Error {
  readonly name = 'StudioWorkspaceError'

  constructor(
    readonly code: StudioWorkspaceErrorCode,
    readonly workspaceId: number,
  ) {
    super(STUDIO_WORKSPACE_ERROR_MESSAGES[code](workspaceId))
  }
}

export function getStudioWorkspaceRoot(
  workspaceId: number,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new StudioWorkspaceError('invalid_workspace_id', workspaceId)
  }

  const encodedRoots = source.MC_STUDIO_WORKSPACE_ROOTS?.trim()
  const workspaceRoots = ((): Readonly<Record<string, string>> => {
    if (!encodedRoots) return {}
    try {
      return parseJson(encodedRoots, workspaceRootsSchema)
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new StudioWorkspaceError('workspace_roots_invalid', workspaceId)
      }
      throw error
    }
  })()
  const mappedRoot = workspaceRoots[String(workspaceId)]
  const defaultRoot = workspaceId === 1 ? source.MC_WORKSPACE_ROOT?.trim() : undefined
  const configuredRoot = mappedRoot ?? defaultRoot
  if (!configuredRoot) {
    throw new StudioWorkspaceError('workspace_root_not_configured', workspaceId)
  }
  if (!isAbsolute(configuredRoot)) {
    throw new StudioWorkspaceError('workspace_root_invalid', workspaceId)
  }

  const resolved = resolveCliDispatchCwd('.', configuredRoot.normalize('NFC'))
  if (!resolved) throw new StudioWorkspaceError('workspace_root_invalid', workspaceId)
  return resolved
}

export function resolveStudioWorkspacePath(
  workspacePath: string,
  workspaceId: number,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const workspaceRoot = getStudioWorkspaceRoot(workspaceId, source)
  const resolved = resolveCliDispatchCwd(
    workspacePath.normalize('NFC'),
    workspaceRoot.normalize('NFC'),
  )
  if (!resolved) throw new StudioWorkspaceError('invalid_workspace_path', workspaceId)
  return resolved
}

export function buildStudioRuntimeEnv(
  runtime: StudioRuntime,
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const nodeEnv = source.NODE_ENV
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: nodeEnv === 'development' || nodeEnv === 'test' ? nodeEnv : 'production',
  }
  for (const key of [...COMMON_RUNTIME_ENV_KEYS, ...RUNTIME_ENV_KEYS[runtime]]) {
    const value = source[key]
    if (value !== undefined) childEnv[key] = value
  }
  return childEnv
}
