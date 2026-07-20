'use client'

import { useState } from 'react'

import { AgentPoolView } from './agent-pool-view'
import { RunConsoleView } from './run-console-view'
import { TeamBuilderView } from './team-builder-view'
import { useStudioData } from './use-studio-data'
import { WorkflowEditor } from './workflow-editor'

type StudioTab = 'pool' | 'teams' | 'workflow' | 'runs'

const tabs: Array<{ id: StudioTab; label: string; hint: string }> = [
  { id: 'pool', label: 'Agent pool', hint: 'Register runtimes' },
  { id: 'teams', label: 'Teams', hint: 'Compose members' },
  { id: 'workflow', label: 'Workflow', hint: 'Wire the graph' },
  { id: 'runs', label: 'Runs', hint: 'Observe execution' },
]

export function AgentStudioPanel() {
  const studio = useStudioData()
  const [tab, setTab] = useState<StudioTab>('pool')

  if (studio.loading) {
    return (
      <div className="flex min-h-[460px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
          <p className="mt-3 font-mono text-xs text-foreground/80">Loading Agent Studio</p>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-full bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.08),transparent_30%)] p-4 sm:p-6 xl:p-4">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4 xl:mb-3 xl:gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-px w-8 bg-primary" />
            <p className="font-mono text-xs text-primary">Multi-agent command deck</p>
          </div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight text-foreground xl:mt-1">Agent Pool Studio</h1>
          <p className="mt-1 max-w-2xl text-sm text-foreground/80 xl:mt-0.5">
            Build your Codex and Antigravity team, connect the work visually, and supervise every run.
          </p>
        </div>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          {[
            ['Agents', studio.snapshot.agents.length],
            ['Teams', studio.snapshot.teams.length],
            ['Flows', studio.snapshot.workflows.length],
            ['Runs', studio.snapshot.runs.length],
          ].map(([label, value], index) => (
            <div key={label} className={`px-4 py-2 text-center xl:px-3 xl:py-1.5 ${index > 0 ? 'border-l border-border' : ''}`}>
              <p className="font-mono text-base font-semibold text-foreground">{value}</p>
              <p className="text-xs text-foreground/80">{label}</p>
            </div>
          ))}
        </div>
      </header>

      {studio.error && (
        <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/60 bg-destructive/15 px-4 py-3 text-sm text-foreground">
          <span>{studio.error}</span>
          <button title="Dismiss error" onClick={() => studio.setError(null)} className="opacity-70 hover:opacity-100">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4"><path d="m3 3 10 10M13 3 3 13" /></svg>
          </button>
        </div>
      )}

      <nav aria-label="Agent Studio sections" className="mb-4 grid grid-cols-2 gap-1 rounded-lg border border-border bg-card/80 p-1 sm:grid-cols-4 xl:mb-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            aria-current={tab === item.id ? 'page' : undefined}
            className={`rounded-md px-3 py-2.5 text-left transition-colors xl:px-2.5 xl:py-2 ${
              tab === item.id ? 'bg-primary/15 text-primary' : 'text-foreground/80 hover:bg-secondary hover:text-foreground'
            }`}
          >
            <span className="block text-sm font-semibold">{item.label}</span>
            <span className="mt-0.5 hidden text-xs text-foreground/80 sm:block">{item.hint}</span>
          </button>
        ))}
      </nav>

      {tab === 'pool' && <AgentPoolView agents={studio.snapshot.agents} runtimes={studio.snapshot.runtimes} workspacePath={studio.snapshot.workspacePath} onChanged={studio.refresh} onError={studio.setError} />}
      {tab === 'teams' && <TeamBuilderView agents={studio.snapshot.agents} teams={studio.snapshot.teams} onChanged={studio.refresh} onError={studio.setError} />}
      {tab === 'workflow' && <WorkflowEditor agents={studio.snapshot.agents} teams={studio.snapshot.teams} workflows={studio.snapshot.workflows} onChanged={studio.refresh} onError={studio.setError} onRunStarted={(runId) => { studio.setSelectedRunId(runId); setTab('runs'); void studio.refresh() }} />}
      {tab === 'runs' && <RunConsoleView runs={studio.snapshot.runs} detail={studio.runDetail} selectedRunId={studio.selectedRunId} onSelect={studio.setSelectedRunId} onChanged={async () => { await studio.refresh(); await studio.refreshRun(studio.selectedRunId) }} onError={studio.setError} />}
    </main>
  )
}
