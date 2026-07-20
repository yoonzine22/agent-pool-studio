import { NextRequest, NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { mutationLimiter } from '@/lib/rate-limit'
import { parseStudioBody, studioMutationError } from '@/lib/studio/http'
import { studioTeamWriteSchema } from '@/lib/studio/schemas'
import { deleteStudioTeam, saveStudioTeam } from '@/lib/studio/team-store'

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = await parseStudioBody(request, studioTeamWriteSchema)
  if ('error' in parsed) return parsed.error
  const teamId = Number((await params).id)
  if (!Number.isInteger(teamId)) return NextResponse.json({ error: 'Invalid team id' }, { status: 400 })
  try {
    const team = saveStudioTeam(getDatabase(), auth.user.workspace_id, parsed.data, teamId)
    eventBus.broadcast('studio.updated', { workspace_id: auth.user.workspace_id, entity: 'team', id: teamId })
    return NextResponse.json({ team })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/studio/teams failed')
    return studioMutationError(error, 'Failed to update team')
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const teamId = Number((await params).id)
  if (!Number.isInteger(teamId)) return NextResponse.json({ error: 'Invalid team id' }, { status: 400 })
  try {
    const deleted = deleteStudioTeam(getDatabase(), auth.user.workspace_id, teamId)
    if (!deleted) return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    eventBus.broadcast('studio.updated', { workspace_id: auth.user.workspace_id, entity: 'team', id: teamId })
    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/studio/teams/[id] failed')
    return studioMutationError(error, 'Failed to delete team')
  }
}
