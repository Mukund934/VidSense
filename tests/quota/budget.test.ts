/**
 * The budget arithmetic and the wording that goes with it.
 *
 * The wording is tested because it is the product. A cap that reads as a fault
 * sends someone to a support channel; a cap that says what ran out and when it
 * comes back sends them to lunch.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LIMITS,
  dayKey,
  emptyUsage,
  limitsFrom,
  msUntilNextDay,
  refusedForNow,
  refusedForToday,
  wouldExceed,
  type Limits,
} from '@/quota/budget'

const NOON_UTC = Date.UTC(2026, 8, 11, 12, 0, 0)

describe('dayKey', () => {
  it('is the UTC calendar day', () => {
    expect(dayKey(NOON_UTC)).toBe('2026-09-11')
  })

  it('does not move with the local timezone', () => {
    // Both of these are the same instant. A key derived from local time would
    // hand anyone a second budget by changing a system setting.
    expect(dayKey(Date.UTC(2026, 8, 11, 23, 59, 59))).toBe('2026-09-11')
    expect(dayKey(Date.UTC(2026, 8, 12, 0, 0, 0))).toBe('2026-09-12')
  })
})

describe('msUntilNextDay', () => {
  it('is the rest of the UTC day', () => {
    expect(msUntilNextDay(NOON_UTC)).toBe(12 * 60 * 60 * 1000)
  })

  it('is a full day at exactly midnight', () => {
    expect(msUntilNextDay(Date.UTC(2026, 8, 11, 0, 0, 0))).toBe(24 * 60 * 60 * 1000)
  })

  it('is never zero or negative', () => {
    expect(msUntilNextDay(Date.UTC(2026, 8, 11, 23, 59, 59, 999))).toBeGreaterThan(0)
  })
})

describe('wouldExceed', () => {
  const usage = { ...emptyUsage(NOON_UTC), ingest: 4 }

  it('allows the last unit inside the limit', () => {
    expect(wouldExceed(usage, 'ingest', DEFAULT_LIMITS)).toBe(false)
  })

  it('refuses the one after it', () => {
    expect(wouldExceed({ ...usage, ingest: 5 }, 'ingest', DEFAULT_LIMITS)).toBe(true)
  })

  it('counts each meter on its own', () => {
    // Spending every question must not cost a video.
    const spent = { ...emptyUsage(NOON_UTC), ask: DEFAULT_LIMITS.perDay.ask }
    expect(wouldExceed(spent, 'ingest', DEFAULT_LIMITS)).toBe(false)
    expect(wouldExceed(spent, 'ask', DEFAULT_LIMITS)).toBe(true)
  })
})

describe('the refusal a user reads', () => {
  it('says what ran out and when it returns', () => {
    const decision = refusedForToday('ingest', 5, 5, NOON_UTC)
    expect(decision.allowed).toBe(false)
    expect(decision.message).toContain('5 videos')
    expect(decision.message).toContain('12 hours')
  })

  it('says it is a limit rather than a fault', () => {
    // Someone who thinks the product is broken behaves very differently from
    // someone who knows they have used their five videos.
    expect(refusedForToday('ingest', 5, 5, NOON_UTC).message).toContain('not a fault')
  })

  it('carries a retry-after that lands after the reset', () => {
    const decision = refusedForToday('ask', 50, 50, NOON_UTC)
    expect(decision.retryAfterSec).toBe(12 * 60 * 60)
  })

  it('uses the singular when the limit is one', () => {
    expect(refusedForToday('ingest', 1, 1, NOON_UTC).message).toContain('1 video')
  })

  it('says something different when it is only a burst', () => {
    const decision = refusedForNow('ask', 12, 20)
    expect(decision.message).toContain('20 seconds')
    expect(decision.message).not.toContain('hours')
    expect(decision.retryAfterSec).toBe(20)
  })
})

describe('limitsFrom', () => {
  it('falls back to the defaults when nothing is set', () => {
    expect(limitsFrom({})).toEqual(DEFAULT_LIMITS)
  })

  it('takes a number from the environment', () => {
    const limits: Limits = limitsFrom({ INGESTS_PER_DAY: '2', ASKS_PER_DAY: '9' })
    expect(limits.perDay.ingest).toBe(2)
    expect(limits.perDay.ask).toBe(9)
  })

  it('allows zero, which is a real setting and means closed', () => {
    expect(limitsFrom({ INGESTS_PER_DAY: '0' }).perDay.ingest).toBe(0)
  })

  it.each(['', '   ', 'lots', '-1', '2.5', 'NaN', 'Infinity'])(
    'falls back rather than trusting %j',
    (value) => {
      // The dangerous failure is not a crash. It is a typo being read as "no
      // limit" on a route that spends somebody else's quota.
      expect(limitsFrom({ INGESTS_PER_DAY: value }).perDay.ingest).toBe(
        DEFAULT_LIMITS.perDay.ingest,
      )
    },
  )
})
