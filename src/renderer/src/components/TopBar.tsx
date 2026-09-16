import React from 'react'
import { useStore } from '../store'

export function TopBar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const rules = useStore((s) => s.rules)
  const api = useStore((s) => s.api)
  const report = useStore((s) => s.report)
  const hits = report?.findings.length ?? 0
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className={'tab' + (view === 'chat' ? ' active' : '')} onClick={() => setView('chat')}>Чат</button>
        <button className={'tab' + (view === 'rules' ? ' active' : '')} onClick={() => setView('rules')} title="Бібліотека правил трасування">
          <BookIcon /> Правила <span className="count">{rules.length}</span>
          {hits > 0 && <span className="hit-badge" title="Знахідок в останньому звіті">{hits}</span>}
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
