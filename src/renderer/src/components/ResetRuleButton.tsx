import React from 'react'
import { rulesDifferingFromGlobal } from '@shared/rules'
import { useStore } from '../store'

/**
 * ↺ next to the import button of the project rules sidebar: applies the current global rule
 * values to the project (`scope` = project id), replacing all its toggles, levels and
 * thresholds. Enabled only while the project's values differ from the globals somewhere.
 */
export function ResetRuleButton({ scope }: { scope: string }): JSX.Element | null {
  const projects = useStore((s) => s.projects)
  const rules = useStore((s) => s.rules)
  const globalRules = useStore((s) => s.globalRules)
  const resetProjectOverrides = useStore((s) => s.resetProjectOverrides)
  const askConfirm = useStore((s) => s.askConfirm)
  const project = projects.find((p) => p.id === scope) ?? null
  if (!project) return null
  const changed = rulesDifferingFromGlobal(rules, globalRules).length
  const reset = async (): Promise<void> => {
    if (await askConfirm(`Застосувати глобальні правила до проекту ${project.name}? Власні значення ${changed} правил (увімкненість, рівні, пороги) буде замінено глобальними.`)) await resetProjectOverrides(project.id)
  }
  return (
    <button className="icon-btn danger" disabled={!changed} aria-label="Застосувати глобальні правила до проекту"
      title={changed ? `Застосувати глобальні правила до проекту (відрізняється: ${changed})` : 'Правила проекту збігаються з глобальними'}
      onClick={() => void reset()}>
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
