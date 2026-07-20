import { NextRequest, NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { mutationLimiter } from '@/lib/rate-limit'
import { createStudioAgent, listStudioAgents } from '@/lib/studio/agent-store'
import { parseStudioBody, studioMutationError } from '@/lib/studio/http'
import { studioAgentCreateSchema } from '@/lib/studio/schemas'

export function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json({ agents: listStudioAgents(getDatabase(), auth.user.workspace_id) })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = await parseStudioBody(request, studioAgentCreateSchema)
  if ('error' in parsed) return parsed.error

  try {
    const agent = createStudioAgent(getDatabase(), auth.user.workspace_id, parsed.data)
    eventBus.broadcast('agent.created', { workspace_id: auth.user.workspace_id, ...agent })
    return NextResponse.json({ agent }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/studio/agents failed')
    return studioMutationError(error, 'Failed to create agent')
  }
}
