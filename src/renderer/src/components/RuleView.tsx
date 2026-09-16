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

export function RuleView({ rule }: { rule: EffectiveRule }): JSX.Element {
  const setOverride = useStore((s) => s.setOverride)
  const resetOverride = useStore((s) => s.resetOverride)
  const report = useStore((s) => s.report)
  const config = useStore((s) => s.config)
  const ruleScope = useStore((s) => s.ruleScope)
  const projects = useStore((s) => s.projects)
  const [showJson, setShowJson] = useState(false)
  const hits = report?.findings.filter((f) => f.code === rule.code) ?? []
  const scopeProject = ruleScope === 'global' ? null : projects.find((p) => p.id === ruleScope)
  const overridden = scopeProject ? !!scopeProject.ruleOverrides?.[rule.code] : !!config?.overrides[rule.code]
  const cat = CATEGORIES.find((c) => c.id === rule.category)?.label ?? rule.category

  return (
    <article className="rule">
      <header className="rule-head">
        <div className="rule-head-main">
          <div className="crumbs">
            <span>{cat}</span>
            <span className="sep">/</span>
            <code>{rule.code}</code>
            {rule.source === 'user' && <span className="src-badge">користувацьке</span>}
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
          {scopeProject && <span className="scope-badge" title="Зміни діють тільки для цього проекту">проект: {scopeProject.name}</span>}
          {overridden && (
            <button className="btn subtle" onClick={() => void resetOverride(rule.code)} title={scopeProject ? 'Прибрати індивідуальні налаштування проекту' : 'Повернути значення з файлу правила'}>
              Скинути зміни
            </button>
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
          <ParamsTable rule={rule} />
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
