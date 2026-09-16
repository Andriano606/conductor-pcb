import { describe, expect, it } from 'vitest'
import { applyOverrides, mergeOverride, overrideIsEmpty, validateRule, withProjectOverride } from '@shared/rules'
import { sampleRule } from '../helpers/sample'
import type { PcbProject } from '@shared/types'

const proj: PcbProject = { id: 'p1', name: 'b', dir: '/b', proFile: '', boardFile: '/b/b.kicad_pcb', createdAt: 1, sessions: [{ id: 'p1', createdAt: 1 }] }

describe('project-scoped overrides', () => {
  it('merges project override on top of the global one, params key by key', () => {
    expect(mergeOverride(undefined, undefined)).toBeUndefined()
    expect(mergeOverride({ enabled: false, params: { a: 1, b: 2 } }, { severity: 'info', params: { b: 3 } })).toEqual({ enabled: false, severity: 'info', params: { a: 1, b: 3 } })
    const rules = applyOverrides([sampleRule({ code: 'R1' })], { R1: { params: { thr: 4 } } }, { R1: { enabled: false } })
    expect(rules[0].effective).toEqual({ enabled: false, severity: 'warning', params: { thr: 4 } })
  })
  it('withProjectOverride sets, merges and removes on the right project only', () => {
    const l1 = withProjectOverride([proj, { ...proj, id: 'p2' }], 'p1', 'R1', { params: { thr: 9 } })
    expect(l1[0].ruleOverrides).toEqual({ R1: { params: { thr: 9 } } })
    expect(l1[1].ruleOverrides).toBeUndefined()
    const l2 = withProjectOverride(l1, 'p1', 'R1', { enabled: false })
    expect(l2[0].ruleOverrides?.R1).toEqual({ enabled: false, params: { thr: 9 } })
    expect(withProjectOverride(l2, 'p1', 'R1', null)[0].ruleOverrides).toEqual({})
  })
})

describe('validateRule check block', () => {
  it('overrideIsEmpty ignores empty params objects', () => {
    expect(overrideIsEmpty(undefined)).toBe(true)
    expect(overrideIsEmpty({})).toBe(true)
    expect(overrideIsEmpty({ params: {} })).toBe(true)
    expect(overrideIsEmpty({ enabled: false })).toBe(false)
    expect(overrideIsEmpty({ params: { thr: 1 } })).toBe(false)
  })
  it('requires check.kernel for pcbagent rules and validates its shape', () => {
    const noCheck = { ...sampleRule(), check: undefined }
    expect(validateRule(noCheck).join()).toMatch(/check:/)
    expect(validateRule({ ...sampleRule(), check: { kernel: 'decoupling', emits: 'DECOUPLING_FAR', args: { x: 1 } } })).toEqual([])
    expect(validateRule({ ...sampleRule(), check: { kernel: 'Bad Kernel' } }).join()).toMatch(/kernel/)
    expect(validateRule({ ...sampleRule(), check: { kernel: 'ok', emits: 'lower' } }).join()).toMatch(/emits/)
    expect(validateRule({ ...sampleRule(), check: { kernel: 'ok', args: [1] } }).join()).toMatch(/args/)
    // kicad-drc rules do not need a check block
    expect(validateRule({ ...sampleRule(), check: undefined, checker: { engine: 'kicad-drc' } })).toEqual([])
  })
})
