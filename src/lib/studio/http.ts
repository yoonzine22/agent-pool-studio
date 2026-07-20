import { NextResponse } from 'next/server'
import { z } from 'zod'

import { StudioWorkspaceError } from './runtime-security'

export async function parseStudioBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ data: T } | { error: NextResponse }> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { error: NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 }) }
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return {
      error: NextResponse.json(
        { error: parsed.error.issues.map((issue) => issue.message).join('; ') },
        { status: 400 },
      ),
    }
  }
  return { data: parsed.data }
}

export function studioMutationError(error: unknown, fallback: string): NextResponse {
  if (error instanceof StudioWorkspaceError) {
    const configurationErrors = new Set([
      'workspace_roots_invalid',
      'workspace_root_not_configured',
      'workspace_root_invalid',
    ])
    const status = configurationErrors.has(error.code) ? 503 : 400
    return NextResponse.json({ error: error.message }, { status })
  }
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
    return NextResponse.json({ error: 'That name is already in use.' }, { status: 409 })
  }
  if (error instanceof Error && /Cannot (delete|update)/.test(error.message)) {
    return NextResponse.json({ error: error.message }, { status: 409 })
  }
  const knownMessages = [
    'unavailable agent',
    'outside the selected team',
    'must contain',
    'contains a cycle',
    'contains duplicate',
    'references missing node',
    'is unreachable',
    'cannot reach the finish',
    'no path from the start',
    'not found',
    'cannot make progress',
  ]
  if (error instanceof Error && knownMessages.some((message) => error.message.includes(message))) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  return NextResponse.json({ error: fallback }, { status: 500 })
}
