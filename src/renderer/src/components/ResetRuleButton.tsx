import React from 'react'
import { overrideIsEmpty } from '@shared/rules'
import { useStore } from '../store'

/**
 * ↺ next to the import button of the project rules sidebar: drops every override of the
 * project (`scope` = project id) so all toggles, levels and thresholds go back to the global
 * values. Disabled when the project overrides nothing; asks for confirmation first.
 */
export function ResetRuleButton({ scope }: { scope: string }): JSX.Element | null {
  const projects = useStore((s) => s.projects)
  const resetProjectOverrides = useStore((s) => s.resetProjectOverrides)
  const askConfirm = useStore((s) => s.askConfirm)
  const project = projects.find((p) => p.id === scope) ?? null
  if (!project) return null
  const changed = Object.values(project.ruleOverrides ?? {}).filter((ov) => !overrideIsEmpty(ov)).length
  const reset = async (): Promise<void> => {
    if (await askConfirm(`Скинути всі правила проекту ${project.name} до глобальних? Зміни ${changed} правил (увімкненість, рівні, пороги) буде прибрано.`)) await resetProjectOverrides(project.id)
  }
  return (
    <button className="icon-btn danger" disabled={!changed} aria-label="Скинути всі правила проекту до глобальних"
      title={changed ? `Скинути всі правила проекту до глобальних (змінено: ${changed})` : 'У проекті нічого не змінено відносно глобальних правил'}
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
