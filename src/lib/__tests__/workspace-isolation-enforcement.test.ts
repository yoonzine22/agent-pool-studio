import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  memoryDir: '/tmp/mission-control-isolation-test',
  auditEvents: [] as unknown[],
}))

vi.mock('@/lib/config', () => ({
  config: {
    get memoryDir() { return state.memoryDir },
  },
}))

vi.mock('@/lib/db', () => ({
  getDatabase: () => state.db,
  logAuditEvent: (event: unknown) => state.auditEvents.push(event),
}))

import type { User } from '@/lib/auth'
import { rebuildIndex, searchMemory } from '@/lib/memory-search'
import {
  denyUnscopedResourceForStrictWorkspace,
  resolveWorkspaceMemoryAccess,
} from '@/lib/workspace-isolation'

const sharedUser = {
  id: 1,
  username: 'shared-user',
  role: 'admin',
  workspace_id: 1,
  tenant_id: 10,
} as User

const strictUser = {
  id: 2,
  username: 'strict-user',
  role: 'admin',
  workspace_id: 2,
  tenant_id: 10,
} as User

let tempRoot = ''

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'mc-isolation-'))
  state.memoryDir = tempRoot
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, isolation TEXT NOT NULL);
    INSERT INTO workspaces (id, tenant_id, isolation) VALUES (1, 10, 'shared'), (2, 10, 'strict');
  `)
})

afterAll(() => {
  state.db?.close()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('workspace isolation policy', () => {
  it('keeps shared memory on the common root and scopes strict memory by workspace', () => {
    expect(resolveWorkspaceMemoryAccess(sharedUser)).toEqual({
      isolation: 'shared',
      root: tempRoot,
      scope: 'shared',
    })
    expect(resolveWorkspaceMemoryAccess(strictUser)).toEqual({
      isolation: 'strict',
      root: join(tempRoot + '-workspaces', '2'),
      scope: 'workspace:2',
    })
  })

  it('allows shared workspaces but denies unowned resources to strict workspaces', async () => {
    expect(denyUnscopedResourceForStrictWorkspace(sharedUser, 'local_sessions', '/api/sessions')).toBeNull()

    const denied = denyUnscopedResourceForStrictWorkspace(strictUser, 'local_sessions', '/api/sessions')
    expect(denied?.status).toBe(403)
    expect(await denied?.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining('no workspace ownership metadata'),
    }))
    expect(state.auditEvents).toContainEqual(expect.objectContaining({
      action: 'workspace_isolation_denied',
      target_id: 2,
      detail: expect.objectContaining({
        resource: 'local_sessions',
        route: '/api/sessions',
      }),
    }))
  })

  it('fails closed when workspace and tenant context do not match', () => {
    const mismatched = { ...strictUser, tenant_id: 999 }
    const denied = denyUnscopedResourceForStrictWorkspace(mismatched, 'session_transcripts', '/api/sessions/transcript')
    expect(denied?.status).toBe(403)
    expect(resolveWorkspaceMemoryAccess(mismatched)).toBeNull()
  })
})

describe('workspace-scoped memory search', () => {
  it('keeps FTS rows and metadata isolated by scope', async () => {
    const sharedRoot = join(tempRoot, 'shared-fixture')
    const strictRoot = join(tempRoot, 'strict-fixture')
    mkdirSync(sharedRoot, { recursive: true })
    mkdirSync(strictRoot, { recursive: true })
    writeFileSync(join(sharedRoot, 'shared.md'), '# Shared\n\nsharedonlytoken')
    writeFileSync(join(strictRoot, 'strict.md'), '# Strict\n\nstrictonlytoken')

    await rebuildIndex(sharedRoot, [], 'shared')
    await rebuildIndex(strictRoot, [], 'workspace:2')

    const strictOwn = await searchMemory(strictRoot, [], 'strictonlytoken', { scope: 'workspace:2' })
    const strictLeak = await searchMemory(strictRoot, [], 'sharedonlytoken', { scope: 'workspace:2' })
    const sharedOwn = await searchMemory(sharedRoot, [], 'sharedonlytoken', { scope: 'shared' })

    expect(strictOwn.results.map((row) => row.path)).toEqual(['strict.md'])
    expect(strictLeak.results).toEqual([])
    expect(sharedOwn.results.map((row) => row.path)).toEqual(['shared.md'])
    expect(strictOwn.indexedFiles).toBe(1)
    expect(sharedOwn.indexedFiles).toBe(1)
  })
})

describe('direct session API coverage', () => {
  it('guards every deployment-global session route', () => {
    const files = [
      'src/app/api/sessions/route.ts',
      'src/app/api/sessions/continue/route.ts',
      'src/app/api/sessions/[id]/control/route.ts',
      'src/lib/session-transcript-route.ts',
      'src/app/api/sessions/transcript/gateway/route.ts',
      'src/app/api/sessions/transcript/aggregate/route.ts',
      'src/app/api/claude/sessions/route.ts',
      'src/app/api/chat/session-prefs/route.ts',
    ]

    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source, file).toContain('denyUnscopedResourceForStrictWorkspace')
    }
  })
})
