import React, { useEffect, useMemo, useState } from 'react'
import type { Category } from '@shared/types'
import { CATEGORIES } from '@shared/types'
import { filterRules } from '@shared/rules'
import { useStore } from '../store'
import { RuleView } from './RuleView'
import { SeverityDot } from './SeverityBadge'
import { Toggle } from './Toggle'

/**
 * The global rule library in one big window (opened from settings): every bundled and user
 * rule with a toggle that sets whether it applies to all projects by default, the global
 * thresholds (via the rule card on the right), and import of new global rules. Projects
 * inherit these values in their «Правила» tab and may override them for themselves only.
 */
export function GlobalRulesModal(): JSX.Element {
  const rules = useStore((s) => s.globalRules)
  const errors = useStore((s) => s.errors)
  const userRulesDir = useStore((s) => s.userRulesDir)
  const setOpen = useStore((s) => s.setGlobalRulesOpen)
  const setImportScope = useStore((s) => s.setImportScope)
  const importScope = useStore((s) => s.importScope)
  const setOverride = useStore((s) => s.setOverride)
  const reload = useStore((s) => s.reload)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && importScope === null) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen, importScope])

  const visible = useMemo(() => {
    let list = filterRules(rules, query)
    if (category !== 'all') list = list.filter((r) => r.category === category)
    return list
  }, [rules, query, category])
  const groups = CATEGORIES.map((c) => ({ ...c, rules: visible.filter((r) => r.category === c.id) })).filter((g) => g.rules.length > 0)
  const current = rules.find((r) => r.code === selected) ?? visible[0] ?? null
  const enabledCount = rules.filter((r) => r.effective.enabled).length

  const setAll = (enabled: boolean): void => {
    for (const r of visible) if (r.effective.enabled !== enabled) void setOverride(r.code, { enabled }, 'global')
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal global-rules" role="dialog" aria-label="Глобальні правила">
        <header>
          <div className="global-rules-title">
            <h2>Глобальні правила</h2>
            <span className="muted small">увімкнено для всіх проектів: {enabledCount} з {rules.length}</span>
          </div>
          <div className="row-tight">
            <button className="btn subtle" onClick={() => setImportScope('global')}>Імпортувати правило…</button>
            <button className="btn subtle" title="Перечитати файли правил" onClick={() => void reload()}>Перечитати</button>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Закрити">✕</button>
          </div>
        </header>
        <div className="global-rules-body">
          <aside className="global-rules-list" aria-label="Список глобальних правил">
            <div className="sidebar-tools">
              <input className="search" placeholder="Пошук: код, назва, тег…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Пошук глобальних правил" />
              <div className="filters">
                <select value={category} onChange={(e) => setCategory(e.target.value as Category | 'all')} aria-label="Категорія">
                  <option value="all">Усі категорії</option>
                  {CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
                <span className="row-tight">
                  <button className="link" onClick={() => setAll(true)}>усі on</button>
                  <button className="link" onClick={() => setAll(false)}>усі off</button>
                </span>
              </div>
            </div>
            <div className="rule-list">
              {groups.map((g) => (
                <section key={g.id} className="group">
                  <div className="group-title">{g.label}</div>
                  {g.rules.map((r) => (
                    <div key={r.code} className={'rule-row toggled' + (current?.code === r.code ? ' active' : '') + (r.effective.enabled ? '' : ' disabled')}>
                      <Toggle size="xs" checked={r.effective.enabled} onChange={(v) => void setOverride(r.code, { enabled: v }, 'global')} label={`Увімкнути ${r.code} для всіх проектів`} />
                      <button className="rule-row-btn" onClick={() => setSelected(r.code)} title={r.summary}>
                        <SeverityDot severity={r.effective.severity} />
                        <span className="rule-row-text">
                          <span className="rule-row-title">{r.title}</span>
                          <span className="rule-row-code">{r.code}</span>
                        </span>
                        {r.source === 'user' && <span className="src-badge" title="Правило користувача">U</span>}
                      </button>
                    </div>
                  ))}
                </section>
              ))}
              {visible.length === 0 && <div className="muted pad">Нічого не знайдено.</div>}
            </div>
            <div className="sidebar-footer">
              <span className="muted small" title={userRulesDir}>користувацькі: <code>{userRulesDir}</code></span>
              {errors.length > 0 && (
                <span className="err-badge" title={errors.map((e) => e.file).join('\n')}>{errors.length} файл(ів) з помилками</span>
              )}
            </div>
          </aside>
          <main className="global-rules-content">
            {current ? <RuleView rule={current} scope="global" key={current.code} /> : <div className="muted pad">Оберіть правило зліва.</div>}
          </main>
        </div>
      </div>
    </div>
  )
}
