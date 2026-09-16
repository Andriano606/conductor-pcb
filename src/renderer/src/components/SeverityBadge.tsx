import React from 'react'
import type { Severity } from '@shared/types'
import { SEVERITY_LABEL } from '@shared/types'

export function SeverityDot({ severity }: { severity: Severity }): JSX.Element {
  return <span className={`sev-dot ${severity}`} title={SEVERITY_LABEL[severity]} />
}

export function SeverityBadge({ severity }: { severity: Severity }): JSX.Element {
  return <span className={`sev-badge ${severity}`}>{SEVERITY_LABEL[severity]}</span>
}
