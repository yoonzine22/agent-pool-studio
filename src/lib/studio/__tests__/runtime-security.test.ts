import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getStudioAgent } from '../agent-store'
import {
  buildStudioRuntimeEnv,
  getStudioWorkspaceRoot,
  resolveStudioWorkspacePath,
  StudioWorkspaceError,
} from '../runtime-security'

const tempRoots: string[] = []

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

function captureWorkspaceError(action: () => unknown): StudioWorkspaceError {
  try {
    action()
  } catch (error) {
    if (error instanceof StudioWorkspaceError) return error
    throw error
  }
  throw new TypeError('Expected workspace resolution to fail')
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('Agent Studio runtime security', () => {
  it('rejects workspace 2 when only the default workspace root is configured', () => {
    // Given
    const defaultRoot = makeTempRoot('studio-default-root-')
    const source = { MC_WORKSPACE_ROOT: defaultRoot }

    // When
    const error = captureWorkspaceError(
      () => resolveStudioWorkspacePath(defaultRoot, 2, source),
    )

    // Then
    expect(error.code).toBe('workspace_root_not_configured')
  })

  it('resolves workspace 2 inside its explicit mapped root', () => {
    // Given
    const workspaceRoot = makeTempRoot('studio-workspace-two-')
    const project = join(workspaceRoot, 'project')
    mkdirSync(project)
    const source = {
      MC_STUDIO_WORKSPACE_ROOTS: JSON.stringify({ 2: workspaceRoot }),
    }

    // When
    const resolved = resolveStudioWorkspacePath(project, 2, source)

    // Then
    expect(resolved).toBe(realpathSync(project))
  })

  it('returns the canonical root for an explicitly mapped workspace', () => {
    // Given
    const workspaceRoot = makeTempRoot('studio-workspace-root-')
    const source = {
      MC_STUDIO_WORKSPACE_ROOTS: JSON.stringify({ 2: workspaceRoot }),
    }

    // When
    const resolved = getStudioWorkspaceRoot(2, source)

    // Then
    expect(resolved).toBe(realpathSync(workspaceRoot))
  })

  it('rejects a sibling workspace root reached through a symlink', () => {
    // Given
    const workspaceOneRoot = makeTempRoot('studio-workspace-one-')
    const workspaceTwoRoot = makeTempRoot('studio-workspace-two-')
    const siblingLink = join(workspaceTwoRoot, 'workspace-one-link')
    symlinkSync(workspaceOneRoot, siblingLink, 'dir')
    const source = {
      MC_STUDIO_WORKSPACE_ROOTS: JSON.stringify({
        1: workspaceOneRoot,
        2: workspaceTwoRoot,
      }),
    }

    // When
    const error = captureWorkspaceError(
      () => resolveStudioWorkspacePath(siblingLink, 2, source),
    )

    // Then
    expect(error.code).toBe('invalid_workspace_path')
  })

  it('fails closed when the workspace root mapping is malformed', () => {
    // Given
    const defaultRoot = makeTempRoot('studio-default-root-')
    const source = {
      MC_STUDIO_WORKSPACE_ROOTS: '{"2":',
      MC_WORKSPACE_ROOT: defaultRoot,
    }

    // When
    const error = captureWorkspaceError(
      () => resolveStudioWorkspacePath(defaultRoot, 1, source),
    )

    // Then
    expect(error.code).toBe('workspace_roots_invalid')
  })

  it('fails closed when workspace 2 is missing from a valid mapping', () => {
    // Given
    const workspaceOneRoot = makeTempRoot('studio-workspace-one-')
    const source = {
      MC_STUDIO_WORKSPACE_ROOTS: JSON.stringify({ 1: workspaceOneRoot }),
      MC_WORKSPACE_ROOT: workspaceOneRoot,
    }

    // When
    const error = captureWorkspaceError(
      () => resolveStudioWorkspacePath(workspaceOneRoot, 2, source),
    )

    // Then
    expect(error.code).toBe('workspace_root_not_configured')
  })

  it('keeps MC_WORKSPACE_ROOT as the workspace 1 quick-start fallback', () => {
    // Given
    const workspaceRoot = makeTempRoot('studio-default-root-')
    const project = join(workspaceRoot, 'project')
    mkdirSync(project)
    const source = { MC_WORKSPACE_ROOT: workspaceRoot }

    // When
    const resolved = resolveStudioWorkspacePath(project, 1, source)

    // Then
    expect(resolved).toBe(realpathSync(project))
  })

  it.runIf(process.platform === 'darwin')('accepts the same macOS path across NFC and NFD forms', () => {
    const workspaceRoot = makeTempRoot('studio-한글-root-')
    const source = { MC_WORKSPACE_ROOT: workspaceRoot.normalize('NFC') }

    const resolved = resolveStudioWorkspacePath(workspaceRoot.normalize('NFD'), 1, source)

    expect(resolved.normalize('NFC')).toBe(realpathSync(workspaceRoot).normalize('NFC'))
  })

  it('prefers the workspace 1 mapping over MC_WORKSPACE_ROOT', () => {
    // Given
    const defaultRoot = makeTempRoot('studio-default-root-')
    const mappedRoot = makeTempRoot('studio-mapped-root-')
    const project = join(mappedRoot, 'project')
    mkdirSync(project)
    const source = {
      MC_STUDIO_WORKSPACE_ROOTS: JSON.stringify({ 1: mappedRoot }),
      MC_WORKSPACE_ROOT: defaultRoot,
    }

    // When
    const resolved = resolveStudioWorkspacePath(project, 1, source)

    // Then
    expect(resolved).toBe(realpathSync(project))
  })

  it('maps a legacy null workspace path to the authenticated workspace root', () => {
    // Given
    const workspaceRoot = makeTempRoot('studio-legacy-root-')
    vi.stubEnv('MC_STUDIO_WORKSPACE_ROOTS', JSON.stringify({ 2: workspaceRoot }))
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        config TEXT,
        workspace_path TEXT,
        runtime_type TEXT NOT NULL,
        workspace_id INTEGER NOT NULL
      )
    `)
    db.prepare(`
      INSERT INTO agents (
        id, name, role, status, created_at, updated_at, config,
        workspace_path, runtime_type, workspace_id
      ) VALUES (1, 'Legacy agent', 'builder', 'offline', 1, 1, NULL, NULL, 'codex', 2)
    `).run()

    // When
    const agent = (() => {
      try {
        return getStudioAgent(db, 2, 1)
      } finally {
        db.close()
      }
    })()

    // Then
    expect(agent?.workspacePath).toBe(realpathSync(workspaceRoot))
  })

  it('rejects a file path inside the authenticated workspace root', () => {
    // Given
    const workspaceRoot = makeTempRoot('studio-root-')
    const filePath = join(workspaceRoot, 'not-a-directory')
    writeFileSync(filePath, 'fixture')
    const source = { MC_WORKSPACE_ROOT: workspaceRoot }

    // When
    const error = captureWorkspaceError(
      () => resolveStudioWorkspacePath(filePath, 1, source),
    )

    // Then
    expect(error.code).toBe('invalid_workspace_path')
  })

  it('forwards only Codex execution and authentication variables', () => {
    // Given
    const sourceEnv: Record<string, string | undefined> = {
      PATH: '/usr/bin',
      HOME: '/home/studio',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'codex-key',
      CODEX_HOME: '/home/studio/.codex',
      AUTH_PASS: 'server-password',
      AUTH_SECRET: 'signing-secret',
      MISSION_CONTROL_DB_PATH: '/srv/mission-control.db',
      SLACK_BOT_TOKEN: 'unrelated-token',
      AGENT_STUDIO_CODEX_BIN: '/opt/codex-wrapper',
    }

    // When
    const childEnv = buildStudioRuntimeEnv('codex', sourceEnv)

    // Then
    expect(childEnv).toEqual({
      NODE_ENV: 'production',
      PATH: '/usr/bin',
      HOME: '/home/studio',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'codex-key',
      CODEX_HOME: '/home/studio/.codex',
    })
  })
})
