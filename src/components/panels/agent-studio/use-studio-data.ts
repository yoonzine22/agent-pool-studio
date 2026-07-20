'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { getRunDetail, getStudioSnapshot, type StudioRunDetail, type StudioSnapshot } from './studio-client'

const emptySnapshot: StudioSnapshot = {
  agents: [],
  teams: [],
  workflows: [],
  runs: [],
  runtimes: [],
  workspacePath: '',
}

export function useStudioData() {
  const [snapshot, setSnapshot] = useState<StudioSnapshot>(emptySnapshot)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [runDetail, setRunDetail] = useState<StudioRunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runRequestId = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const next = await getStudioSnapshot()
      setSnapshot(next)
      setError(null)
      setSelectedRunId((current) => current ?? next.runs[0]?.id ?? null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to load Agent Studio')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshRun = useCallback(async (runId: number | null) => {
    const requestId = runRequestId.current + 1
    runRequestId.current = requestId
    if (runId === null) {
      setRunDetail(null)
      return
    }
    try {
      const detail = await getRunDetail(runId)
      if (requestId !== runRequestId.current) return
      setRunDetail(detail)
    } catch (refreshError) {
      if (requestId !== runRequestId.current) return
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to load run')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { void refreshRun(selectedRunId) }, [refreshRun, selectedRunId])

  useEffect(() => {
    const source = new EventSource('/api/events')
    source.onmessage = (message) => {
      let payload: unknown
      try {
        payload = JSON.parse(message.data)
      } catch {
        return
      }
      if (!payload || typeof payload !== 'object' || !('type' in payload)) return
      const type = Reflect.get(payload, 'type')
      if (
        type !== 'studio.updated'
        && type !== 'agent.created'
        && type !== 'agent.deleted'
        && type !== 'run.created'
        && type !== 'run.updated'
        && type !== 'run.completed'
      ) return
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => {
        void refresh()
        void refreshRun(selectedRunId)
      }, 120)
    }
    return () => {
      source.close()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [refresh, refreshRun, selectedRunId])

  useEffect(() => {
    const active = runDetail?.run.status === 'running' || runDetail?.run.status === 'pending'
    if (!active || selectedRunId === null) return
    const timer = setInterval(() => void refreshRun(selectedRunId), 1_500)
    return () => clearInterval(timer)
  }, [refreshRun, runDetail?.run.status, selectedRunId])

  return {
    snapshot,
    runDetail,
    selectedRunId,
    setSelectedRunId,
    refresh,
    refreshRun,
    loading,
    error,
    setError,
  }
}
