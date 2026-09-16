// @vitest-environment jsdom
import React from 'react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyOverride } from '@shared/rules'
import type { Rule } from '@shared/types'
import { RuleView } from '../../src/renderer/src/components/RuleView'
import { useStore } from '../../src/renderer/src/store'

const rule = JSON.parse(readFileSync(resolve(__dirname, '../../rules/DECOUPLING_FAR.json'), 'utf8')) as Rule

describe('RuleView', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      setConfig: vi.fn().mockResolvedValue({ overrides: {} }),
      getRules: vi.fn().mockResolvedValue({ rules: [], errors: [], bundledDir: '', userRulesDir: '' }),
      copyText: vi.fn(),
      openExternal: vi.fn(),
      openRuleFile: vi.fn()
    }
    useStore.setState({
      config: { userRulesDir: '', api: { enabled: true, port: 1, host: 'x' }, overrides: {} },
      report: { board: 'b', generated: 'g', findings: [{ code: 'DECOUPLING_FAR', severity: 'warning', title: 'C3 far', x: 1, y: 2, layer: 'F.Cu' }] }
    })
  })
  it('renders a bundled rule with both diagrams, params and last-report hits', () => {
    render(<RuleView rule={applyOverride(rule, { params: { decoupling_max_dist_small: 4 } })} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(rule.title)
    expect(screen.getByText('Погано')).toBeInTheDocument()
    expect(screen.getByText('Добре')).toBeInTheDocument()
    expect(document.querySelectorAll('svg').length - document.querySelectorAll('.param-reset svg').length).toBe(2) // the two diagrams
    expect(screen.getByDisplayValue('4')).toBeInTheDocument() // overridden param
    expect(screen.getByText(/Останній звіт: 1/)).toBeInTheDocument()
    expect(screen.getByText('C3 far')).toBeInTheDocument()
    expect(screen.getByText('decoupling')).toBeInTheDocument() // the engine kernel
  })
})
