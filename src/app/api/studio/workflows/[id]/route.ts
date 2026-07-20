import { NextRequest, NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { mutationLimiter } from '@/lib/rate-limit'
import { parseStudioBody, studioMutationError } from '@/lib/studio/http'
import { studioWorkflowWriteSchema } from '@/lib/studio/schemas'
import { deleteStudioWorkflow, saveStudioWorkflow } from '@/lib/studio/workflow-store'

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = await parseStudioBody(request, studioWorkflowWriteSchema)
  if ('error' in parsed) return parsed.error
  const workflowId = Number((await params).id)
  if (!Number.isInteger(workflowId)) {
    return NextResponse.json({ error: 'Invalid workflow id' }, { status: 400 })
  }
  try {
    const workflow = saveStudioWorkflow(
      getDatabase(),
      auth.user.workspace_id,
      parsed.data,
      workflowId,
    )
    eventBus.broadcast('studio.updated', {
      workspace_id: auth.user.workspace_id,
      entity: 'workflow',
      id: workflowId,
    })
    return NextResponse.json({ workflow })
  } catch (error) {
    logger.error({ err: error }, 'PUT /api/studio/workflows failed')
    return studioMutationError(error, 'Failed to update workflow')
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
  const workflowId = Number((await params).id)
  if (!Number.isInteger(workflowId)) {
    return NextResponse.json({ error: 'Invalid workflow id' }, { status: 400 })
  }
  try {
    const deleted = deleteStudioWorkflow(getDatabase(), auth.user.workspace_id, workflowId)
    if (!deleted) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
    eventBus.broadcast('studio.updated', {
      workspace_id: auth.user.workspace_id,
      entity: 'workflow',
      id: workflowId,
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/studio/workflows/[id] failed')
    return studioMutationError(error, 'Failed to delete workflow')
  }
}
