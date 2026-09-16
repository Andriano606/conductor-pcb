import React, { useEffect, useState } from 'react'
import type { EffectiveRule } from '@shared/types'
import { useStore } from '../store'
import { Toggle } from './Toggle'

export function ParamsTable({ rule, scope }: { rule: EffectiveRule; scope?: string }): JSX.Element | null {
  const setOverrideStore = useStore((s) => s.setOverride)
  const setOverride = (code: string, ov: Parameters<typeof setOverrideStore>[1]): Promise<void> => setOverrideStore(code, ov, scope)
  const [draft, setDraft] = useState<Record<string, string>>({})
  useEffect(() => {
    const d: Record<string, string> = {}
    for (const p of rule.params) d[p.key] = String(rule.effective.params[p.key])
    setDraft(d)
  }, [rule])

  if (rule.params.length === 0) return <p className="muted">Це правило не має налаштовуваних порогів.</p>

  const commit = (key: string, type: string | undefined): void => {
    const raw = draft[key]
    let v: number | string | boolean = raw
    if (type === 'boolean') v = raw === 'true'
    else if (type !== 'string') {
      const n = Number(raw)
      if (Number.isNaN(n)) return
      v = n
    }
    if (v === rule.effective.params[key]) return
    void setOverride(rule.code, { params: { [key]: v } })
  }

  return (
    <table className="params">
      <thead>
        <tr>
          <th>Параметр</th>
          <th>Ключ у перевірячі</th>
          <th>Значення</th>
          <th>Типово</th>
        </tr>
      </thead>
      <tbody>
        {rule.params.map((p) => {
          const changed = rule.effective.params[p.key] !== p.default
          return (
            <tr key={p.key} className={changed ? 'changed' : ''}>
              <td>
                {p.label}
                {p.description && <div className="muted small">{p.description}</div>}
              </td>
              <td>
                <code>{p.key}</code>
              </td>
              <td>
                {p.type === 'boolean' ? (
                  <Toggle size="sm" checked={draft[p.key] === 'true'} onChange={(v) => { setDraft({ ...draft, [p.key]: String(v) }); void setOverride(rule.code, { params: { [p.key]: v } }) }} label={p.label} />
                ) : (
                  <input
                    type={p.type === 'string' ? 'text' : 'number'}
                    value={draft[p.key] ?? ''}
                    min={p.min}
                    max={p.max}
                    step={p.step ?? 'any'}
                    onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })}
                    onBlur={() => commit(p.key, p.type)}
                    onKeyDown={(e) => e.key === 'Enter' && commit(p.key, p.type)}
                  />
                )}
                {p.unit && <span className="unit">{p.unit}</span>}
              </td>
              <td className="muted">
                {String(p.default)}
                <button className="icon-btn danger param-reset" disabled={!changed} aria-label={`Скинути ${p.label} до типового`}
                  title={changed ? `Повернути типове значення ${String(p.default)}` : 'Типове значення'}
                  onClick={() => void setOverride(rule.code, { params: { [p.key]: p.default } })}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
