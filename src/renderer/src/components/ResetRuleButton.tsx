import React from 'react'
import { overrideIsEmpty } from '@shared/rules'
import { useStore } from '../store'

/**
 * ↺ next to the import button: resets the selected rule (`code`) in `scope` to its defaults —
 * in a project scope that removes the project's override (back to the global values), in the
 * global scope the global override (back to the rule file). Disabled when nothing is overridden.
 */
export function ResetRuleButton({ code, scope }: { code: string | null; scope: string }): JSX.Element {
  const config = useStore((s) => s.config)
  const projects = useStore((s) => s.projects)
  const resetOverride = useStore((s) => s.resetOverride)
  const project = scope === 'global' ? null : (projects.find((p) => p.id === scope) ?? null)
  const ov = code ? (project ? project.ruleOverrides?.[code] : config?.overrides[code]) : undefined
  const canReset = !!code && !overrideIsEmpty(ov)
  const title = !code
    ? 'Оберіть правило'
    : project
      ? `Скинути ${code} до типових: прибрати зміни цього проекту (рівень, увімкненість, пороги знову як у глобальних)`
      : `Скинути ${code} до типових: прибрати глобальні зміни (як у файлі правила)`
  return (
    <button className="icon-btn danger" title={title} aria-label={`Скинути ${code ?? 'правило'} до типових`} disabled={!canReset}
      onClick={() => code && void resetOverride(code, scope)}>
      <ResetIcon />
    </button>
  )
}

function ResetIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  )
}
