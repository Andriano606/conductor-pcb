import React from 'react'
import type { EffectiveRule } from '@shared/types'
import { CATEGORIES } from '@shared/types'
import { useStore } from '../store'
import { SeverityDot } from './SeverityBadge'
import { Toggle } from './Toggle'

export function RuleSidebar({ rules }: { rules: EffectiveRule[] }): JSX.Element {
  const selected = useStore((s) => s.selected)
  const select = useStore((s) => s.select)
  const query = useStore((s) => s.query)
  const setQuery = useStore((s) => s.setQuery)
  const category = useStore((s) => s.category)
  const setCategory = useStore((s) => s.setCategory)
  const onlyEnabled = useStore((s) => s.onlyEnabled)
  const setOnlyEnabled = useStore((s) => s.setOnlyEnabled)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const total = useStore((s) => s.rules.length)
  const errors = useStore((s) => s.errors)
  const api = useStore((s) => s.api)
  const report = useStore((s) => s.report)
  const projects = useStore((s) => s.projects)
  const ruleScope = useStore((s) => s.ruleScope)
  const setRuleScope = useStore((s) => s.setRuleScope)
  const setImportOpen = useStore((s) => s.setImportOpen)

  const hits = new Map<string, number>()
  if (report) for (const f of report.findings) hits.set(f.code, (hits.get(f.code) ?? 0) + 1)

  const groups = CATEGORIES.map((c) => ({ ...c, rules: rules.filter((r) => r.category === c.id) })).filter(
    (g) => g.rules.length > 0
  )

  return (
    <aside className="sidebar" aria-label="Список правил">
      <div className="sidebar-header">
        <div className="sidebar-title">
          <span>Правила</span>
          <span className="count">
            {rules.length}/{total}
          </span>
        </div>
        <div className="row-tight">
          <button className="icon-btn" title="Імпортувати правило з JSON" onClick={() => setImportOpen(true)} aria-label="Імпортувати правило">⤓</button>
          <button className="icon-btn" title="Налаштування" onClick={() => setSettingsOpen(true)} aria-label="Налаштування">⚙</button>
        </div>
      </div>
      <div className="sidebar-tools">
        <label className="scope">
          <span>Пороги для</span>
          <select value={ruleScope} onChange={(e) => void setRuleScope(e.target.value)} aria-label="Область правил">
            <option value="global">усіх проектів</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <input
          className="search"
          placeholder="Пошук: код, назва, тег…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Пошук правил"
        />
        <div className="filters">
          <select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} aria-label="Категорія">
            <option value="all">Усі категорії</option>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <label className="check">
            <Toggle size="sm" checked={onlyEnabled} onChange={setOnlyEnabled} label="лише увімкнені" />
            лише увімкнені
          </label>
        </div>
      </div>
      <div className="rule-list">
        {groups.map((g) => (
          <section key={g.id} className="group">
            <div className="group-title">{g.label}</div>
            {g.rules.map((r) => (
              <button
                key={r.code}
                className={'rule-row' + (r.code === selected ? ' active' : '') + (r.effective.enabled ? '' : ' disabled')}
                onClick={() => select(r.code)}
                title={r.summary}
              >
                <SeverityDot severity={r.effective.severity} />
                <span className="rule-row-text">
                  <span className="rule-row-title">{r.title}</span>
                  <span className="rule-row-code">{r.code}</span>
                </span>
                {hits.has(r.code) && <span className="hit-badge" title="Знахідок в останньому звіті">{hits.get(r.code)}</span>}
                {r.source === 'user' && <span className="src-badge" title="Правило користувача">U</span>}
              </button>
            ))}
          </section>
        ))}
        {rules.length === 0 && <div className="muted pad">Нічого не знайдено.</div>}
      </div>
      <div className="sidebar-footer">
        <span className={'api-dot' + (api.running ? ' on' : '')} />
        <span className="muted">{api.running ? `API ${api.url}` : api.error ? `API: ${api.error}` : 'API вимкнено'}</span>
        {errors.length > 0 && (
          <span className="err-badge" title={errors.map((e) => e.file).join('\n')}>
            {errors.length} файл(ів) з помилками
          </span>
        )}
      </div>
    </aside>
  )
}
