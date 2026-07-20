'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { StudioRun, StudioRunEvent } from '@/lib/studio/schemas'
import { actOnRun, type StudioRunDetail } from './studio-client'
import { StatusPill, StudioPanel } from './studio-ui'

interface RunConsoleViewProps {
  runs: StudioRun[]
  detail: StudioRunDetail | null
  selectedRunId: number | null
  onSelect: (runId: number) => void
  onChanged: () => Promise<void>
  onError: (message: string | null) => void
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function mergeRuntimeOutputEvents(events: StudioRunEvent[]): StudioRunEvent[] {
  const merged: StudioRunEvent[] = []
  for (const event of events) {
    const previous = merged.at(-1)
    if (
      previous?.eventType === 'runtime.output'
      && event.eventType === 'runtime.output'
      && previous.nodeId === event.nodeId
    ) {
      merged[merged.length - 1] = { ...previous, message: previous.message + event.message }
      continue
    }
    merged.push(event)
  }
  return merged
}

export function RunConsoleView(props: RunConsoleViewProps) {
  const [acting, setActing] = useState(false)
  const run = props.detail?.run ?? null
  const timelineEvents = mergeRuntimeOutputEvents(props.detail?.events ?? [])

  async function act(action: 'approve' | 'cancel') {
    if (!run) return
    setActing(true)
    props.onError(null)
    try {
      await actOnRun(run.id, action)
      await props.onChanged()
    } catch (error) {
      props.onError(error instanceof Error ? error.message : `Failed to ${action} run`)
    } finally {
      setActing(false)
    }
  }

  function requestCancel() {
    if (!run || !window.confirm(`Cancel run #${run.id}? This will stop execution and cannot be undone.`)) return
    void act('cancel')
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <StudioPanel className="h-fit overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Run history</h2>
            <span className="font-mono text-xs text-foreground/80">latest 50</span>
          </div>
        </div>
        <div className="max-h-[650px] space-y-1 overflow-y-auto p-2">
          {props.runs.map((candidate) => (
            <button
              key={candidate.id}
              onClick={() => props.onSelect(candidate.id)}
              className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${
                props.selectedRunId === candidate.id
                  ? 'border-primary/30 bg-primary/10'
                  : 'border-transparent hover:bg-secondary'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="break-words text-sm font-medium text-foreground">{candidate.workflowName}</span>
                <span className="font-mono text-xs text-foreground/80">#{candidate.id}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <StatusPill status={candidate.status} />
                <span className="text-xs text-foreground/80">{timeLabel(candidate.createdAt)}</span>
              </div>
            </button>
          ))}
          {props.runs.length === 0 && (
            <div className="p-8 text-center text-sm text-foreground/80">Run a workflow to see its timeline.</div>
          )}
        </div>
      </StudioPanel>

      {run ? (
        <div className="space-y-4">
          <StudioPanel className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-mono text-xs text-primary">Run #{run.id}</p>
                  <StatusPill status={run.status} />
                </div>
                <h2 className="mt-2 text-xl font-semibold text-foreground">{run.workflowName}</h2>
                <p className="mt-1 text-sm text-foreground/80">Requested by {run.requestedBy} · {timeLabel(run.createdAt)}</p>
              </div>
              <div className="flex gap-2">
                {run.status === 'waiting_approval' && (
                  <Button disabled={acting} onClick={() => void act('approve')}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-4 w-4"><path d="m3 8 3 3 7-7" /></svg>
                    Approve
                  </Button>
                )}
                {['pending', 'running', 'waiting_approval'].includes(run.status) && (
                  <Button variant="destructive" disabled={acting} onClick={requestCancel}>Cancel</Button>
                )}
              </div>
            </div>
            {run.input && (
              <div className="mt-4 rounded-md border border-border bg-background/50 p-3">
                <p className="font-mono text-xs text-foreground/80">Run input</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{run.input}</p>
              </div>
            )}
            {run.error && <p className="mt-4 rounded-md border border-destructive/60 bg-destructive/15 p-3 text-sm text-foreground">{run.error}</p>}
            <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {Object.entries(run.nodeStates).map(([nodeId, state]) => (
                <div key={nodeId} className="rounded-md border border-border bg-background/40 p-3">
                  <p className="break-all font-mono text-xs text-foreground/80">{nodeId}</p>
                  <div className="mt-2"><StatusPill status={state.status} /></div>
                </div>
              ))}
            </div>
          </StudioPanel>

          <StudioPanel className="overflow-hidden">
            <div className="border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-foreground">Live execution timeline</h3>
            </div>
            <div aria-live="polite" className="max-h-[520px] overflow-y-auto p-5">
              <ol className="relative space-y-0 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-border">
                {timelineEvents.map((event) => (
                  <li key={event.id} className="relative grid grid-cols-[12px_minmax(0,1fr)_auto] gap-3 pb-5">
                    <span className={`relative z-10 mt-1.5 h-3 w-3 rounded-full border-2 border-card ${
                      event.eventType.includes('failed') || event.eventType === 'runtime.error'
                        ? 'bg-destructive'
                        : event.eventType.includes('completed')
                          ? 'bg-success'
                        : event.eventType.includes('approval')
                          ? 'bg-warning'
                          : 'bg-info'
                    }`} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs uppercase tracking-wider text-foreground/80">{event.eventType}</span>
                        {event.nodeId && <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-2xs text-foreground/80">{event.nodeId}</span>}
                      </div>
                      <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">{event.message}</pre>
                    </div>
                    <time className="font-mono text-xs text-foreground/80">{timeLabel(event.createdAt)}</time>
                  </li>
                ))}
                {timelineEvents.length === 0 && <li className="text-sm text-foreground/80">Waiting for events…</li>}
              </ol>
            </div>
          </StudioPanel>
        </div>
      ) : (
        <StudioPanel className="flex min-h-[420px] items-center justify-center border-dashed text-center">
          <div><p className="text-sm text-foreground">No run selected.</p><p className="mt-1 text-sm text-foreground/80">Select a run to inspect every node and CLI event.</p></div>
        </StudioPanel>
      )}
    </div>
  )
}
