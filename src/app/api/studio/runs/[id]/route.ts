import { NextRequest, NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { getStudioRun, listStudioRunEvents } from '@/lib/studio/run-store'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const runId = Number((await params).id)
  if (!Number.isInteger(runId)) return NextResponse.json({ error: 'Invalid run id' }, { status: 400 })
  const db = getDatabase()
  const run = getStudioRun(db, auth.user.workspace_id, runId)
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  const events = listStudioRunEvents(db, auth.user.workspace_id, runId)
  return NextResponse.json({ run, events })
}
