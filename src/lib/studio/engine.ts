import { getDatabase } from '../db'
import { logger } from '../logger'
import { getStudioAgent } from './agent-store'
import { findReadyNodes } from './graph'
import {
  completeStudioRunCancellation,
  getStudioRun,
  getStudioRunWorkflowSnapshot,
  recordStudioRunEvent,
  requestStudioRunCancellation,
  transitionStudioRun,
  type StudioRunUpdate,
} from './run-store'
import {
  abortStudioRunController,
  acquireStudioRunController,
  releaseStudioRunController,
  runStudioAgentInvocation,
  setStudioRunControllerAgents,
} from './run-controller'
import { claimStudioRuntimeProcess } from './runtime-ownership'
import { runStudioRuntime } from './runtime-process'
import {
  reclaimStudioRunRuntimeProcesses,
  releaseReclaimedStudioAgents,
} from './run-reconciliation'
import {
  nodeStudioProcessRecoveryBoundary,
  type StudioProcessRecoveryBoundary,
} from './runtime-reaper'
import type {
  StudioAgent,
  StudioNodeStates,
  StudioRun,
  StudioRunStatus,
  StudioWorkflow,
  StudioWorkflowNode,
} from './schemas'

// allow: SIZE_OK — run orchestration is one CAS-backed lifecycle state machine.
const TERMINAL_RUN_STATUSES: readonly StudioRunStatus[] = ['completed', 'failed', 'cancelled']

function isTerminalRun(status: StudioRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}

function setRunState(run: StudioRun, update: StudioRunUpdate): StudioRun | null {
  if (!transitionStudioRun(getDatabase(), run, update)) return null
  return { ...run, ...update }
}

function buildAgentPrompt(
  agent: StudioAgent,
  node: Extract<StudioWorkflowNode, { kind: 'agent' }>,
  workflow: StudioWorkflow,
  run: StudioRun,
  states: StudioNodeStates,
): string {
  const predecessorOutput = workflow.edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => states[edge.source]?.output)
    .filter((output): output is string => Boolean(output))
    .join('\n\n')
  return [
    agent.instructions,
    `Workflow: ${workflow.name}`,
    `Your node: ${node.label}`,
    `Assignment: ${node.prompt}`,
    run.input ? `Run input:\n${run.input}` : '',
    predecessorOutput ? `Previous node output:\n${predecessorOutput}` : '',
    'Complete only this assignment. End with a concise result and verification evidence.',
  ].filter(Boolean).join('\n\n')
}

async function executeAgentNode(
  context: {
    readonly run: StudioRun
    readonly workflow: StudioWorkflow
    readonly states: StudioNodeStates
  },
  node: Extract<StudioWorkflowNode, { kind: 'agent' }>,
  signal: AbortSignal,
): Promise<{ nodeId: string; output: string; error: string | null }> {
  const { run, workflow, states } = context
  const db = getDatabase()
  const agent = getStudioAgent(db, run.workspaceId, node.agentId)
  if (!agent) return { nodeId: node.id, output: '', error: `Agent ${node.agentId} is unavailable` }
  return runStudioAgentInvocation(agent.id, {
    onStart: () => {
      if (signal.aborted) return
      db.prepare('UPDATE agents SET status = ?, updated_at = unixepoch() WHERE id = ?')
        .run('busy', agent.id)
      recordStudioRunEvent(
        db,
        run.workspaceId,
        run.id,
        node.id,
        'node.started',
        `${agent.name} started ${node.label}`,
      )
    },
    execute: async () => {
      signal.throwIfAborted()
      try {
        const ownership = claimStudioRuntimeProcess(db, {
          workspaceId: run.workspaceId,
          runId: run.id,
          nodeId: node.id,
          agentId: agent.id,
        })
        try {
          const output = await runStudioRuntime(
            {
              runtime: agent.runtime,
              prompt: buildAgentPrompt(agent, node, workflow, run, states),
              workspaceId: run.workspaceId,
              workspacePath: agent.workspacePath,
              model: agent.model ?? null,
            },
            {
              signal,
              ownership,
              onChunk: (chunk) => {
                recordStudioRunEvent(
                  db,
                  run.workspaceId,
                  run.id,
                  node.id,
                  `runtime.${chunk.kind}`,
                  chunk.text.slice(0, 8_000),
                )
              },
            },
          )
          return { nodeId: node.id, output, error: null }
        } finally {
          ownership.release()
        }
      } catch (error) {
        if (signal.aborted) throw error
        const message = error instanceof Error ? error.message : 'Runtime execution failed'
        return { nodeId: node.id, output: '', error: message }
      }
    },
    onIdle: () => {
      db.prepare('UPDATE agents SET status = ?, updated_at = unixepoch() WHERE id = ?')
        .run('idle', agent.id)
    },
  })
}

