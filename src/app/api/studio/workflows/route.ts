import { NextRequest, NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { mutationLimiter } from '@/lib/rate-limit'
import { parseStudioBody, studioMutationError } from '@/lib/studio/http'
import { studioWorkflowWriteSchema } from '@/lib/studio/schemas'
import { listStudioWorkflows, saveStudioWorkflow } from '@/lib/studio/workflow-store'

export function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json({ workflows: listStudioWorkflows(getDatabase(), auth.user.workspace_id) })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = await parseStudioBody(request, studioWorkflowWriteSchema)
  if ('error' in parsed) return parsed.error
  try {
    const workflow = saveStudioWorkflow(getDatabase(), auth.user.workspace_id, parsed.data, null)
    eventBus.broadcast('studio.updated', {
      workspace_id: auth.user.workspace_id,
      entity: 'workflow',
      id: workflow.id,
    })
    return NextResponse.json({ workflow }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/studio/workflows failed')
    return studioMutationError(error, 'Failed to create workflow')
  }
}
