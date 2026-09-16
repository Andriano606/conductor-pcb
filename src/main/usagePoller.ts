import { spawn } from 'child_process'
import { homedir } from 'os'
import type { UsageWindow } from '../shared/types'
import { buildEnv } from './env'

/** Polls `claude -p "/usage"` and pushes the parsed subscription windows (ported from conductor-linux). */
let timer: ReturnType<typeof setInterval> | undefined
let lastPollAt = 0
let inflight = false
let sink: (windows: UsageWindow[]) => void = () => {}
const POLL_INTERVAL = 30_000
const MIN_GAP = 5_000

export function onUsage(fn: (windows: UsageWindow[]) => void): void {
  sink = fn
}

function mapWindow(what: string): { key: string; label: string } {
  const w = what.toLowerCase()
  if (w.startsWith('session')) return { key: 'session', label: 'Сесія' }
  if (w.includes('all models')) return { key: 'week_all', label: 'Тиждень' }
  if (w.startsWith('week')) {
    const model = what.match(/\(([^)]+)\)/)?.[1]?.replace(/only/i, '').trim()
    return { key: `week_${(model ?? '').toLowerCase() || 'all'}`, label: model ? `Тиждень · ${model}` : 'Тиждень' }
  }
  return { key: w.replace(/\s+/g, '_'), label: what }
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

export function parseResetTime(text: string, nowMs: number): number | undefined {
  const m = text.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m) return undefined
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()]
  if (mon === undefined) return undefined
  const day = parseInt(m[2], 10)
  let hour = parseInt(m[3], 10)
  const min = m[4] ? parseInt(m[4], 10) : 0
  const ap = m[5]?.toLowerCase()
  if (ap === 'pm' && hour < 12) hour += 12
  if (ap === 'am' && hour === 12) hour = 0
  const now = new Date(nowMs)
  let d = new Date(now.getFullYear(), mon, day, hour, min, 0, 0)
  if (d.getTime() < nowMs - 86_400_000) d = new Date(now.getFullYear() + 1, mon, day, hour, min, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/** "Current session: 51% used · resets Jun 25, 1:39am (Europe/Kyiv)" lines → windows. */
export function parseUsage(text: string, nowMs: number = Date.now()): UsageWindow[] {
  const out: UsageWindow[] = []
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^Current\s+(.+?):\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+?))?$/i)
    if (!m) continue
    const { key, label } = mapWindow(m[1].trim())
    const resetText = m[3]?.replace(/\s*\([^)]*\)\s*$/, '').trim() || undefined
    out.push({ key, label, percent: parseInt(m[2], 10), resetText, resetsAt: resetText ? parseResetTime(resetText, nowMs) : undefined })
  }
  return out
}

function extractResult(out: string): string | null {
  for (const line of out.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      const o = JSON.parse(s) as { result?: unknown }
      if (typeof o.result === 'string') return o.result
    } catch {
      /* not this line */
    }
  }
  return null
}

function probe(done: (ok: boolean) => void): void {
  const env = buildEnv()
  const shell = env.SHELL || '/bin/bash'
  const proc = spawn(shell, ['-ilc', 'claude -p --output-format json "/usage"'], { cwd: homedir(), env, stdio: ['ignore', 'pipe', 'ignore'] })
  let out = ''
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()))
  proc.on('error', () => done(false))
  proc.on('close', () => {
    const result = extractResult(out)
    const windows = result ? parseUsage(result) : []
    if (!windows.length) return done(false)
    sink(windows)
    done(true)
  })
}

export function pollUsage(): void {
  if (inflight) return
  inflight = true
  lastPollAt = Date.now()
  probe(() => {
    inflight = false
  })
}

export function startUsagePolling(): void {
  pollUsage()
  if (!timer) timer = setInterval(pollUsage, POLL_INTERVAL)
}

export function refreshUsageSoon(): void {
  if (Date.now() - lastPollAt > MIN_GAP) pollUsage()
}

export function stopUsagePolling(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
