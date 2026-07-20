import { NextRequest, NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { mutationLimiter } from '@/lib/rate-limit'
import { deleteStudioAgent } from '@/lib/studio/agent-store'
import { studioMutationError } from '@/lib/studio/http'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const agentId = Number((await params).id)
  if (!Number.isInteger(agentId)) {
    return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 })
  }
  try {
    const deleted = deleteStudioAgent(getDatabase(), auth.user.workspace_id, agentId)
    if (!deleted) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    eventBus.broadcast('agent.deleted', { workspace_id: auth.user.workspace_id, id: agentId })
    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/studio/agents/[id] failed')
    return studioMutationError(error, 'Failed to delete agent')
  }
}
