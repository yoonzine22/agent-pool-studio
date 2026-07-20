'use client'

import { useEffect, useMemo, useRef } from 'react'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
  useNodesState,
} from '@xyflow/react'

import type { StudioAgent, StudioWorkflowEdge, StudioWorkflowNode } from '@/lib/studio/schemas'
import { cn } from '@/lib/utils'

interface CanvasData extends Record<string, unknown> {
  studioNode: StudioWorkflowNode
  agent: StudioAgent | null
}

type CanvasNode = Node<CanvasData, 'studio'>

const kindStyles: Record<StudioWorkflowNode['kind'], string> = {
  start: 'border-void-mint/40 bg-void-mint/10',
  agent: 'border-void-cyan/40 bg-void-cyan/10',
  approval: 'border-void-amber/40 bg-void-amber/10',
  finish: 'border-void-violet/40 bg-void-violet/10',
}

function NodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const node = data.studioNode
  return (
    <div className={cn(
      'w-44 rounded-lg border bg-card px-3 py-2.5 shadow-lg transition-shadow',
      kindStyles[node.kind],
      selected && 'ring-2 ring-primary/50 ring-offset-2 ring-offset-background',
    )}>
      {node.kind !== 'start' && <Handle type="target" position={Position.Left} className="border-background! bg-primary!" />}
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-current/20 text-primary">
          <NodeGlyph kind={node.kind} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-semibold leading-tight text-foreground">{node.label}</span>
          <span className="block break-words font-mono text-xs leading-tight text-foreground/80">
            {node.kind === 'agent' ? data.agent?.name ?? 'Missing agent' : node.kind}
          </span>
        </span>
      </div>
      {node.kind !== 'finish' && <Handle type="source" position={Position.Right} className="border-background! bg-primary!" />}
    </div>
  )
}

function NodeGlyph({ kind }: { kind: StudioWorkflowNode['kind'] }) {
  if (kind === 'start') return <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5"><path d="M5 3.5v9l7-4.5-7-4.5Z" /></svg>
  if (kind === 'finish') return <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5"><rect x="4" y="4" width="8" height="8" rx="1" /></svg>
  if (kind === 'approval') return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5"><path d="m3 8 3 3 7-7" /></svg>
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5"><circle cx="8" cy="5" r="2.5" /><path d="M3.5 14c.4-3 2-4.5 4.5-4.5s4.1 1.5 4.5 4.5" /></svg>
}

const nodeTypes: NodeTypes = { studio: NodeCard }

interface WorkflowCanvasProps {
  nodes: StudioWorkflowNode[]
  edges: StudioWorkflowEdge[]
  agents: StudioAgent[]
  selectedNodeId: string | null
  onNodesChange: (nodes: StudioWorkflowNode[]) => void
  onEdgesChange: (edges: StudioWorkflowEdge[]) => void
  onSelectNode: (nodeId: string | null) => void
}

function toCanvasNodes(
  nodes: StudioWorkflowNode[],
  agents: StudioAgent[],
  selectedNodeId: string | null,
  previous: CanvasNode[] = [],
): CanvasNode[] {
  return nodes.map((node) => ({
    ...previous.find((candidate) => candidate.id === node.id),
    id: node.id,
    type: 'studio',
    position: node.position,
    selected: node.id === selectedNodeId,
    data: {
      studioNode: node,
      agent: node.kind === 'agent'
        ? agents.find((agent) => agent.id === node.agentId) ?? null
        : null,
    },
  }))
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  const flowRef = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null)
  const [canvasNodes, setCanvasNodes, applyCanvasNodeChanges] = useNodesState<CanvasNode>(
    toCanvasNodes(props.nodes, props.agents, props.selectedNodeId),
  )
  const canvasEdges = useMemo<Edge[]>(() => props.edges.map((edge) => ({
      ...edge,
      type: 'smoothstep',
      style: { stroke: 'hsl(var(--primary))', strokeOpacity: 0.55 },
    })), [props.edges])

  useEffect(() => {
    setCanvasNodes((current) => toCanvasNodes(
      props.nodes,
      props.agents,
      props.selectedNodeId,
      current,
    ))
  }, [props.agents, props.nodes, props.selectedNodeId, setCanvasNodes])

  const graphLayoutKey = props.nodes
    .map((node) => `${node.id}:${node.position.x}:${node.position.y}`)
    .join('|')
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void flowRef.current?.fitView({ padding: 0.12, maxZoom: 1 })
    })
    return () => cancelAnimationFrame(frame)
  }, [graphLayoutKey])

  function updateNodes(changes: NodeChange<CanvasNode>[]) {
    applyCanvasNodeChanges(changes)
    if (changes.some((change) => change.type === 'position' || change.type === 'remove')) {
      const changed = applyNodeChanges(changes, canvasNodes)
      props.onNodesChange(changed.map((node) => ({
        ...node.data.studioNode,
        position: node.position,
      })))
    }
  }

  function updateEdges(changes: EdgeChange[]) {
    const changed = applyEdgeChanges(changes, canvasEdges)
    props.onEdgesChange(changed.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })))
  }

  function connect(connection: Connection) {
    const changed = addEdge({ ...connection, id: crypto.randomUUID(), type: 'smoothstep' }, canvasEdges)
    props.onEdgesChange(changed.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })))
  }

  return (
    <div className="h-[520px] overflow-hidden rounded-lg border border-border bg-background/70 xl:h-[440px] 2xl:h-[520px]">
      <ReactFlow<CanvasNode>
        nodes={canvasNodes}
        edges={canvasEdges}
        nodeTypes={nodeTypes}
        onNodesChange={updateNodes}
        onEdgesChange={updateEdges}
        onConnect={connect}
        onInit={(instance) => {
          flowRef.current = instance
        }}
        onNodeClick={(_, node) => props.onSelectNode(node.id)}
        onPaneClick={() => props.onSelectNode(null)}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.35}
        maxZoom={1.5}
        colorMode="dark"
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border))" />
        <MiniMap
          pannable
          zoomable
          className="border! border-border! bg-card!"
          nodeColor="hsl(var(--primary))"
          maskColor="hsl(var(--background) / 0.78)"
        />
        <Controls className="border! border-border! bg-card! fill-foreground!" />
      </ReactFlow>
    </div>
  )
}
