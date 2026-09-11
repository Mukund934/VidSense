/**
 * The daily ledger, against the in-memory implementation.
 *
 * This is the store a deployment without Firestore credentials actually runs
 * on, so it is tested as a real implementation rather than as a stand-in. The
 * Firestore one is proven against the emulator in `tests/emulator/usage.test.ts`,
 * where the transaction it depends on can be exercised for real.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryUsageStore } from '@/data/usage'
import { DEFAULT_LIMITS, type Limits } from '@/quota/budget'

const DAY_MS = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 8, 11, 12, 0, 0)

const limits: Limits = {
  perDay: { ingest: 2, ask: 3 },
  perMinute: { ingest: 99, ask: 99 },
  videoSecondsPerDay: 10_000,
}

let store: InMemoryUsageStore

beforeEach(() => {
  store = new InMemoryUsageStore()
})

describe('claiming', () => {
  it('allows up to the daily limit and refuses after', async () => {
    expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(true)
    expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(true)

    const third = await store.claim('alice', 'ingest', limits, T0)
    expect(third.allowed).toBe(false)
    expect(third.limit).toBe(2)
  })

  it('reports how much of the budget is now gone', async () => {
    const first = await store.claim('alice', 'ingest', limits, T0)
    expect(first.used).toBe(1)
    expect(first.limit).toBe(2)
  })

  it('does not spend a meter another meter is using', async () => {
    await store.claim('alice', 'ingest', limits, T0)
    await store.claim('alice', 'ingest', limits, T0)

    expect((await store.claim('alice', 'ask', limits, T0)).allowed).toBe(true)
  })

  it('keeps users apart', async () => {
    await store.claim('alice', 'ingest', limits, T0)
    await store.claim('alice', 'ingest', limits, T0)

    // One user exhausting their budget must not close the product for anyone
    // else — that would turn a per-user cap into a shared outage.
    expect((await store.claim('bob', 'ingest', limits, T0)).allowed).toBe(true)
  })

  it('refuses everything when the limit is zero', async () => {
    const closed: Limits = { ...limits, perDay: { ingest: 0, ask: 0 } }
    expect((await store.claim('alice', 'ingest', closed, T0)).allowed).toBe(false)
  })

  it('starts again on the next UTC day', async () => {
    await store.claim('alice', 'ingest', limits, T0)
    await store.claim('alice', 'ingest', limits, T0)
    expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(false)

    expect((await store.claim('alice', 'ingest', limits, T0 + DAY_MS)).allowed).toBe(true)
  })

  it('does not reset merely because hours passed', async () => {
    await store.claim('alice', 'ingest', limits, Date.UTC(2026, 8, 11, 1, 0, 0))
    await store.claim('alice', 'ingest', limits, Date.UTC(2026, 8, 11, 23, 0, 0))

    const late = await store.claim('alice', 'ingest', limits, Date.UTC(2026, 8, 11, 23, 59, 0))
    expect(late.allowed).toBe(false)
  })
})

describe('refunding', () => {
  it('returns a unit so it can be spent again', async () => {
    await store.claim('alice', 'ingest', limits, T0)
    await store.claim('alice', 'ingest', limits, T0)
    expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(false)

    await store.refund('alice', 'ingest', T0)
    expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(true)
  })

  it('never goes below zero', async () => {
    // A refund with nothing claimed is a bug elsewhere; it must not turn into
    // a negative counter that quietly grants extra budget.
    await store.refund('alice', 'ingest', T0)
    await store.refund('alice', 'ingest', T0)

    expect((await store.read('alice', T0)).ingest).toBe(0)
  })

  it('refunds only the meter it was given', async () => {
    await store.claim('alice', 'ask', limits, T0)
    await store.refund('alice', 'ingest', T0)

    expect((await store.read('alice', T0)).ask).toBe(1)
  })
})

describe('recording seconds', () => {
  it('accumulates video actually sent to the provider', async () => {
    await store.recordSeconds('alice', 600, T0)
    await store.recordSeconds('alice', 1_200, T0)

    expect((await store.read('alice', T0)).videoSeconds).toBe(1_800)
  })

  it('ignores nonsense rather than storing it', async () => {
    await store.recordSeconds('alice', 0, T0)
    await store.recordSeconds('alice', -5, T0)
    await store.recordSeconds('alice', Number.NaN, T0)

    expect((await store.read('alice', T0)).videoSeconds).toBe(0)
  })

  it('leaves the count alone while under the seconds budget', async () => {
    await store.recordSeconds('alice', limits.videoSecondsPerDay - 1, T0)

    const decision = await store.claim('alice', 'ingest', limits, T0)
    expect(decision.allowed).toBe(true)
    expect(decision.used).toBe(1)
  })

  it('refuses an ingest once the day of video is spent', async () => {
    // A count of videos cannot bound hours of video on its own: five videos of
    // two and a half hours is twelve and a half hours against a provider
    // ceiling of eight.
    await store.recordSeconds('alice', limits.videoSecondsPerDay, T0)

    const decision = await store.claim('alice', 'ingest', limits, T0)
    expect(decision.allowed).toBe(false)
    expect(decision.message).toContain('of video today')
  })

  it('still allows questions, which do not send video anywhere', async () => {
    await store.recordSeconds('alice', limits.videoSecondsPerDay * 10, T0)
    expect((await store.claim('alice', 'ask', limits, T0)).allowed).toBe(true)
  })

  it('is generous enough for a normal day by default', async () => {
    // Four hours of video is a heavy day and must not hit the wall.
    await store.recordSeconds('alice', 4 * 60 * 60, T0)
    expect((await store.claim('alice', 'ingest', DEFAULT_LIMITS, T0)).allowed).toBe(true)
  })
})

describe('reading', () => {
  it('reports an untouched day as empty rather than missing', async () => {
    const usage = await store.read('nobody', T0)
    expect(usage).toMatchObject({ day: '2026-09-11', ingest: 0, ask: 0, videoSeconds: 0 })
  })
})