function completeAutomaticNodes(
  nodes: StudioWorkflowNode[],
  states: StudioNodeStates,
): StudioNodeStates {
  const completed = { ...states }
  for (const node of nodes.filter((candidate) => candidate.kind === 'start' || candidate.kind === 'finish')) {
    completed[node.id] = { status: 'completed', output: node.label, error: null }
  }
  return completed
}

async function executeStudioRun(
  runId: number,
  workspaceId: number,
  controller: AbortController,
): Promise<void> {
  const db = getDatabase()
  let run: StudioRun | null = null

  try {
    run = getStudioRun(db, workspaceId, runId)
    if (!run || isTerminalRun(run.status)) return
    const workflow = getStudioRunWorkflowSnapshot(db, workspaceId, run.id)
    if (!workflow) throw new Error('Workflow not found')
    setStudioRunControllerAgents(
      runId,
      controller,
      workflow.nodes.flatMap((node) => node.kind === 'agent' ? [node.agentId] : []),
    )
    const started = setRunState(run, { status: 'running', nodeStates: run.nodeStates, error: null })
    if (!started) return
    run = started
    recordStudioRunEvent(db, workspaceId, runId, null, 'run.started', `Started ${workflow.name}`)

    while (!controller.signal.aborted) {
      const ready = findReadyNodes(workflow, run.nodeStates)
      const automaticNodes = ready.filter(
        (node) => node.kind === 'start' || node.kind === 'finish',
      )
      if (automaticNodes.length > 0) {
        const updated = setRunState(run, {
          status: 'running',
          nodeStates: completeAutomaticNodes(automaticNodes, run.nodeStates),
          error: null,
        })
        if (!updated) return
        run = updated
        for (const node of automaticNodes) {
          recordStudioRunEvent(
            db,
            workspaceId,
            runId,
            node.id,
            'node.completed',
            `${node.label} completed`,
          )
        }
        continue
      }

      const agentNodes = ready.filter(
        (node): node is Extract<StudioWorkflowNode, { kind: 'agent' }> => node.kind === 'agent',
      )
      if (agentNodes.length > 0) {
        const runningStates = { ...run.nodeStates }
        for (const node of agentNodes) {
          runningStates[node.id] = { status: 'running', output: null, error: null }
        }
        const running = setRunState(run, { status: 'running', nodeStates: runningStates, error: null })
        if (!running) return
        run = running
        const executingRun = run
        const settledResults = await Promise.allSettled(
          agentNodes.map((node) => executeAgentNode(
            { run: executingRun, workflow, states: executingRun.nodeStates },
            node,
            controller.signal,
          )),
        )
        const results = settledResults.map((result) => {
          if (result.status === 'rejected') throw result.reason
          return result.value
        })
        const failed = results.find((result) => result.error)
        const resultStates = { ...run.nodeStates }
        for (const result of results) {
          resultStates[result.nodeId] = result.error
            ? { status: 'failed', output: null, error: result.error }
            : { status: 'completed', output: result.output, error: null }
        }
        const updated = setRunState(run, {
          status: failed ? 'failed' : 'running',
          nodeStates: resultStates,
          error: failed?.error ?? null,
        })
        if (!updated) return
        run = updated
        for (const result of results) {
          recordStudioRunEvent(
            db,
            workspaceId,
            runId,
            result.nodeId,
            result.error ? 'node.failed' : 'node.completed',
            result.error ?? 'Agent node completed',
          )
        }
        if (failed) return
        continue
      }

      const approval = ready.find((node) => node.kind === 'approval')
      if (approval) {
        const approvalStates = {
          ...run.nodeStates,
          [approval.id]: { status: 'waiting_approval', output: null, error: null },
        } satisfies StudioNodeStates
        const waiting = setRunState(run, {
          status: 'waiting_approval',
          nodeStates: approvalStates,
          error: null,
        })
        if (!waiting) return
        run = waiting
        recordStudioRunEvent(db, workspaceId, runId, approval.id, 'approval.requested', approval.label)
        return
      }

      if (Object.values(run.nodeStates).every((state) => state.status === 'completed')) {
        const completed = setRunState(run, {
          status: 'completed',
          nodeStates: run.nodeStates,
          error: null,
        })
        if (completed) {
          run = completed
          recordStudioRunEvent(db, workspaceId, runId, null, 'run.completed', 'Workflow completed')
        }
        return
      }
      run = setRunState(run, {
        status: 'failed',
        nodeStates: run.nodeStates,
        error: 'Workflow cannot make progress',
      })
      return
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : 'Workflow execution failed'
      if (run) {
        const failed = setRunState(run, { status: 'failed', nodeStates: run.nodeStates, error: message })
        if (failed) {
          run = failed
          recordStudioRunEvent(db, workspaceId, runId, null, 'run.failed', message)
        }
      }
      logger.error({ err: error, runId, workspaceId }, 'Agent Studio run failed')
    }
  } finally {
    releaseStudioRunController(runId, controller)
  }
}

