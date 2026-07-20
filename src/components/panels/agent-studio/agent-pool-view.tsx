'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { StudioAgent, StudioAgentCreate, StudioRuntimeReadiness } from '@/lib/studio/schemas'
import { createAgent, removeAgent } from './studio-client'
import { fieldClass, RuntimeMark, StatusPill, StudioPanel, textAreaClass } from './studio-ui'

interface AgentPoolViewProps {
  agents: StudioAgent[]
  runtimes: StudioRuntimeReadiness[]
  workspacePath: string
  onChanged: () => Promise<void>
  onError: (message: string | null) => void
}

const initialAgent: StudioAgentCreate = {
  name: '',
  role: '',
  runtime: 'codex',
  instructions: '',
  model: null,
  workspacePath: '',
}

export function AgentPoolView(props: AgentPoolViewProps) {
  const [form, setForm] = useState<StudioAgentCreate>(initialAgent)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setForm((current) => current.workspacePath
      ? current
      : { ...current, workspacePath: props.workspacePath })
  }, [props.workspacePath])

  async function submitAgent(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    props.onError(null)
    try {
      await createAgent(form)
      setForm({ ...initialAgent, workspacePath: props.workspacePath, runtime: form.runtime })
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Failed to create agent')
    } finally {
      setSaving(false)
    }
  }

  async function deleteAgent(agent: StudioAgent) {
    if (!window.confirm(`Remove ${agent.name} from the pool?`)) return
    try {
      await removeAgent(agent.id)
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Failed to remove agent')
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {props.runtimes.map((runtime) => (
            <StudioPanel key={runtime.runtime} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <RuntimeMark runtime={runtime.runtime} />
                <StatusPill status={runtime.available ? 'available' : 'offline'} />
              </div>
              <p className="mt-3 font-mono text-xs text-foreground">{runtime.version ?? 'CLI not detected'}</p>
              <p className="mt-1 text-sm leading-relaxed text-foreground/80">{runtime.detail}</p>
            </StudioPanel>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {props.agents.map((agent) => (
            <StudioPanel key={agent.id} className="group p-4 transition-colors hover:border-primary/30">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold leading-snug text-foreground">{agent.name}</h3>
                  <p className="mt-0.5 break-words text-xs text-foreground/80">{agent.role}</p>
                </div>
                <StatusPill status={agent.status} />
              </div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <RuntimeMark runtime={agent.runtime} />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={`Remove ${agent.name}`}
                  aria-label={`Remove ${agent.name}`}
                  onClick={() => void deleteAgent(agent)}
                  className="text-foreground/80 opacity-70 hover:bg-destructive/20 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
                    <path d="M3 4h10M6 4V2h4v2M5 6v7m3-7v7m3-7v7M4 4l.5 10h7L12 4" />
                  </svg>
                </Button>
              </div>
              <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-relaxed text-foreground/80">
                {agent.instructions || 'No system instructions yet.'}
              </p>
              <p className="mt-3 break-all border-t border-border pt-3 font-mono text-xs text-foreground">
                {agent.workspacePath}
              </p>
            </StudioPanel>
          ))}
          {props.agents.length === 0 && (
            <StudioPanel className="col-span-full border-dashed p-10 text-center">
              <p className="text-sm text-foreground">Your agent pool is empty.</p>
              <p className="mt-1 text-sm text-foreground/80">Create a Codex or Antigravity agent to begin.</p>
            </StudioPanel>
          )}
        </div>
      </div>

      <StudioPanel className="h-fit p-5 xl:sticky xl:top-4">
        <div className="mb-5">
          <p className="font-mono text-xs text-primary">New pool member</p>
          <h2 className="mt-1 text-base font-semibold text-foreground">Register an agent</h2>
        </div>
        <form onSubmit={submitAgent} className="space-y-3">
          <label className="block text-xs text-foreground/80">Name
            <input required className={`${fieldClass} mt-1`} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Builder" />
          </label>
          <label className="block text-xs text-foreground/80">Role
            <input required className={`${fieldClass} mt-1`} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} placeholder="Implementation" />
          </label>
          <label className="block text-xs text-foreground/80">Runtime
            <select className={`${fieldClass} mt-1`} value={form.runtime} onChange={(event) => setForm({ ...form, runtime: event.target.value === 'antigravity' ? 'antigravity' : 'codex' })}>
              <option value="codex">Codex</option>
              <option value="antigravity">Antigravity</option>
            </select>
          </label>
          <label className="block text-xs text-foreground/80">Workspace
            <input required className={`${fieldClass} mt-1 font-mono text-xs`} value={form.workspacePath} onChange={(event) => setForm({ ...form, workspacePath: event.target.value })} />
          </label>
          <label className="block text-xs text-foreground/80">Model override
            <input className={`${fieldClass} mt-1`} value={form.model ?? ''} onChange={(event) => setForm({ ...form, model: event.target.value || null })} placeholder="Use CLI default" />
          </label>
          <label className="block text-xs text-foreground/80">System instructions
            <textarea className={`${textAreaClass} mt-1 min-h-28 resize-y`} value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} placeholder="Define this agent's responsibilities and constraints." />
          </label>
          <Button type="submit" disabled={saving} className="w-full">
            {saving ? 'Registering…' : 'Add to pool'}
          </Button>
        </form>
      </StudioPanel>
    </div>
  )
}
