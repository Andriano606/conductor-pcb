import { describe, expect, it } from 'vitest'
import { parseResetTime, parseUsage } from '../../src/main/usagePoller'

describe('parseUsage', () => {
  it('parses the /usage windows with reset times', () => {
    const now = new Date(2026, 5, 20, 12, 0).getTime()
    const w = parseUsage(
      'Current session: 51% used · resets Jun 25, 1:39am (Europe/Kyiv)\nCurrent week (all models): 14% used · resets Jun 30, 10:59pm (Europe/Kyiv)\nCurrent week (Sonnet only): 0% used\njunk line',
      now
    )
    expect(w.map((x) => [x.key, x.label, x.percent])).toEqual([['session', 'Сесія', 51], ['week_all', 'Тиждень', 14], ['week_sonnet', 'Тиждень · Sonnet', 0]])
    expect(w[0].resetText).toBe('Jun 25, 1:39am')
    expect(w[0].resetsAt).toBe(Math.floor(new Date(2026, 5, 25, 1, 39).getTime() / 1000))
    expect(w[2].resetsAt).toBeUndefined()
  })
  it('parseResetTime handles pm/12am and year rollover', () => {
    const now = new Date(2026, 11, 30, 12, 0).getTime()
    expect(parseResetTime('Jan 2, 12:00am', now)).toBe(Math.floor(new Date(2027, 0, 2, 0, 0).getTime() / 1000))
    expect(parseResetTime('Dec 31, 3pm', now)).toBe(Math.floor(new Date(2026, 11, 31, 15, 0).getTime() / 1000))
    expect(parseResetTime('nonsense', now)).toBeUndefined()
  })
})
