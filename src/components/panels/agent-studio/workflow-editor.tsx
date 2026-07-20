'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import type {
  StudioAgent,
  StudioTeam,
  StudioWorkflow,
  StudioWorkflowEdge,
  StudioWorkflowNode,
  StudioWorkflowWrite,
} from '@/lib/studio/schemas'
import { saveWorkflow, startRun } from './studio-client'
import { fieldClass, StudioPanel, textAreaClass } from './studio-ui'
import { WorkflowCanvas } from './workflow-canvas'
import { WorkflowInspector } from './workflow-inspector'
import { createStarterGraph } from './workflow-template'

interface WorkflowEditorProps {
  agents: StudioAgent[]
  teams: StudioTeam[]
  workflows: StudioWorkflow[]
  onChanged: () => Promise<void>
  onRunStarted: (runId: number) => void
  onError: (message: string | null) => void
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  const initialized = useRef(false)
  const [workflowId, setWorkflowId] = useState<number | null>(null)
  const [name, setName] = useState('Untitled workflow')
  const [description, setDescription] = useState('')
  const [teamId, setTeamId] = useState<number | null>(null)
  const [nodes, setNodes] = useState<StudioWorkflowNode[]>([])
  const [edges, setEdges] = useState<StudioWorkflowEdge[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [edgeSource, setEdgeSource] = useState('')
  const [edgeTarget, setEdgeTarget] = useState('')
  const [runInput, setRunInput] = useState('')
  const [saving, setSaving] = useState(false)

  const team = props.teams.find((candidate) => candidate.id === teamId) ?? null
  const teamAgents = useMemo(
    () => props.agents.filter((agent) => team?.agentIds.includes(agent.id)),
    [props.agents, team],
  )
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null

  useEffect(() => {
    if (initialized.current || props.workflows.length === 0) return
    initialized.current = true
    loadWorkflow(props.workflows[0])
  }, [props.workflows])

  useEffect(() => {
    setEdgeSource((current) => nodes.some((node) => node.id === current) ? current : nodes[0]?.id ?? '')
    setEdgeTarget((current) => nodes.some((node) => node.id === current) ? current : nodes[1]?.id ?? '')
  }, [nodes])

  function loadWorkflow(workflow: StudioWorkflow) {
    setWorkflowId(workflow.id)
    setName(workflow.name)
    setDescription(workflow.description)
    setTeamId(workflow.teamId)
    setNodes(workflow.nodes)
    setEdges(workflow.edges)
    setSelectedNodeId(null)
  }

  function beginNew() {
    const firstTeam = props.teams[0]
    setWorkflowId(null)
    setName('Untitled workflow')
    setDescription('')
    setSelectedNodeId(null)
    if (!firstTeam) {
      setTeamId(null)
      setNodes([])
      setEdges([])
      return
    }
    setTeamId(firstTeam.id)
    const starter = createStarterGraph(firstTeam, props.agents)
    setNodes(starter.nodes)
    setEdges(starter.edges)
  }

  function selectTeam(nextTeamId: number) {
    const nextTeam = props.teams.find((candidate) => candidate.id === nextTeamId)
    if (!nextTeam) return
    setTeamId(nextTeamId)
    const starter = createStarterGraph(nextTeam, props.agents)
    setNodes(starter.nodes)
    setEdges(starter.edges)
    setSelectedNodeId(null)
  }

  function addAgentNode() {
    const agent = teamAgents[0]
    if (!agent) return
    const id = crypto.randomUUID()
    setNodes((current) => [...current, {
      id,
      kind: 'agent',
      label: agent.role,
      agentId: agent.id,
      prompt: `Act as ${agent.role} and complete this workflow step.`,
      position: { x: 224, y: current.length * 104 },
    }])
    setSelectedNodeId(id)
  }

  function addApprovalNode() {
    const id = crypto.randomUUID()
    setNodes((current) => [...current, {
      id,
      kind: 'approval',
      label: 'Human approval',
      position: { x: 424, y: current.length * 64 },
    }])
    setSelectedNodeId(id)
  }

  function updateNode(updated: StudioWorkflowNode) {
    setNodes((current) => current.map((node) => node.id === updated.id ? updated : node))
  }

  function deleteNode(nodeId: string) {
    setNodes((current) => current.filter((node) => node.id !== nodeId))
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
    setSelectedNodeId(null)
  }

  function moveNode(nodeId: string, direction: -1 | 1) {
    setNodes((current) => {
      const currentIndex = current.findIndex((node) => node.id === nodeId)
      const nextIndex = currentIndex + direction
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= current.length) return current
      const reordered = [...current]
      ;[reordered[currentIndex], reordered[nextIndex]] = [reordered[nextIndex], reordered[currentIndex]]
      return reordered
    })
  }

  function addAccessibleEdge() {
    if (!edgeSource || !edgeTarget || edgeSource === edgeTarget) {
      props.onError('Choose two different nodes to connect.')
      return
    }
    if (edges.some((edge) => edge.source === edgeSource && edge.target === edgeTarget)) {
      props.onError('Those nodes are already connected.')
      return
    }
    props.onError(null)
    setEdges((current) => [
      ...current,
      { id: crypto.randomUUID(), source: edgeSource, target: edgeTarget },
    ])
  }

