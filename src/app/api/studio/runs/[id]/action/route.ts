import { NextRequest, NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { mutationLimiter } from '@/lib/rate-limit'
import { approveStudioRun, cancelStudioRun } from '@/lib/studio/engine'
import { parseStudioBody } from '@/lib/studio/http'
import { getStudioRun } from '@/lib/studio/run-store'
import { studioRunActionSchema } from '@/lib/studio/schemas'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = await parseStudioBody(request, studioRunActionSchema)
  if ('error' in parsed) return parsed.error
  const runId = Number((await params).id)
  if (!Number.isInteger(runId)) return NextResponse.json({ error: 'Invalid run id' }, { status: 400 })
  const run = getStudioRun(getDatabase(), auth.user.workspace_id, runId)
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })

  if (parsed.data.action === 'approve') {
    if (!approveStudioRun(run)) {
      return NextResponse.json({ error: 'Run is not waiting for approval' }, { status: 409 })
    }
  } else {
    if (!await cancelStudioRun(run)) {
      return NextResponse.json({ error: 'Run cannot be cancelled' }, { status: 409 })
    }
  }
  return NextResponse.json({ success: true })
}
