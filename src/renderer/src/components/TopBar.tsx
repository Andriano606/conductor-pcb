import React from 'react'
import { findingHits } from '@shared/rules'
import { useStore } from '../store'

export function TopBar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const rules = useStore((s) => s.rules)
  const projects = useStore((s) => s.projects)
  const ruleScope = useStore((s) => s.ruleScope)
  const api = useStore((s) => s.api)
  const report = useStore((s) => s.report)
  const found = findingHits(report, rules)
  const hits = found.total
  const hitsTitle =
    found.unclaimed.length > 0
      ? `Знахідок в останньому звіті: ${hits} — з правилом ${found.claimed}, без правила ${hits - found.claimed} (KiCad DRC; див. «Без правила» внизу списку)`
      : `Знахідок в останньому звіті: ${hits}`
  // `rules` is the active project's scope (global defaults + its overrides + its own rules)
  const enabled = rules.filter((r) => r.effective.enabled).length
  const scopeName = projects.find((p) => p.id === ruleScope)?.name
  const rulesTitle = `Увімкнено ${enabled} з ${rules.length} правил${scopeName ? ` для проекту ${scopeName}` : ''}`
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className={'tab' + (view === 'chat' ? ' active' : '')} onClick={() => setView('chat')}>Чат</button>
        <button className={'tab' + (view === 'rules' ? ' active' : '')} onClick={() => setView('rules')} title={rulesTitle}>
          <BookIcon /> Правила <span className="count" aria-label={rulesTitle}>{enabled}</span>
          {hits > 0 && <span className="hit-badge" title={hitsTitle} aria-label={hitsTitle}>{hits}</span>}
        </button>
      </div>
      <div className="topbar-right">
        <span className={'api-dot' + (api.running ? ' on' : '')} />
        <span className="muted small">{api.running ? `API ${api.url}` : 'API вимкнено'}</span>
      </div>
    </header>
  )
}

function BookIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}
