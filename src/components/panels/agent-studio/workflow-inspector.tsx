'use client'

import { Button } from '@/components/ui/button'
import type { StudioAgent, StudioWorkflowNode } from '@/lib/studio/schemas'
import { fieldClass, StudioPanel, textAreaClass } from './studio-ui'

interface WorkflowInspectorProps {
  node: StudioWorkflowNode | null
  agents: StudioAgent[]
  onChange: (node: StudioWorkflowNode) => void
  onDelete: (nodeId: string) => void
}

export function WorkflowInspector(props: WorkflowInspectorProps) {
  if (!props.node) {
    return (
      <StudioPanel className="p-4">
        <p className="font-mono text-xs text-foreground/80">Node inspector</p>
        <p className="mt-3 text-sm leading-relaxed text-foreground/80">
          Select a node to edit its label, assignment, or agent. Drag from the handles to connect nodes.
        </p>
      </StudioPanel>
    )
  }

  const node = props.node
  return (
    <StudioPanel className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-primary">{node.kind} node</p>
          <h3 className="mt-1 text-sm font-semibold text-foreground">Inspector</h3>
        </div>
        {node.kind !== 'start' && node.kind !== 'finish' && (
          <Button variant="ghost" size="icon-xs" title="Delete node" onClick={() => props.onDelete(node.id)}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4"><path d="M3 4h10M6 4V2h4v2M5 6v7m3-7v7m3-7v7M4 4l.5 10h7L12 4" /></svg>
          </Button>
        )}
      </div>
      <label className="mt-4 block text-xs text-foreground/80">Label
        <input className={`${fieldClass} mt-1`} value={node.label} onChange={(event) => props.onChange({ ...node, label: event.target.value })} />
      </label>
      {node.kind === 'agent' && (
        <>
          <label className="mt-3 block text-xs text-foreground/80">Agent
            <select className={`${fieldClass} mt-1`} value={node.agentId} onChange={(event) => props.onChange({ ...node, agentId: Number(event.target.value) })}>
              {props.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.runtime}</option>)}
            </select>
          </label>
          <label className="mt-3 block text-xs text-foreground/80">Assignment
            <textarea className={`${textAreaClass} mt-1 min-h-32 resize-y`} value={node.prompt} onChange={(event) => props.onChange({ ...node, prompt: event.target.value })} />
          </label>
        </>
      )}
    </StudioPanel>
  )
}
