/**
 * The deployment ceiling.
 *
 * The property under test is the one the whole feature exists for: **actual
 * consumption can never exceed the ceiling, under any amount of concurrency.**
 * Everything else here is in service of that, or of the two ways it could be
 * lost — a reservation that is never given back, and a refund applied to one
 * ledger but not the other.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryDeploymentStore, admits, liveReservations } from '@/data/deployment'
import { DEFAULT_DEPLOYMENT_LIMITS, RESERVATION_TTL_MS, type DeploymentLimits } from '@/quota/budget'

const T0 = Date.UTC(2026, 8, 11, 12, 0, 0)
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR = 60 * 60

/** A small ceiling so the boundary is reached in a few calls. */
const limits: DeploymentLimits = {
  videoSecondsPerDay: 3 * HOUR,
  ingestsPerDay: 10,
  asksPerDay: 4,
}
/** Stand-in for MAX_DURATION_SEC: the worst a single video could turn out to be. */
const WORST = 1 * HOUR

let store: InMemoryDeploymentStore

beforeEach(() => {
  store = new InMemoryDeploymentStore()
})

describe('admits', () => {
  const empty = { ingest: 0, ask: 0, videoSeconds: 0 }

  it('allows a claim that fits', () => {
    expect(admits(empty, 0, 'ingest', limits, WORST)).toBe(true)
  })

  it('counts what is already reserved, not only what is spent', () => {
    // Two hours held by requests in flight, one hour already spent: a third
    // hour would take the worst case over three.
    expect(admits({ ...empty, videoSeconds: 1 * HOUR }, 2 * HOUR, 'ingest', limits, WORST)).toBe(
      false,
    )
  })

  it('refuses when the worst case would not fit, even though the average would', () => {
    // This is the trade the design makes on purpose. Both in-flight videos may
    // turn out to be three minutes long, and it still refuses, because at the
    // moment of the decision they could each be an hour.
    expect(admits(empty, 2 * HOUR, 'ingest', limits, WORST)).toBe(true)
    expect(admits(empty, 3 * HOUR, 'ingest', limits, WORST)).toBe(false)
  })

  it('refuses on the count even when there are hours to spare', () => {
    expect(admits({ ...empty, ingest: 10 }, 0, 'ingest', limits, WORST)).toBe(false)
  })

  it('judges a question on its own count and nothing else', () => {
    // A question sends no video, so the hours must not gate it.
    expect(admits({ ...empty, videoSeconds: 999 * HOUR }, 999 * HOUR, 'ask', limits, WORST)).toBe(
      true,
    )
    expect(admits({ ...empty, ask: 4 }, 0, 'ask', limits, WORST)).toBe(false)
  })
})

describe('liveReservations', () => {
  it('adds up what is still in flight', () => {
    const { seconds } = liveReservations(
      { a: { seconds: 100, expiresAt: T0 + 1 }, b: { seconds: 50, expiresAt: T0 + 1 } },
      T0,
    )
    expect(seconds).toBe(150)
  })

  it('drops holds that have expired', () => {
    const { live, seconds } = liveReservations(
      { alive: { seconds: 100, expiresAt: T0 + 1 }, dead: { seconds: 500, expiresAt: T0 - 1 } },
      T0,
    )
    expect(seconds).toBe(100)
    expect(Object.keys(live)).toEqual(['alive'])
  })

  it('ignores anything malformed rather than trusting it', () => {
    // A ceiling that can be lifted by a bad value in one field is not a ceiling.
    const { seconds } = liveReservations(
      { a: null, b: 'nope', c: { seconds: -5, expiresAt: T0 + 1 }, d: { seconds: 10 } },
      T0,
    )
    expect(seconds).toBe(0)
  })

  it('treats a missing map as nothing held', () => {
    expect(liveReservations(undefined, T0).seconds).toBe(0)
  })
})

