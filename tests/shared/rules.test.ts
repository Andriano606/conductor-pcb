import { describe, expect, it } from 'vitest'
import {
  applyOverride,
  defaultConfig,
  exportCheckerConfig,
  filterRules,
  mergeConfig,
  sortRules,
  validateRule
} from '@shared/rules'
import { sampleRule } from '../helpers/sample'


describe('validateRule', () => {
  it('accepts a well-formed rule', () => {
    expect(validateRule(sampleRule())).toEqual([])
  })
  it('rejects bad code, category, severity and missing scenes', () => {
    const p = validateRule({ ...sampleRule(), code: 'bad code', category: 'x', severity: 'fatal', examples: {} })
    expect(p.join('\n')).toMatch(/code/)
    expect(p.join('\n')).toMatch(/category/)
    expect(p.join('\n')).toMatch(/severity/)
    expect(p.join('\n')).toMatch(/examples\.bad/)
  })
  it('rejects a track with one point', () => {
    const r = sampleRule()
    r.examples.good.items = [{ t: 'track', pts: [[0, 0]], w: 0.2, layer: 'F' }]
    expect(validateRule(r).join()).toMatch(/track/)
  })
})

describe('applyOverride', () => {
  it('uses rule defaults without an override', () => {
    const e = applyOverride(sampleRule(), undefined)
    expect(e.effective).toEqual({ enabled: true, severity: 'warning', params: { thr: 3 } })
  })
  it('applies enabled/severity/params and ignores unknown params', () => {
    const e = applyOverride(sampleRule(), { enabled: false, severity: 'error', params: { thr: 5, nope: 1 } })
    expect(e.effective).toEqual({ enabled: false, severity: 'error', params: { thr: 5 } })
  })
})

describe('exportCheckerConfig', () => {
  it('flattens thresholds, lists disabled codes and severity overrides', () => {
    const a = applyOverride(sampleRule({ code: 'A_RULE' }), { params: { thr: 7 } })
    const b = applyOverride(sampleRule({ code: 'B_RULE', params: [{ key: 'other', label: 'o', default: 1 }] }), { enabled: false, severity: 'info' })
    const out = exportCheckerConfig([a, b], new Date('2026-09-16T00:00:00Z'))
    expect(out.thr).toBe(7)
    expect(out.other).toBe(1)
    expect(out.ignore_codes).toEqual(['B_RULE'])
    expect(out.severities).toEqual({ B_RULE: 'info' })
    expect(out.generated).toBe('2026-09-16T00:00:00.000Z')
  })
  it('lets an explicit value win over a default for a shared key', () => {
    const a = applyOverride(sampleRule({ code: 'A_RULE' }), undefined) // thr default 3
    const b = applyOverride(sampleRule({ code: 'B_RULE' }), { params: { thr: 9 } })
    expect(exportCheckerConfig([a, b]).thr).toBe(9)
    expect(exportCheckerConfig([b, a]).thr).toBe(9)
  })
})

describe('mergeConfig', () => {
  const base = defaultConfig('/home/x')
  it('merges nested api and overrides, dropping null overrides', () => {
    const c1 = mergeConfig(base, { api: { ...base.api, port: 5000 }, overrides: { R1: { enabled: false } } })
    expect(c1.api.port).toBe(5000)
    expect(c1.overrides.R1?.enabled).toBe(false)
    const c2 = mergeConfig(c1, { overrides: { R1: null as unknown as { enabled: boolean } } })
    expect(c2.overrides.R1).toBeUndefined()
  })
  it('keeps the old port when the new one is invalid', () => {
    expect(mergeConfig(base, { api: { ...base.api, port: 70000 } }).api.port).toBe(base.api.port)
  })
  it('merges params override without clobbering other params', () => {
    const c1 = mergeConfig(base, { overrides: { R1: { params: { a: 1 } } } })
    const c2 = mergeConfig(c1, { overrides: { R1: { params: { b: 2 } } } })
    expect(c2.overrides.R1?.params).toEqual({ a: 1, b: 2 })
  })
})

describe('sortRules / filterRules', () => {
  it('sorts by category order then severity then code', () => {
    const rules = [
      sampleRule({ code: 'Z', category: 'signal', severity: 'info' }),
      sampleRule({ code: 'B', category: 'power', severity: 'warning' }),
      sampleRule({ code: 'A', category: 'power', severity: 'error' })
    ]
    expect(sortRules(rules).map((r) => r.code)).toEqual(['A', 'B', 'Z'])
  })
  it('filters by code, title, summary, tags (case-insensitive)', () => {
    const rules = [sampleRule({ code: 'ONE', title: 'Кварц', tags: ['xtal'] }), sampleRule({ code: 'TWO', title: 'Земля' })]
    expect(filterRules(rules, 'кварц').map((r) => r.code)).toEqual(['ONE'])
    expect(filterRules(rules, 'XTAL').map((r) => r.code)).toEqual(['ONE'])
    expect(filterRules(rules, 'two').map((r) => r.code)).toEqual(['TWO'])
    expect(filterRules(rules, '')).toHaveLength(2)
  })
})
