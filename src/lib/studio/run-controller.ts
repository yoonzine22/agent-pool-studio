const globalControllers = globalThis as typeof globalThis & {
  __studioRunControllers?: Map<number, AbortController>
  __studioRunCompletions?: Map<number, StudioRunCompletion>
  __studioRunAgents?: Map<number, ReadonlySet<number>>
  __studioAgentTails?: Map<number, Promise<void>>
  __studioAgentPending?: Map<number, number>
}

interface StudioRunCompletion {
  readonly controller: AbortController
  readonly promise: Promise<void>
  readonly resolve: () => void
}

const controllers = globalControllers.__studioRunControllers ?? new Map<number, AbortController>()
const completions = globalControllers.__studioRunCompletions ?? new Map<number, StudioRunCompletion>()
const runAgents = globalControllers.__studioRunAgents ?? new Map<number, ReadonlySet<number>>()
const agentTails = globalControllers.__studioAgentTails ?? new Map<number, Promise<void>>()
const agentPending = globalControllers.__studioAgentPending ?? new Map<number, number>()
globalControllers.__studioRunControllers = controllers
globalControllers.__studioRunCompletions = completions
globalControllers.__studioRunAgents = runAgents
globalControllers.__studioAgentTails = agentTails
globalControllers.__studioAgentPending = agentPending

export interface StudioAgentInvocation<T> {
  readonly onStart: () => void
  readonly execute: () => Promise<T>
  readonly onIdle: () => void
}

export function acquireStudioRunController(runId: number): AbortController | null {
  if (controllers.has(runId)) return null
  const controller = new AbortController()
  let complete = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    complete = resolve
  })
  controllers.set(runId, controller)
  completions.set(runId, { controller, promise, resolve: complete })
  return controller
}

export function getStudioRunController(runId: number): AbortController | null {
  return controllers.get(runId) ?? null
}

export function hasStudioRunController(runId: number): boolean {
  return controllers.has(runId)
}

export function abortStudioRunController(runId: number): Promise<void> | null {
  const completion = completions.get(runId)
  if (!completion) return null
  completion.controller.abort()
  return completion.promise
}

export function setStudioRunControllerAgents(
  runId: number,
  controller: AbortController,
  agentIds: readonly number[],
): void {
  if (controllers.get(runId) !== controller) return
  runAgents.set(runId, new Set(agentIds))
}

export function isStudioAgentOwnedByLiveController(agentId: number): boolean {
  return [...runAgents.values()].some((agentIds) => agentIds.has(agentId))
}

export function releaseStudioRunController(runId: number, controller: AbortController): void {
  if (controllers.get(runId) !== controller) return
  const completion = completions.get(runId)
  controllers.delete(runId)
  completions.delete(runId)
  runAgents.delete(runId)
  completion?.resolve()
}

export async function runStudioAgentInvocation<T>(
  agentId: number,
  invocation: StudioAgentInvocation<T>,
): Promise<T> {
  const previous = agentTails.get(agentId) ?? Promise.resolve()
  let releaseTurn = (): void => undefined
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  const tail = previous.then(() => turn)
  agentTails.set(agentId, tail)
  agentPending.set(agentId, (agentPending.get(agentId) ?? 0) + 1)

  await previous
  try {
    invocation.onStart()
    return await invocation.execute()
  } finally {
    const remaining = (agentPending.get(agentId) ?? 1) - 1
    if (remaining === 0) agentPending.delete(agentId)
    else agentPending.set(agentId, remaining)
    releaseTurn()
    if (agentTails.get(agentId) === tail) agentTails.delete(agentId)
    if (remaining === 0) invocation.onIdle()
  }
}