export function queueStudioRun(runId: number, workspaceId: number): void {
  const controller = acquireStudioRunController(runId)
  if (!controller) return
  void executeStudioRun(runId, workspaceId, controller)
}

export function approveStudioRun(run: StudioRun): boolean {
  if (run.status !== 'waiting_approval') return false
  const approvals = Object.entries(run.nodeStates)
    .filter(([, state]) => state.status === 'waiting_approval')
  if (approvals.length === 0) return false
  const states = { ...run.nodeStates }
  for (const [nodeId] of approvals) {
    states[nodeId] = { status: 'completed', output: 'Approved', error: null }
  }
  if (!setRunState(run, { status: 'running', nodeStates: states, error: null })) return false
  recordStudioRunEvent(getDatabase(), run.workspaceId, run.id, approvals[0]?.[0] ?? null, 'approval.granted', 'Approved')
  queueStudioRun(run.id, run.workspaceId)
  return true
}

async function cancelActiveStudioRun(
  run: StudioRun,
  recoveryBoundary: StudioProcessRecoveryBoundary,
): Promise<boolean> {
  const db = getDatabase()
  if (!requestStudioRunCancellation(db, run)) return false
  const completion = abortStudioRunController(run.id)
  let orphanedAgentIds: readonly number[] | null = null
  if (completion) {
    await completion
  } else {
    orphanedAgentIds = reclaimStudioRunRuntimeProcesses(db, {
      workspaceId: run.workspaceId,
      runId: run.id,
      boundary: recoveryBoundary,
    })
    if (orphanedAgentIds === null) return false
  }
  if (isTerminalRun(run.status)) return false
  const states = { ...run.nodeStates }
  for (const [nodeId, state] of Object.entries(run.nodeStates)) {
    if (state.status !== 'completed') states[nodeId] = { status: 'cancelled', output: null, error: null }
  }
  if (!completeStudioRunCancellation(db, run, states)) return false
  if (orphanedAgentIds) {
    releaseReclaimedStudioAgents(db, run.workspaceId, orphanedAgentIds)
  }
  recordStudioRunEvent(db, run.workspaceId, run.id, null, 'run.cancelled', 'Run cancelled')
  return true
}

export function cancelStudioRun(
  run: StudioRun,
  recoveryBoundary: StudioProcessRecoveryBoundary = nodeStudioProcessRecoveryBoundary,
): boolean | Promise<boolean> {
  if (isTerminalRun(run.status)) return false
  return cancelActiveStudioRun(run, recoveryBoundary)
}