  async function persist(): Promise<StudioWorkflow | null> {
    if (teamId === null) {
      props.onError('Create and select a team first.')
      return null
    }
    setSaving(true)
    props.onError(null)
    const payload: StudioWorkflowWrite = { name, description, teamId, nodes, edges }
    try {
      const saved = await saveWorkflow(payload, workflowId)
      setWorkflowId(saved.id)
      await props.onChanged()
      return saved
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Failed to save workflow')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function runWorkflow() {
    const saved = await persist()
    if (!saved) return
    try {
      const run = await startRun(saved.id, runInput)
      props.onRunStarted(run.id)
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Failed to start workflow')
    }
  }

  return (
    <div className="space-y-4 xl:space-y-3">
      <StudioPanel className="p-4 xl:p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 text-xs text-foreground/80">Workflow
            <select className={`${fieldClass} mt-1 xl:mt-0.5 xl:h-8`} value={workflowId ?? ''} onChange={(event) => {
              const selected = props.workflows.find((workflow) => workflow.id === Number(event.target.value))
              if (selected) loadWorkflow(selected)
            }}>
              <option value="" disabled>Unsaved workflow</option>
              {props.workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
            </select>
          </label>
          <label className="min-w-44 flex-1 text-xs text-foreground/80">Team
            <select className={`${fieldClass} mt-1 xl:mt-0.5 xl:h-8`} value={teamId ?? ''} onChange={(event) => selectTeam(Number(event.target.value))}>
              <option value="" disabled>Select team</option>
              {props.teams.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>
          <Button variant="outline" onClick={beginNew}>New</Button>
          <Button variant="outline" onClick={addAgentNode} disabled={teamAgents.length === 0}>Add agent</Button>
          <Button variant="outline" onClick={addApprovalNode} disabled={teamId === null}>Add approval</Button>
          <Button onClick={() => void persist()} disabled={saving || nodes.length === 0}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </StudioPanel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-3">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:gap-2">
            <label className="text-xs text-foreground/80">Name
              <input className={`${fieldClass} mt-1 xl:mt-0.5 xl:h-8`} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="text-xs text-foreground/80">Description
              <input className={`${fieldClass} mt-1 xl:mt-0.5 xl:h-8`} value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
          </div>
          {nodes.length > 0 ? (
            <WorkflowCanvas nodes={nodes} edges={edges} agents={props.agents} selectedNodeId={selectedNodeId} onNodesChange={setNodes} onEdgesChange={setEdges} onSelectNode={setSelectedNodeId} />
          ) : (
            <StudioPanel className="flex h-[520px] items-center justify-center border-dashed text-center xl:h-[440px] 2xl:h-[520px]">
              <div><p className="text-sm text-foreground">No workflow graph yet.</p><p className="mt-1 text-sm text-foreground/80">Create a team, then start a new workflow.</p></div>
            </StudioPanel>
          )}
        </div>

        <div className="space-y-3">
          <WorkflowInspector node={selectedNode} agents={teamAgents} onChange={updateNode} onDelete={deleteNode} />
          <StudioPanel className="p-4">
            <label className="text-xs font-medium text-foreground">Run input
              <textarea className={`${textAreaClass} mt-2 min-h-28 resize-y`} value={runInput} onChange={(event) => setRunInput(event.target.value)} placeholder="Describe the outcome this team should produce." />
            </label>
            <Button className="mt-3 w-full" onClick={() => void runWorkflow()} disabled={saving || nodes.length === 0}>Save and run</Button>
          </StudioPanel>
          <StudioPanel className="p-4">
            <p className="font-mono text-xs text-foreground/80">Keyboard graph editor</p>
            <ol className="mt-3 space-y-2">
              {nodes.map((node, index) => (
                <li key={node.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-pressed={selectedNodeId === node.id}
                    onClick={() => setSelectedNodeId(node.id)}
                    className="flex min-w-0 flex-1 gap-2 rounded px-1 py-1 text-left text-sm text-foreground transition-colors hover:bg-secondary aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:ring-1 aria-pressed:ring-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    <span className="font-mono text-foreground/80">{String(index + 1).padStart(2, '0')}</span>
                    <span className="break-words">{node.label}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${node.label} up`}
                    title="Move node up"
                    disabled={index === 0}
                    onClick={() => moveNode(node.id, -1)}
                    className="h-8 w-8 rounded text-sm text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${node.label} down`}
                    title="Move node down"
                    disabled={index === nodes.length - 1}
                    onClick={() => moveNode(node.id, 1)}
                    className="h-8 w-8 rounded text-sm text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    ↓
                  </button>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs font-medium text-foreground/80">Connections</p>
            <ul className="mt-2 space-y-2">
              {edges.map((edge) => {
                const source = nodes.find((node) => node.id === edge.source)
                const target = nodes.find((node) => node.id === edge.target)
                return (
                  <li key={edge.id} className="flex items-center justify-between gap-2 text-sm text-foreground">
                    <span>{source?.label ?? edge.source} → {target?.label ?? edge.target}</span>
                    <button
                      type="button"
                      aria-label={`Remove connection from ${source?.label ?? edge.source} to ${target?.label ?? edge.target}`}
                      onClick={() => setEdges((current) => current.filter((candidate) => candidate.id !== edge.id))}
                      className="rounded border border-foreground/50 bg-destructive/15 px-2 py-1 text-sm font-medium text-foreground hover:bg-destructive/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      Remove
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="mt-3 grid gap-2">
              <label className="text-xs text-foreground/80">From
                <select className={`${fieldClass} mt-1`} value={edgeSource} onChange={(event) => setEdgeSource(event.target.value)}>
                  {nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
                </select>
              </label>
              <label className="text-xs text-foreground/80">To
                <select className={`${fieldClass} mt-1`} value={edgeTarget} onChange={(event) => setEdgeTarget(event.target.value)}>
                  {nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
                </select>
              </label>
              <Button variant="outline" onClick={addAccessibleEdge} disabled={nodes.length < 2}>Add connection</Button>
            </div>
          </StudioPanel>
        </div>
      </div>
    </div>
  )
}
