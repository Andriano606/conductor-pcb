import React from 'react'
import type { PromptVar } from '@shared/promptVars'

export function VarTable({ vars, values, exampleLabel }: { vars: PromptVar[]; values: Record<string, string>; exampleLabel: string }): JSX.Element {
  return (
    <table className="var-table">
      <thead>
        <tr>
          <th>Змінна</th>
          <th>Що це</th>
          <th>{exampleLabel}</th>
        </tr>
      </thead>
      <tbody>
        {vars.map((v) => (
          <tr key={v.name}>
            <td><code>${v.name}</code></td>
            <td>{v.description}</td>
            <td>{values[v.name] ? <code>{values[v.name]}</code> : <span className="var-empty">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
