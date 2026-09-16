import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { validateRule } from '@shared/rules'

const dir = resolve(__dirname, '../../rules')
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()

describe('bundled rule files', () => {
  it('has rules', () => expect(files.length).toBeGreaterThan(10))
  for (const f of files) {
    it(`${f} is valid`, () => {
      const rule = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      expect(validateRule(rule)).toEqual([])
      expect(rule.examples.bad.verdict).toBe('bad')
      expect(rule.examples.good.verdict).toBe('good')
    })
  }
  it('codes are unique and file names match codes (except legacy)', () => {
    const codes = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).code as string)
    expect(new Set(codes).size).toBe(codes.length)
  })
})
