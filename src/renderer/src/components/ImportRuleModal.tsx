import React, { useEffect, useMemo, useState } from 'react'
import type { Rule } from '@shared/types'
import { validateRule } from '@shared/rules'
import { CATEGORIES, SEVERITY_LABEL } from '@shared/types'
import { useStore } from '../store'
import { BoardDiagram } from './BoardDiagram'

/**
 * Import a rule from JSON (pasted or picked from a file): validate, preview exactly as the
 * rule card will look (diagrams, params, kernel), then save it. `scope` 'global' writes into
 * the user rules dir (all projects); a project id writes into that project's own rules dir.
 */
export function ImportRuleModal({ scope }: { scope: string }): JSX.Element {
  const setImportScope = useStore((s) => s.setImportScope)
  const setImportOpen = (open: boolean): void => setImportScope(open ? scope : null)
  const rulesScoped = useStore((s) => s.rules)
  const globalRules = useStore((s) => s.globalRules)
  const projects = useStore((s) => s.projects)
  const rules = scope === 'global' ? globalRules : rulesScoped
  const scopeProject = projects.find((p) => p.id === scope) ?? null
  const select = useStore((s) => s.select)
  const refreshRules = useStore((s) => s.refreshRules)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveErrors, setSaveErrors] = useState<string[]>([])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setImportOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setImportScope, scope])

  const parsed = useMemo<{ rule: Rule | null; problems: string[] }>(() => {
    if (!text.trim()) return { rule: null, problems: [] }
    try {
      const obj = JSON.parse(text)
      const problems = validateRule(obj)
      return { rule: problems.length ? null : (obj as Rule), problems }
    } catch (e) {
      return { rule: null, problems: [`не JSON: ${(e as Error).message}`] }
    }
  }, [text])

  const exists = parsed.rule ? rules.find((r) => r.code === parsed.rule!.code) : undefined

  const pick = async (): Promise<void> => {
    const r = await window.api.pickJsonFile()
    if (!r) return
    setFileName(r.name)
    setText(r.content)
  }

  const save = async (): Promise<void> => {
    if (!parsed.rule) return
    setSaving(true)
    const problems = await window.api.saveUserRule(parsed.rule, scope === 'global' ? undefined : scope)
    setSaving(false)
    if (problems.length) {
      setSaveErrors(problems)
      return
    }
    await refreshRules()
    if (scope !== 'global') select(parsed.rule.code)
    setImportOpen(false)
  }

  const r = parsed.rule
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setImportOpen(false)}>
      <div className="modal wide" role="dialog" aria-label="Імпорт правила">
        <header>
          <h2>{scopeProject ? `Імпортувати правило для проекту ${scopeProject.name}` : 'Імпортувати глобальне правило'}</h2>
          <button className="icon-btn" onClick={() => setImportOpen(false)} aria-label="Закрити">✕</button>
        </header>
        <div className="import-grid">
          <section className="import-src">
            <div className="row">
              <button className="btn subtle" onClick={() => void pick()}>Вибрати файл JSON…</button>
              {fileName && <span className="muted small">{fileName}</span>}
              <span className="muted small">або вставте JSON правила нижче</span>
            </div>
            <textarea className="import-json" value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "code": "MY_RULE", "title": "…", … }' spellCheck={false} />
            {parsed.problems.length > 0 && (
              <ul className="errors small">
                {parsed.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
            {saveErrors.length > 0 && (
              <ul className="errors small">
                {saveErrors.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
            <p className="muted small">
              Формат описано в <code>schema/rule.schema.json</code>; конфіг Claude <code>kicad-pcb-rules</code> (скіл pcb-rule-author) вміє писати такі файли. {scopeProject ? 'Правило збережеться лише для цього проекту і не зʼявиться в інших.' : 'Правило збережеться в папку користувацьких правил і діятиме для всіх проектів.'}
            </p>
          </section>
          <section className="import-preview">
            <h3>Превʼю</h3>
            {!r ? (
              <p className="muted">Коли JSON стане валідним, тут з’явиться картка правила.</p>
            ) : (
              <div className="preview-card">
                <div className="crumbs">
                  <span>{CATEGORIES.find((c) => c.id === r.category)?.label}</span>
                  <span className="sep">/</span>
                  <code>{r.code}</code>
                  <span className={`sev-badge ${r.severity}`}>{SEVERITY_LABEL[r.severity]}</span>
                  {exists && <span className="err-badge">{scopeProject && exists.source !== 'project' ? 'перекриє в цьому проекті' : 'замінить'} {exists.source === 'user' ? 'користувацьке' : exists.source === 'project' ? 'проектне' : 'вбудоване'} правило з тим самим кодом</span>}
                </div>
                <h1>{r.title}</h1>
                <p className="summary">{r.summary}</p>
                <div className="examples">
                  <BoardDiagram scene={r.examples.bad} id={`imp-${r.code}-bad`} />
                  <BoardDiagram scene={r.examples.good} id={`imp-${r.code}-good`} />
                </div>
                <dl>
                  <dt>Ядро</dt>
                  <dd>{r.check ? <code>{r.check.kernel}{r.check.emits && r.check.emits !== r.code ? ` → ${r.check.emits}` : ''}</code> : <span className="muted">немає (рушій {r.checker.engine})</span>}</dd>
                  <dt>Параметри</dt>
                  <dd>{r.params.length ? r.params.map((p) => `${p.label} = ${String(p.default)}${p.unit ? ' ' + p.unit : ''}`).join('; ') : '—'}</dd>
                  <dt>Опис</dt>
                  <dd className="muted small">{r.description.slice(0, 300)}{r.description.length > 300 ? '…' : ''}</dd>
                </dl>
              </div>
            )}
          </section>
        </div>
        <footer className="row right">
          <button className="btn subtle" onClick={() => setImportOpen(false)}>Скасувати</button>
          <button className="btn primary" disabled={!r || saving} onClick={() => void save()}>{saving ? 'Зберігаю…' : 'Зберегти правило'}</button>
        </footer>
      </div>
    </div>
  )
}