describe('InMemoryDeploymentStore', () => {
  it('holds the worst case until the claim is settled', async () => {
    const claim = await store.claim('ingest', limits, WORST, T0)

    expect(claim.decision.allowed).toBe(true)
    expect(claim.reservation).toBeTruthy()
    expect((await store.read(T0)).reservedSeconds).toBe(WORST)
    expect((await store.read(T0)).videoSeconds).toBe(0)
  })

  it('turns the hold into the real duration on settlement', async () => {
    const claim = await store.claim('ingest', limits, WORST, T0)
    await store.settle('ingest', claim.reservation, 240, T0)

    const usage = await store.read(T0)
    expect(usage.reservedSeconds).toBe(0)
    expect(usage.videoSeconds).toBe(240)
    expect(usage.ingest).toBe(1)
  })

  it('gives back both the hold and the count when nothing was spent', async () => {
    const claim = await store.claim('ingest', limits, WORST, T0)
    await store.release('ingest', claim.reservation, T0)

    const usage = await store.read(T0)
    expect(usage.reservedSeconds).toBe(0)
    expect(usage.videoSeconds).toBe(0)
    expect(usage.ingest).toBe(0)
  })

  describe('the guarantee', () => {
    it('never lets reservations exceed the ceiling', async () => {
      // Twenty callers at once against three hours of ceiling and an hour of
      // worst case. However many get in, what they are collectively permitted
      // to send cannot exceed the ceiling — which is the entire point, because
      // actual consumption is never more than what was reserved.
      const claims = await Promise.all(
        Array.from({ length: 20 }, () => store.claim('ingest', limits, WORST, T0)),
      )
      const admitted = claims.filter((c) => c.decision.allowed)

      expect(admitted).toHaveLength(3)
      expect(admitted.length * WORST).toBeLessThanOrEqual(limits.videoSecondsPerDay)
      expect((await store.read(T0)).reservedSeconds).toBe(3 * HOUR)
    })

    it('lets more through than the ceiling would allow unsettled', async () => {
      // The pessimism is transient: once three one-minute videos settle, the
      // hours they were holding come back and more can start.
      //
      // Five, not six, and the arithmetic is worth stating because it is the
      // honest cost of reserving the worst case. Round one admits three (0, 1h
      // and 2h reserved, each plus 1h, all within 3h) and settles them at 60s,
      // leaving 180s spent. Round two admits two more, and the third is refused
      // at 180 + 2h + 1h = 3h and 180s — over by exactly the three minutes
      // already spent. A coarse reservation buys the guarantee, and this is
      // what it costs.
      let admitted = 0
      for (let round = 0; round < 2; round += 1) {
        const claims = await Promise.all(
          Array.from({ length: 3 }, () => store.claim('ingest', limits, WORST, T0)),
        )
        for (const c of claims) {
          if (!c.decision.allowed) continue
          admitted += 1
          await store.settle('ingest', c.reservation, 60, T0)
        }
      }

      const usage = await store.read(T0)
      expect(admitted).toBe(5)
      expect(usage.ingest).toBe(5)
      expect(usage.videoSeconds).toBe(300)
      expect(usage.reservedSeconds).toBe(0)
    })

    it('refuses once the settled hours alone fill the day', async () => {
      const claim = await store.claim('ingest', limits, WORST, T0)
      await store.settle('ingest', claim.reservation, 3 * HOUR, T0)

      expect((await store.claim('ingest', limits, WORST, T0)).decision.allowed).toBe(false)
    })
  })

  describe('a request that dies mid-flight', () => {
    it('does not hold the budget for the rest of the day', async () => {
      // Without expiry, one crash between claiming and settling would take an
      // hour of a three-hour day out of circulation until midnight.
      await store.claim('ingest', limits, WORST, T0)
      await store.claim('ingest', limits, WORST, T0)
      await store.claim('ingest', limits, WORST, T0)
      expect((await store.claim('ingest', limits, WORST, T0)).decision.allowed).toBe(false)

      const later = T0 + RESERVATION_TTL_MS + 1
      expect((await store.claim('ingest', limits, WORST, later)).decision.allowed).toBe(true)
    })

    it('still holds the budget while the request could plausibly be running', () => {
      // The route's own maxDuration is 300s, so a hold must outlive that or a
      // slow ingest would have its reservation reclaimed underneath it.
      expect(RESERVATION_TTL_MS).toBeGreaterThan(300_000)
    })

    it('compacts dead holds even when the claim that finds them is refused', async () => {
      for (let i = 0; i < 3; i += 1) await store.claim('ingest', limits, WORST, T0)

      // A closed count means this claim is refused, and it must still clear the
      // three expired holds on its way out — otherwise a ceiling that filled up
      // with dead reservations would stay shut until something succeeded, and
      // nothing can succeed while it is shut.
      const later = T0 + RESERVATION_TTL_MS + 1
      const closed: DeploymentLimits = { ...limits, ingestsPerDay: 0 }
      const { decision } = await store.claim('ingest', closed, WORST, later)

      expect(decision.allowed).toBe(false)
      expect((await store.read(later)).reservedSeconds).toBe(0)
    })
  })

  describe('questions', () => {
    it('are counted and refused on their own limit', async () => {
      for (let i = 0; i < 4; i += 1) {
        expect((await store.claim('ask', limits, WORST, T0)).decision.allowed).toBe(true)
      }
      expect((await store.claim('ask', limits, WORST, T0)).decision.allowed).toBe(false)
    })

    it('take no reservation, because they send no video', async () => {
      const claim = await store.claim('ask', limits, WORST, T0)
      expect(claim.reservation).toBeUndefined()
      expect((await store.read(T0)).reservedSeconds).toBe(0)
    })
  })

  it('says the product is full rather than blaming the reader', async () => {
    const closed: DeploymentLimits = { ...limits, ingestsPerDay: 0 }
    const { decision } = await store.claim('ingest', closed, WORST, T0)

    expect(decision.message).toContain('VidSense itself')
    expect(decision.message).toContain('nothing you did')
    // Never "your limit": they may not have spent a thing.
    expect(decision.message).not.toContain('your')
  })

  it('starts fresh on the next UTC day', async () => {
    const claim = await store.claim('ingest', limits, WORST, T0)
    await store.settle('ingest', claim.reservation, 3 * HOUR, T0)
    expect((await store.claim('ingest', limits, WORST, T0)).decision.allowed).toBe(false)

    expect((await store.claim('ingest', limits, WORST, T0 + DAY_MS)).decision.allowed).toBe(true)
  })
})

describe('the shipped defaults', () => {
  it('leave headroom under the provider ceiling the research recorded', () => {
    // ARCHITECTURE §6: the Gemini free tier allows about 8 hours of YouTube
    // video a day for the whole project. Our count and Google's cannot be
    // assumed identical, so the ceiling is set below theirs on purpose.
    expect(DEFAULT_DEPLOYMENT_LIMITS.videoSecondsPerDay).toBeLessThan(8 * HOUR)
  })

  it('still admit more than one ingest at a time', async () => {
    // If the ceiling ever drops below twice the worst case, the product
    // silently becomes single-file. That is a real regression and it would not
    // show up anywhere else.
    const maxDurationSec = Math.round(2.5 * HOUR)
    expect(DEFAULT_DEPLOYMENT_LIMITS.videoSecondsPerDay).toBeGreaterThanOrEqual(2 * maxDurationSec)
  })
})
