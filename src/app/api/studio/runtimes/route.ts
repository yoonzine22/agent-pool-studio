import { NextRequest, NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth'
import { studioMutationError } from '@/lib/studio/http'
import { getStudioRuntimeReadiness } from '@/lib/studio/runtime-process'
import { getStudioWorkspaceRoot } from '@/lib/studio/runtime-security'

export function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    return NextResponse.json({
      runtimes: [getStudioRuntimeReadiness('codex'), getStudioRuntimeReadiness('antigravity')],
      workspacePath: getStudioWorkspaceRoot(auth.user.workspace_id),
    })
  } catch (error) {
    return studioMutationError(error, 'Failed to resolve Agent Studio workspace')
  }
}
