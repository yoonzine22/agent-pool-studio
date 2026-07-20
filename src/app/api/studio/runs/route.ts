import { NextRequest, NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { mutationLimiter } from '@/lib/rate-limit'
import { queueStudioRun } from '@/lib/studio/engine'
import { parseStudioBody } from '@/lib/studio/http'
import { createStudioRun, listStudioRuns } from '@/lib/studio/run-store'
import { studioRunCreateSchema } from '@/lib/studio/schemas'
import { getStudioWorkflow } from '@/lib/studio/workflow-store'

export function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  return NextResponse.json({ runs: listStudioRuns(getDatabase(), auth.user.workspace_id) })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = await parseStudioBody(request, studioRunCreateSchema)
  if ('error' in parsed) return parsed.error
  const db = getDatabase()
  const workflow = getStudioWorkflow(db, auth.user.workspace_id, parsed.data.workflowId)
  if (!workflow) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
  const run = createStudioRun(
    db,
    auth.user.workspace_id,
    workflow,
    parsed.data.input,
    auth.user.username,
  )
  queueStudioRun(run.id, auth.user.workspace_id)
  return NextResponse.json({ run }, { status: 202 })
}
