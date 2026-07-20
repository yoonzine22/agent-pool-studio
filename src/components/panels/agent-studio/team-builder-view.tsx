'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { StudioAgent, StudioTeam, StudioTeamWrite } from '@/lib/studio/schemas'
import { removeTeam, saveTeam } from './studio-client'
import { fieldClass, RuntimeMark, StudioPanel, textAreaClass } from './studio-ui'

interface TeamBuilderViewProps {
  agents: StudioAgent[]
  teams: StudioTeam[]
  onChanged: () => Promise<void>
  onError: (message: string | null) => void
}

const emptyTeam: StudioTeamWrite = { name: '', description: '', agentIds: [] }

export function TeamBuilderView(props: TeamBuilderViewProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [form, setForm] = useState<StudioTeamWrite>(emptyTeam)
  const [saving, setSaving] = useState(false)

  function editTeam(team: StudioTeam) {
    setSelectedId(team.id)
    setForm({ name: team.name, description: team.description, agentIds: team.agentIds })
  }

  function toggleAgent(agentId: number) {
    setForm((current) => ({
      ...current,
      agentIds: current.agentIds.includes(agentId)
        ? current.agentIds.filter((id) => id !== agentId)
        : [...current.agentIds, agentId],
    }))
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    props.onError(null)
    try {
      await saveTeam(form, selectedId)
      setSelectedId(null)
      setForm(emptyTeam)
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Failed to save team')
    } finally {
      setSaving(false)
    }
  }

  async function deleteSelected() {
    if (selectedId === null || !window.confirm('Delete this team? Workflows will remain available.')) return
    try {
      await removeTeam(selectedId)
      setSelectedId(null)
      setForm(emptyTeam)
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Failed to delete team')
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <StudioPanel className="h-fit overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Saved teams</h2>
            <span className="font-mono text-xs text-foreground/80">{props.teams.length}</span>
          </div>
        </div>
        <div className="space-y-1 p-2">
          <button
            onClick={() => { setSelectedId(null); setForm(emptyTeam) }}
            className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${
              selectedId === null ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-secondary'
            }`}
          >
            <span className="text-sm font-medium text-foreground">New team</span>
            <span className="mt-0.5 block text-xs text-foreground/80">Compose from your pool</span>
          </button>
          {props.teams.map((team) => (
            <button
              key={team.id}
              onClick={() => editTeam(team)}
              className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${
                selectedId === team.id ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-secondary'
              }`}
            >
              <span className="block break-words text-sm font-medium text-foreground">{team.name}</span>
              <span className="mt-0.5 block text-xs text-foreground/80">{team.agentIds.length} agents</span>
            </button>
          ))}
        </div>
      </StudioPanel>

      <StudioPanel className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-primary">Team composer</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">
              {selectedId === null ? 'Create a team' : 'Edit team'}
            </h2>
          </div>
          {selectedId !== null && (
            <Button variant="destructive" size="sm" onClick={() => void deleteSelected()}>Delete</Button>
          )}
        </div>

        <form onSubmit={submit} className="mt-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-foreground/80">Team name
              <input required className={`${fieldClass} mt-1`} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Delivery squad" />
            </label>
            <label className="block text-xs text-foreground/80 sm:row-span-2">Description
              <textarea className={`${textAreaClass} mt-1 min-h-[84px] resize-y`} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="What this team owns." />
            </label>
          </div>

          <fieldset className="mt-5">
            <legend className="text-xs font-medium text-foreground">Pool members</legend>
            <p className="mt-1 text-sm text-foreground/80">Select the agents that may be placed in this team&apos;s workflows.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
              {props.agents.map((agent) => {
                const selected = form.agentIds.includes(agent.id)
                return (
                  <label
                    key={agent.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                      selected ? 'border-primary/40 bg-primary/10' : 'border-border bg-background/40 hover:border-primary/20'
                    }`}
                  >
                    <input type="checkbox" className="sr-only" checked={selected} onChange={() => toggleAgent(agent.id)} />
                    <span className={`flex h-5 w-5 items-center justify-center rounded border ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground/50'}`}>
                      {selected && <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="m3 8 3 3 7-7" /></svg>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium leading-snug text-foreground">{agent.name}</span>
                      <span className="block break-words text-xs text-foreground/80">{agent.role}</span>
                    </span>
                    <RuntimeMark runtime={agent.runtime} />
                  </label>
                )
              })}
              {props.agents.length === 0 && (
                <div className="col-span-full rounded-lg border border-dashed border-foreground/40 p-8 text-center text-sm text-foreground/80">
                  Add agents to the pool before composing a team.
                </div>
              )}
            </div>
          </fieldset>

          <div className="mt-5 flex justify-end gap-2">
            {selectedId !== null && (
              <Button type="button" variant="ghost" onClick={() => { setSelectedId(null); setForm(emptyTeam) }}>Cancel</Button>
            )}
            <Button type="submit" disabled={saving || form.agentIds.length === 0}>
              {saving ? 'Saving…' : selectedId === null ? 'Create team' : 'Save team'}
            </Button>
          </div>
        </form>
      </StudioPanel>
    </div>
  )
}
