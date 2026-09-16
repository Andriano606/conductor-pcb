import React from 'react'
import type { EffectiveRule } from '@shared/types'
import { CATEGORIES } from '@shared/types'
import { useStore } from '../store'
import { SeverityDot } from './SeverityBadge'
import { Toggle } from './Toggle'
import { ResetRuleButton } from './ResetRuleButton'

export function RuleSidebar({ rules }: { rules: EffectiveRule[] }): JSX.Element {
  const selected = useStore((s) => s.selected)
  const select = useStore((s) => s.select)
  const query = useStore((s) => s.query)
  const setQuery = useStore((s) => s.setQuery)
  const category = useStore((s) => s.category)
  const setCategory = useStore((s) => s.setCategory)
  const onlyEnabled = useStore((s) => s.onlyEnabled)
  const setOnlyEnabled = useStore((s) => s.setOnlyEnabled)
  const total = useStore((s) => s.rules.length)
  const errors = useStore((s) => s.errors)
  const api = useStore((s) => s.api)
  const report = useStore((s) => s.report)
  const projects = useStore((s) => s.projects)
  const ruleScope = useStore((s) => s.ruleScope)
  const setImportScope = useStore((s) => s.setImportScope)
  const setOverride = useStore((s) => s.setOverride)
  const setGlobalRulesOpen = useStore((s) => s.setGlobalRulesOpen)
  const scopeProject = projects.find((p) => p.id === ruleScope) ?? null

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
          <button className="icon-btn" title={scopeProject ? `Імпортувати правило з JSON лише для проекту ${scopeProject.name}` : 'Імпортувати правило з JSON'} onClick={() => setImportScope(ruleScope)} aria-label="Імпортувати правило">⤓</button>
          <ResetRuleButton scope={ruleScope} />
        </div>
      </div>
      <div className="sidebar-tools">
        <div className="scope" title={scopeProject ? 'Увімкнені правила й пороги тут діють лише для цього проекту; типові значення — з глобальних правил' : 'Немає проекту: показано глобальні правила'}>
          <span>Проект:</span>
          <b className="scope-name">{scopeProject ? scopeProject.name : 'немає (глобальні)'}</b>
          <button className="link" onClick={() => setGlobalRulesOpen(true)}>глобальні…</button>
        </div>
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
              <div key={r.code} className={'rule-row toggled' + (r.code === selected ? ' active' : '') + (r.effective.enabled ? '' : ' disabled')}>
                <Toggle size="xs" checked={r.effective.enabled} onChange={(v) => void setOverride(r.code, { enabled: v })}
                  label={scopeProject ? `Увімкнути ${r.code} для проекту ${scopeProject.name}` : `Увімкнути ${r.code}`} />
                <button className="rule-row-btn" onClick={() => select(r.code)} title={r.summary}>
                  <SeverityDot severity={r.effective.severity} />
                  <span className="rule-row-text">
                    <span className="rule-row-title">{r.title}</span>
                    <span className="rule-row-code">{r.code}</span>
                  </span>
                  {hits.has(r.code) && <span className="hit-badge" title="Знахідок в останньому звіті">{hits.get(r.code)}</span>}
                  {r.source === 'user' && <span className="src-badge" title="Правило користувача (для всіх проектів)">U</span>}
                  {r.source === 'project' && <span className="src-badge project" title="Правило лише цього проекту">P</span>}
                </button>
              </div>
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
