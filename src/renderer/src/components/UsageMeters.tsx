import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

const REFRESH_SPIN_TIMEOUT = 8000

function RefreshIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13.7 1.9v3.2h-3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function resetsIn(resetsAt: number | undefined, nowMs: number): string | null {
  if (typeof resetsAt !== 'number') return null
  const s = resetsAt - Math.floor(nowMs / 1000)
  if (s <= 0) return null
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}д ${h}г`
  if (h > 0) return `${h}г ${m}хв`
  return `${m}хв`
}

/** Claude subscription limits from /usage: a thin bar + percentage per window (ported from conductor-linux). */
export function UsageMeters(): JSX.Element | null {
  const rawUsage = useStore((s) => s.usage)
  const usage = rawUsage.filter((w) => w.key !== 'week_sonnet')
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const resynced = useRef(false)
  useEffect(() => { resynced.current = false }, [rawUsage])
  useEffect(() => {
    const expired = usage.some((w) => typeof w.resetsAt === 'number' && w.resetsAt - Math.floor(nowMs / 1000) <= 0)
    if (expired && !resynced.current) { resynced.current = true; window.api.refreshUsage() }
  }, [nowMs, usage])
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => {
    if (!refreshing) return
    const t = setTimeout(() => setRefreshing(false), REFRESH_SPIN_TIMEOUT)
    return () => clearTimeout(t)
  }, [refreshing])
  useEffect(() => setRefreshing(false), [rawUsage])

  if (usage.length === 0) return null
  return (
    <div className="usage-meters">
      {usage.map((w, i) => {
        const pct = Math.round(Math.min(100, Math.max(0, w.percent)))
        const level = pct >= 90 ? 'high' : pct >= 75 ? 'warn' : 'ok'
        const left = resetsIn(w.resetsAt, nowMs)
        const last = i === usage.length - 1
        return (
          <div className="usage-item" key={w.key}>
            <div className="usage-row" title={`${w.label}: ${pct}% використано${w.resetText ? ` · оновиться ${w.resetText}` : ''}`}>
              <span className="usage-label">{w.label}</span>
              <span className="usage-bar"><span className={`usage-fill ${level}`} style={{ width: `${pct}%` }} /></span>
              <span className="usage-pct">{pct}%</span>
            </div>
            {(left || last) && (
              <div className="usage-reset">
                {left && <span>Оновиться через {left}</span>}
                {last && (
                  <button className={`usage-refresh${refreshing ? ' spinning' : ''}`} title="Оновити ліміти зараз" aria-label="Оновити ліміти"
                    onClick={() => { if (refreshing) return; setRefreshing(true); window.api.refreshUsage(true) }}>
                    <RefreshIcon />
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
