/**
 * What happens when the ledger itself will not answer.
 *
 * The deployment counter is a single document, so a crowd contends on it and
 * Firestore eventually aborts a transaction rather than let it wait for ever.
 * That is not the same thing as Firestore being down, and the two must not be
 * handled the same way:
 *
 *   - **contention** means the database could not establish whether there was
 *     room. Assuming there is room is most expensive precisely when many
 *     requests are arriving, which is the only time this happens. Refuse.
 *   - **an outage** means storage is unavailable, and this product's whole
 *     posture is that storage is optional. Allow.
 *
 * Getting this backwards is quiet and expensive: a ceiling that switches itself
 * off under load is worse than no ceiling, because it looks like one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const claim = vi.fn()
const release = vi.fn(async () => undefined)
const settleDeployment = vi.fn(async () => undefined)

vi.mock('@/data/deployment', async (original) => {
  const actual = await original<typeof import('@/data/deployment')>()
  return {
    ...actual,
    FirestoreDeploymentStore: class {
      claim = (...args: unknown[]) => claim(...args)
      release = release
      settle = settleDeployment
      read = async () => ({
        day: '',
        ingest: 0,
        ask: 0,
        videoSeconds: 0,
        reservedSeconds: 0,
        updatedAt: 0,
      })
    },
  }
})

// Truthy, so the module reaches for the Firestore-backed stores rather than the
// in-memory fallbacks. Nothing is ever called on it.
vi.mock('@/lib/server/deps', () => ({ firestore: () => ({}) }))

function abortedError(): Error & { code: number } {
  return Object.assign(new Error('10 ABORTED: Transaction lock timeout.'), { code: 10 })
}

const original = { ...process.env }

beforeEach(async () => {
  vi.resetModules()
  claim.mockReset()
  // Reset strips the implementation as well as the calls, and these are awaited
  // — without this they return undefined and `settle` throws on `.catch`.
  release.mockReset()
  release.mockResolvedValue(undefined)
  settleDeployment.mockReset()
  settleDeployment.mockResolvedValue(undefined)
  process.env.INGESTS_PER_DAY = '100'
  process.env.INGESTS_PER_MINUTE = '100'
})

afterEach(() => {
  process.env = { ...original }
})

async function spend() {
  const quota = await import('@/lib/server/quota')
  quota.resetQuota()
  return quota.spend('alice', 'ingest')
}

describe('when the deployment ledger aborts', () => {
  it('refuses, rather than assuming there was room', async () => {
    claim.mockRejectedValue(abortedError())

    const result = await spend()
    expect(result.decision.allowed).toBe(false)
  })

  it('asks the caller back in seconds, not tomorrow', async () => {
    // The condition clears as soon as the crowd does, so a retry-after measured
    // in hours would be a lie that costs the rest of the day.
    claim.mockRejectedValue(abortedError())

    const { decision } = await spend()
    expect(decision.retryAfterSec).toBeLessThanOrEqual(30)
    expect(decision.message).toContain('busy')
  })

  it('recognises the abort from its message alone', async () => {
    // The emulator and the live service word this differently, and the code is
    // not always attached to what reaches us.
    claim.mockRejectedValue(new Error('too much contention on these documents'))

    expect((await spend()).decision.allowed).toBe(false)
  })

  it('does not charge the user for a request it refused', async () => {
    claim.mockRejectedValue(abortedError())
    await spend()

    const { usageToday } = await import('@/lib/server/quota')
    expect((await usageToday('alice')).ingest).toBe(0)
  })
})

describe('when the deployment ledger is simply unreachable', () => {
  it('allows the request, because storage is optional here', async () => {
    // A Firestore outage must degrade rather than close the product. The burst
    // limiter cannot fail — it is a map — so a retry loop still hits a wall.
    claim.mockRejectedValue(new Error('14 UNAVAILABLE: no connection established'))

    expect((await spend()).decision.allowed).toBe(true)
  })

  it('allows on an error it has never seen before', async () => {
    // The unrecognised case has to fall to the side that keeps the product
    // working, or every new error message becomes an outage.
    claim.mockRejectedValue(new Error('something nobody anticipated'))

    expect((await spend()).decision.allowed).toBe(true)
  })
})

describe('when the ledger answers normally', () => {
  it('passes the reservation back for settlement', async () => {
    claim.mockResolvedValue({
      decision: { allowed: true, meter: 'ingest', used: 1, limit: 100, message: '' },
      reservation: 'res-1',
    })

    const result = await spend()
    expect(result.decision.allowed).toBe(true)
    expect(result.reservation).toBe('res-1')
  })

  it('releases the reservation when the work cost nothing', async () => {
    claim.mockResolvedValue({
      decision: { allowed: true, meter: 'ingest', used: 1, limit: 100, message: '' },
      reservation: 'res-1',
    })

    const quota = await import('@/lib/server/quota')
    quota.resetQuota()
    const spent = await quota.spend('alice', 'ingest')
    await quota.settle(spent, { charged: false })

    expect(release).toHaveBeenCalledWith('ingest', 'res-1', expect.any(Number))
  })

  it('settles the reservation to the real duration when it did', async () => {
    claim.mockResolvedValue({
      decision: { allowed: true, meter: 'ingest', used: 1, limit: 100, message: '' },
      reservation: 'res-1',
    })

    const quota = await import('@/lib/server/quota')
    quota.resetQuota()
    const spent = await quota.spend('alice', 'ingest')
    await quota.settle(spent, { charged: true, seconds: 240 })

    expect(settleDeployment).toHaveBeenCalledWith('ingest', 'res-1', 240, expect.any(Number))
  })

  it('refuses without reserving anything when the deployment is full', async () => {
    claim.mockResolvedValue({
      decision: { allowed: false, meter: 'ingest', used: 0, limit: 0, message: 'full' },
    })

    const result = await spend()
    expect(result.decision.allowed).toBe(false)
    expect(result.reservation).toBeUndefined()

    // And the user keeps their own budget: they did nothing.
    const { usageToday } = await import('@/lib/server/quota')
    expect((await usageToday('alice')).ingest).toBe(0)
  })
})
