import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { StudioTeam, StudioTeamWrite } from './schemas'
import { toIsoDate } from './store-utils'

const teamRowSchema = z.object({
  id: z.number().int().positive(),
  workspace_id: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
})

const memberRowSchema = z.object({
  team_id: z.number().int().positive(),
  agent_id: z.number().int().positive(),
})

export function listStudioTeams(db: Database.Database, workspaceId: number): StudioTeam[] {
  const teams = z.array(teamRowSchema).parse(db.prepare(`
    SELECT id, workspace_id, name, description, created_at, updated_at
    FROM agent_teams WHERE workspace_id = ? ORDER BY created_at DESC
  `).all(workspaceId))
  const members = z.array(memberRowSchema).parse(db.prepare(`
    SELECT tm.team_id, tm.agent_id
    FROM agent_team_members tm
    JOIN agent_teams t ON t.id = tm.team_id
    WHERE t.workspace_id = ? ORDER BY tm.position ASC
  `).all(workspaceId))

  return teams.map((team) => ({
    id: team.id,
    workspaceId: team.workspace_id,
    name: team.name,
    description: team.description,
    agentIds: members.filter((member) => member.team_id === team.id).map((member) => member.agent_id),
    createdAt: toIsoDate(team.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoDate(team.updated_at) ?? new Date(0).toISOString(),
  }))
}

function assertAgentsBelongToWorkspace(
  db: Database.Database,
  workspaceId: number,
  agentIds: number[],
): void {
  const placeholders = agentIds.map(() => '?').join(', ')
  const row = z.object({ count: z.number().int() }).parse(db.prepare(`
    SELECT COUNT(*) AS count FROM agents
    WHERE workspace_id = ? AND id IN (${placeholders})
      AND runtime_type IN ('codex', 'antigravity')
  `).get(workspaceId, ...agentIds))
  if (row.count !== agentIds.length) throw new Error('Team contains an unavailable agent')
}

function assertTeamIsNotReferenced(
  db: Database.Database,
  workspaceId: number,
  teamId: number,
  operation: 'update' | 'delete',
): void {
  const workflow = z.object({ id: z.number().int().positive() }).optional().parse(db.prepare(`
    SELECT id
    FROM agent_workflows
    WHERE workspace_id = ? AND team_id = ?
    LIMIT 1
  `).get(workspaceId, teamId))
  if (workflow) {
    throw new Error(
      `Cannot ${operation} team ${teamId}: saved workflow ${workflow.id} references this team`,
    )
  }
}

export function saveStudioTeam(
  db: Database.Database,
  workspaceId: number,
  input: StudioTeamWrite,
  teamId: number | null,
): StudioTeam {
  assertAgentsBelongToWorkspace(db, workspaceId, input.agentIds)
  const now = Math.floor(Date.now() / 1_000)
  const id = db.transaction(() => {
    if (teamId === null) {
      const result = db.prepare(`
        INSERT INTO agent_teams (workspace_id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(workspaceId, input.name, input.description, now, now)
      teamId = Number(result.lastInsertRowid)
    } else {
      assertTeamIsNotReferenced(db, workspaceId, teamId, 'update')
      const result = db.prepare(`
        UPDATE agent_teams SET name = ?, description = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?
      `).run(input.name, input.description, now, teamId, workspaceId)
      if (result.changes === 0) throw new Error('Team not found')
      db.prepare('DELETE FROM agent_team_members WHERE team_id = ?').run(teamId)
    }
    const insert = db.prepare(`
      INSERT INTO agent_team_members (team_id, agent_id, position) VALUES (?, ?, ?)
    `)
    input.agentIds.forEach((agentId, position) => insert.run(teamId, agentId, position))
    return teamId
  })()

  const team = listStudioTeams(db, workspaceId).find((candidate) => candidate.id === id)
  if (!team) throw new Error('Saved team could not be loaded')
  return team
}

export function deleteStudioTeam(db: Database.Database, workspaceId: number, teamId: number): boolean {
  return db.transaction(() => {
    assertTeamIsNotReferenced(db, workspaceId, teamId, 'delete')
    return db.prepare('DELETE FROM agent_teams WHERE id = ? AND workspace_id = ?')
      .run(teamId, workspaceId).changes > 0
  })()
}
