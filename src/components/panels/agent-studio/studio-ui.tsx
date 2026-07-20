import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export const fieldClass = 'h-9 w-full rounded-md border border-foreground/50 bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-foreground/70 focus:border-primary/80 focus:ring-2 focus:ring-primary/20'
export const textAreaClass = 'w-full rounded-md border border-foreground/50 bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-foreground/70 focus:border-primary/80 focus:ring-2 focus:ring-primary/20'

export function StudioPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-border bg-card/80 shadow-sm', className)}>
      {children}
    </section>
  )
}

const statusStyle: Record<string, string> = {
  completed: 'border-success/30 bg-success/15 text-success',
  idle: 'border-success/30 bg-success/15 text-success',
  available: 'border-success/30 bg-success/15 text-success',
  running: 'border-info/30 bg-info/15 text-info',
  busy: 'border-info/30 bg-info/15 text-info',
  waiting_approval: 'border-warning/30 bg-warning/15 text-warning',
  pending: 'bg-secondary text-foreground/80 border-foreground/50',
  offline: 'bg-secondary text-foreground/80 border-foreground/50',
  failed: 'border-destructive/60 bg-destructive/20 text-foreground',
  cancelled: 'bg-secondary text-foreground/80 border-foreground/50',
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-2xs uppercase tracking-wide',
      statusStyle[status] ?? statusStyle.pending,
    )}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status.replace('_', ' ')}
    </span>
  )
}

export function RuntimeMark({ runtime }: { runtime: 'codex' | 'antigravity' }) {
  return (
    <span className={cn(
      'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 font-mono text-2xs uppercase tracking-wider',
      runtime === 'codex'
        ? 'border-void-cyan/50 bg-void-cyan/15 text-foreground'
        : 'border-void-violet/50 bg-void-violet/15 text-foreground',
    )}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
        {runtime === 'codex' ? (
          <><path d="M6 3 2 8l4 5M10 3l4 5-4 5" /><path d="m9 2-2 12" /></>
        ) : (
          <><path d="m8 1 1.3 4.2L14 6.5l-3.6 2.6.1 4.7L8 10.9l-2.5 2.9.1-4.7L2 6.5l4.7-1.3L8 1Z" /></>
        )}
      </svg>
      {runtime}
    </span>
  )
}
