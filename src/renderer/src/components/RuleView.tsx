import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EffectiveRule, Severity } from '@shared/types'
import { CATEGORIES, SEVERITY_LABEL } from '@shared/types'
import { useStore } from '../store'
import { BoardDiagram } from './BoardDiagram'
import { ParamsTable } from './ParamsTable'
import { SeverityBadge } from './SeverityBadge'
import { Toggle } from './Toggle'

const ENGINE_LABEL = { pcbagent: 'pcbagent (наш перевіряч)', 'kicad-drc': 'KiCad DRC', manual: 'вручну' }

/**
 * One rule's card. `scope` is where its toggles/params are written: 'global' (defaults for all
 * projects) or a project id; defaults to the store's `ruleScope` (the «Правила» tab).
 */
export function RuleView({ rule, scope }: { rule: EffectiveRule; scope?: string }): JSX.Element {
  const storeScope = useStore((s) => s.ruleScope)
  const ruleScope = scope ?? storeScope
  const setOverrideStore = useStore((s) => s.setOverride)
  const resetOverride = useStore((s) => s.resetOverride)
  const deleteRule = useStore((s) => s.deleteRule)
  const askConfirm = useStore((s) => s.askConfirm)
  const report = useStore((s) => s.report)
  const config = useStore((s) => s.config)
  const projects = useStore((s) => s.projects)
  const [showJson, setShowJson] = useState(false)
  const hits = report?.findings.filter((f) => f.code === rule.code) ?? []
  const scopeProject = ruleScope === 'global' ? null : projects.find((p) => p.id === ruleScope)
  const projectOverride = scopeProject?.ruleOverrides?.[rule.code]
  const hasProjectOverride = !!projectOverride && Object.keys(projectOverride).some((k) => k === 'params' ? Object.keys(projectOverride.params ?? {}).length > 0 : true)
  const cat = CATEGORIES.find((c) => c.id === rule.category)?.label ?? rule.category
  const setOverride = (code: string, ov: Parameters<typeof setOverrideStore>[1]): Promise<void> => setOverrideStore(code, ov, ruleScope)
  const deletable = rule.source === 'project' ? (ruleScope !== 'global' ? ruleScope : null) : rule.source === 'user' ? 'global' : null
  const remove = async (): Promise<void> => {
    if (!deletable) return
    const what = rule.source === 'project' ? 'з цього проекту' : 'з користувацьких правил (для всіх проектів)'
    if (await askConfirm(`Видалити правило ${rule.code} ${what}? Файл буде стерто.`)) await deleteRule(rule.code, deletable)
  }

  return (
    <article className="rule">
      <header className="rule-head">
        <div className="rule-head-main">
          <div className="crumbs">
            <span>{cat}</span>
            <span className="sep">/</span>
            <code>{rule.code}</code>
            {rule.source === 'user' && <span className="src-badge">користувацьке</span>}
            {rule.source === 'project' && <span className="src-badge project">лише цей проект</span>}
          </div>
          <h1>{rule.title}</h1>
          <p className="summary">{rule.summary}</p>
        </div>
        <div className="rule-head-side">
          <label className="field">
            <span>Рівень</span>
            <select value={rule.effective.severity} onChange={(e) => void setOverride(rule.code, { severity: e.target.value as Severity })}>
              {(['error', 'warning', 'info'] as Severity[]).map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field toggle">
            <span>Увімкнено</span>
            <Toggle checked={rule.effective.enabled} onChange={(v) => void setOverride(rule.code, { enabled: v })} label="Увімкнено" />
          </label>
          {scopeProject && (
            hasProjectOverride
              ? <button className="scope-badge changed" title="Це правило змінено для проекту. Натисніть, щоб повернути глобальні налаштування" onClick={() => void resetOverride(rule.code, ruleScope)}>змінено для {scopeProject.name} · скинути</button>
              : <span className="scope-badge" title="Правило успадковує глобальні налаштування; зміни тут діятимуть лише для цього проекту">як у глобальних</span>
          )}
        </div>
      </header>

      <section className="examples">
        <BoardDiagram scene={rule.examples.bad} id={`${rule.code}-bad`} />
        <BoardDiagram scene={rule.examples.good} id={`${rule.code}-good`} />
      </section>

      <div className="rule-grid">
        <section className="md">
          <h2>Що перевіряється</h2>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{rule.description}</ReactMarkdown>
          <h2>Чому це важливо</h2>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{rule.why}</ReactMarkdown>
          <h2>Як виправити</h2>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{rule.fix}</ReactMarkdown>
        </section>
        <aside className="meta">
          <h3>Параметри</h3>
          <ParamsTable rule={rule} scope={ruleScope} />
          <h3>Перевіряч</h3>
          <dl>
            <dt>Рушій</dt>
            <dd>{ENGINE_LABEL[rule.checker.engine]}</dd>
            {rule.check && (
              <>
                <dt>Ядро</dt>
                <dd>
                  <code>{rule.check.kernel}</code>
                  {rule.check.emits && rule.check.emits !== rule.code && <span className="muted small"> → {rule.check.emits}</span>}
                </dd>
                {rule.check.args && Object.keys(rule.check.args).length > 0 && (
                  <>
                    <dt>Аргументи</dt>
                    <dd>
                      <code>{JSON.stringify(rule.check.args)}</code>
                    </dd>
                  </>
                )}
              </>
            )}
            {rule.checker.measures && (
              <>
                <dt>Вимірює</dt>
                <dd>{rule.checker.measures}</dd>
              </>
            )}
            <dt>Код знахідки</dt>
            <dd>
              <code>{rule.code}</code>
            </dd>
            <dt>Типовий рівень</dt>
            <dd>
              <SeverityBadge severity={rule.severity} />
            </dd>
          </dl>
          {rule.tags.length > 0 && (
            <div className="tags">
              {rule.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
          )}
          {rule.references.length > 0 && (
            <>
              <h3>Джерела</h3>
              <ul className="refs">
                {rule.references.map((r, i) => (
                  <li key={i}>
                    {r.url ? (
                      <a href={r.url} onClick={(e) => { e.preventDefault(); window.api.openExternal(r.url!) }}>
                        {r.title}
                      </a>
                    ) : (
                      r.title
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {hits.length > 0 && (
            <>
              <h3>Останній звіт: {hits.length} знахідок</h3>
              <ul className="hits">
                {hits.slice(0, 20).map((f, i) => (
                  <li key={i}>
                    <b>{f.title}</b>
                    {f.x != null && f.y != null && (
                      <span className="muted"> @ ({f.x.toFixed(2)}, {f.y.toFixed(2)}) {f.layer}</span>
                    )}
                    {f.detail && <div className="muted small">{f.detail}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="file-row">
            {rule.file && (
              <button className="link" onClick={() => void window.api.openRuleFile(rule.file!)}>
                відкрити файл правила
              </button>
            )}
            <button className="link" onClick={() => setShowJson(!showJson)}>
              {showJson ? 'сховати JSON' : 'показати JSON'}
            </button>
            <button className="link" onClick={() => window.api.copyText(JSON.stringify(stripLoaderFields(rule), null, 2))}>
              копіювати JSON
            </button>
            {deletable && (
              <button className="link danger" onClick={() => void remove()}>
                видалити правило
              </button>
            )}
          </div>
          {showJson && <pre className="json">{JSON.stringify(stripLoaderFields(rule), null, 2)}</pre>}
        </aside>
      </div>
    </article>
  )
}

function stripLoaderFields(r: EffectiveRule): unknown {
  const { effective: _e, source: _s, file: _f, ...rest } = r
  return rest
}
