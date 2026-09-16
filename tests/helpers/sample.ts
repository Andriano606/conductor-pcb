import type { Rule } from '@shared/types'

export function sampleRule(over: Partial<Rule> = {}): Rule {
  return {
    code: 'TEST_RULE',
    title: 'Тест',
    category: 'power',
    severity: 'warning',
    summary: 'sum',
    description: 'desc',
    why: 'why',
    fix: 'fix',
    params: [{ key: 'thr', label: 'Поріг', default: 3, type: 'number' }],
    checker: { engine: 'pcbagent', function: 'f' },
    check: { kernel: 'f', emits: 'TEST_RULE' },
    tags: ['a'],
    references: [],
    examples: {
      bad: { w: 10, h: 10, verdict: 'bad', caption: 'b', items: [{ t: 'board', x: 0, y: 0, w: 10, h: 10 }] },
      good: { w: 10, h: 10, verdict: 'good', caption: 'g', items: [] }
    },
    enabled: true,
    ...over
  }
}
