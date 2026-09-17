import { memo, useEffect, useMemo, useState } from 'react'
import type { ChatItem, WorkflowAgent, WorkflowRun } from '@shared/types'
import { useChatStore } from '../chatStore'

/**
 * Multi-agent workflow UI (ported from conductor-linux) — our equivalent of the TUI's workflow
 * status line and its detail panel. A Workflow tool call (Claude reaches for it in ultracode)
 * launches one background task that runs a script spawning many subagents; main folds the CLI's
 * `workflow_progress` snapshots onto that tool item (ChatItem.workflow), so everything here is a
 * pure render of the transcript: `WorkflowRow` is the clickable one-liner in the chat (name,
 * summary, agents done, elapsed, tokens) and `WorkflowPanel` is the modal it opens — the plan
 * (phases) on the left, the live per-agent progress on the right. The panel reads the item
 * straight from the chat store, so it keeps updating in real time while it is open.
 */

/** Re-render every `ms` while `active` — for the live elapsed counters. */
function useNow(active: boolean, ms = 500): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}

/** "12.3с" / "1хв 04с" / "1г 12хв" */
export function formatSpan(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}хв ${String(Math.round(s % 60)).padStart(2, '0')}с`
  return `${Math.floor(m / 60)}г ${String(m % 60).padStart(2, '0')}хв`
}

/** "912" / "75.4k" / "3.8M" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** A model id trimmed to something readable in a dense row ("claude-opus-5" → "Opus 5"). */
function shortModel(model?: string): string {
  if (!model) return ''
  const m = model.match(/(opus|sonnet|haiku|fable)-?(\d+(?:[.-]\d+)?)?/i)
  if (!m) return model
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  return m[2] ? `${name} ${m[2].replace('-', '.')}` : name
}

/** An agent that was queued by the script but hasn't started running yet. */
function isQueued(a: WorkflowAgent): boolean {
  return a.state === 'start' && a.startedAt === undefined
}

function isRunning(a: WorkflowAgent): boolean {
  return (a.state === 'start' || a.state === 'progress') && !isQueued(a)
}

/** Agents finished (done, or failed/skipped) vs. the whole roster. */
function counts(run: WorkflowRun): { done: number; total: number; failed: number } {
  let done = 0
  let failed = 0
  for (const a of run.agents) {
    if (a.state === 'done') done++
    else if (a.state === 'error') failed++
  }
  return { done, total: run.agents.length, failed }
}

function StateDot({ state }: { state: 'run' | 'queued' | 'done' | 'error' }): JSX.Element {
  if (state === 'run') return <span className="wf-dot run" />
  if (state === 'queued') return <span className="wf-dot queued" />
  return <span className={`wf-glyph ${state}`}>{state === 'done' ? '✓' : '✗'}</span>
}

/** The workflow's row in the transcript (the TUI's status line); a click opens the panel. */
export const WorkflowRow = memo(function WorkflowRow({ item, onOpen }: { item: ChatItem; onOpen: () => void }): JSX.Element {
  const run = item.workflow as WorkflowRun
  const running = run.status === 'running'
  const now = useNow(running)
  const { done, total, failed } = counts(run)
  const elapsed = running ? now - run.startTs : (run.endTs ?? run.startTs) - run.startTs
  return (
    <div className={`chat-tool workflow ${running ? 'run' : run.status === 'completed' ? 'ok' : 'err'}`}>
      <button type="button" className="chat-tool-row wf-row" onClick={onOpen} title="Відкрити панель воркфлову">
        <span className="chat-tool-status">{running ? <span className="chat-tool-spin" /> : run.status === 'completed' ? '✓' : '✗'}</span>
        <span className="wf-name">{run.name}</span>
        <span className="wf-desc">{run.current || run.description}</span>
        <span className="wf-stats">
          {total > 0 && <span className={failed ? 'wf-stat warn' : 'wf-stat'}>{done}/{total} агентів</span>}
          <span className="wf-stat">{formatSpan(elapsed)}</span>
          {run.totalTokens > 0 && <span className="wf-stat">↓{formatTokens(run.totalTokens)}</span>}
        </span>
        <span className="wf-open">панель ›</span>
      </button>
    </div>
  )
})

/**
 * The detail panel: the plan on the left (each phase with its done/total), the agents of the
 * selected phase on the right with model, tokens, live state and elapsed time. Clicking an agent
 * expands its prompt/result/error.
 */
export function WorkflowPanel({ sessionId, itemId, onClose }: { sessionId: string; itemId: string; onClose: () => void }): JSX.Element | null {
  // Read the run live from the store so the panel keeps ticking while open.
  const run = useChatStore((s) => s.chats[sessionId]?.items.find((it) => it.id === itemId)?.workflow)
  const [phase, setPhase] = useState<number | null>(null) // null = all phases
  const [expanded, setExpanded] = useState<number | null>(null)
  const running = run?.status === 'running'
  const now = useNow(!!running)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Phases as the plan lists them, plus any phase only the agents mention.
  const phases = useMemo(() => {
    if (!run) return []
    const byIndex = new Map(run.phases.map((p) => [p.index, p.title]))
    for (const a of run.agents) if (a.phaseIndex !== undefined && !byIndex.has(a.phaseIndex)) byIndex.set(a.phaseIndex, a.phaseTitle ?? `Фаза ${a.phaseIndex}`)
    return [...byIndex.entries()]
      .map(([index, title]) => {
        const agents = run.agents.filter((a) => a.phaseIndex === index)
        return { index, title, total: agents.length, done: agents.filter((a) => a.state === 'done').length, failed: agents.filter((a) => a.state === 'error').length, running: agents.some(isRunning) }
      })
      .sort((a, b) => a.index - b.index)
  }, [run])

  if (!run) return null
  const shown = phase === null ? run.agents : run.agents.filter((a) => a.phaseIndex === phase)
  const { done, total, failed } = counts(run)
  const elapsed = running ? now - run.startTs : (run.endTs ?? run.startTs) - run.startTs
  const statusText = run.status === 'running' ? 'виконується' : run.status === 'completed' ? 'завершено' : run.status === 'killed' ? 'зупинено' : 'помилка'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wf-head">
          <div className="wf-title">
            <span className="wf-name">{run.name}</span>
            <span className={`wf-badge ${run.status}`}>{statusText}</span>
          </div>
          {run.description && <div className="wf-sub">{run.description}</div>}
          <div className="wf-totals">
            <span className={failed ? 'wf-stat warn' : 'wf-stat'}>{done}/{total} агентів{failed > 0 ? ` · ${failed} з помилкою` : ''}</span>
            <span className="wf-stat">{formatSpan(elapsed)}</span>
            <span className="wf-stat">↓{formatTokens(run.totalTokens)} токенів</span>
            {run.toolUses > 0 && <span className="wf-stat">{run.toolUses} викликів</span>}
          </div>
        </div>

        <div className="wf-body">
          <div className="wf-phases">
            <div className="wf-col-head">План</div>
            <button type="button" className={`wf-phase ${phase === null ? 'sel' : ''}`} onClick={() => setPhase(null)}>
              <span className="wf-phase-title">Усі фази</span>
              <span className="wf-phase-count">{done}/{total}</span>
            </button>
            {phases.map((p) => (
              <button key={p.index} type="button" className={`wf-phase ${phase === p.index ? 'sel' : ''} ${p.running ? 'run' : ''}`} onClick={() => setPhase(p.index)}>
                <span className="wf-phase-idx">{p.index}</span>
                <span className="wf-phase-title">{p.title}</span>
                <span className={`wf-phase-count ${p.failed ? 'warn' : ''}`}>{p.done}/{p.total}</span>
              </button>
            ))}
          </div>

          <div className="wf-agents">
            <div className="wf-col-head">
              {phase === null ? 'Усі агенти' : (phases.find((p) => p.index === phase)?.title ?? '')}
              <span className="wf-col-count"> · {shown.length}</span>
            </div>
            {shown.length === 0 && <div className="wf-empty">Агентів ще немає.</div>}
            {shown.map((a) => (
              <AgentRow key={a.index} agent={a} now={now} expanded={expanded === a.index} onToggle={() => setExpanded((v) => (v === a.index ? null : a.index))} />
            ))}
          </div>
        </div>

        {run.summary && <div className="wf-summary">{run.summary}</div>}

        <div className="modal-actions">
          {running && (
            <button type="button" className="btn danger" onClick={() => window.api.stopChatWorkflow(sessionId, run.taskId)}>Зупинити воркфлов</button>
          )}
          <button type="button" className="btn" onClick={onClose}>Закрити</button>
        </div>
      </div>
    </div>
  )
}

/** Long enough without a heartbeat to call a running agent idle (like the TUI). */
const IDLE_AFTER_MS = 20_000

/** One agent row: state, model, tokens, what it's doing, elapsed. */
function AgentRow({ agent, now, expanded, onToggle }: { agent: WorkflowAgent; now: number; expanded: boolean; onToggle: () => void }): JSX.Element {
  const queued = isQueued(agent)
  const running = isRunning(agent)
  const state = queued ? 'queued' : running ? 'run' : agent.state === 'done' ? 'done' : 'error'
  const started = agent.startedAt ?? agent.queuedAt
  const elapsed = agent.durationMs ?? (started ? (running ? now : (agent.lastProgressAt ?? now)) - started : 0)
  const idleFor = running && agent.lastProgressAt ? now - agent.lastProgressAt : 0
  const skipped = agent.error === 'skipped by user'
  const detail = agent.promptPreview || agent.resultPreview || agent.error
  const stateText = queued
    ? 'у черзі'
    : agent.state === 'error'
      ? skipped ? 'пропущено' : agent.blocked ? 'заблоковано' : 'помилка'
      : [agent.tokens ? `${formatTokens(agent.tokens)} tok` : '', agent.toolCalls ? `${agent.toolCalls} викл.` : '', idleFor > IDLE_AFTER_MS ? `тиша ${formatSpan(idleFor)}` : agent.lastToolName || '']
          .filter(Boolean)
          .join(' · ')
  return (
    <div className={`wf-agent ${state}${expanded ? ' expanded' : ''}`}>
      <button type="button" className="wf-agent-row" onClick={detail ? onToggle : undefined}>
        <StateDot state={state} />
        <span className="wf-agent-label">{agent.label}</span>
        {agent.model && <span className="wf-agent-model">{shortModel(agent.model)}</span>}
        {agent.attempt !== undefined && agent.attempt > 1 && <span className="wf-agent-tag" title="Повторна спроба">спроба {agent.attempt}</span>}
        {agent.cached && <span className="wf-agent-tag" title="Результат узятий з кешу попереднього запуску">кеш</span>}
        {agent.isolation && <span className="wf-agent-tag">{agent.isolation}</span>}
        <span className="wf-agent-state">{stateText}</span>
        <span className="wf-agent-dur">{queued ? '' : formatSpan(elapsed)}</span>
      </button>
      {expanded && (
        <div className="wf-agent-detail">
          {agent.lastToolSummary && <div className="wf-detail-line"><b>Останній інструмент:</b> {agent.lastToolName} — {agent.lastToolSummary}</div>}
          {agent.error && <div className="wf-detail-line err"><b>Помилка:</b> {agent.error}</div>}
          {agent.promptPreview && <pre className="wf-pre">{agent.promptPreview}</pre>}
          {agent.resultPreview && <pre className="wf-pre result">{agent.resultPreview}</pre>}
        </div>
      )}
    </div>
  )
}
