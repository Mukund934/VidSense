import { describe, expect, it, vi } from 'vitest'

import { SWEEP_LIMIT, sweepExpired, type RetentionStore } from '@/data/retention'

/**
 * The sweep is the difference between honouring a retention window and
 * enforcing one. Reads have always skipped an expired document; until this
 * existed, the document stayed in Firestore for ever.
 */

function storeWith(ids: string[], failOn: ReadonlySet<string> = new Set()): RetentionStore & {
  deletedIds: string[]
  asked: Array<{ now: number; limit: number }>
} {
  const deletedIds: string[] = []
  const asked: Array<{ now: number; limit: number }> = []

  return {
    deletedIds,
    asked,
    async expiredVideoIds(now, limit) {
      asked.push({ now, limit })
      return ids.slice(0, limit)
    },
    async deleteVideo(videoId) {
      if (failOn.has(videoId)) throw new Error('permission denied')
      deletedIds.push(videoId)
    },
  }
}

const NOW = Date.UTC(2026, 8, 12)

describe('sweepExpired', () => {
  it('deletes every expired video it was handed', async () => {
    const store = storeWith(['a', 'b', 'c'])
    const report = await sweepExpired(store, NOW)

    expect(store.deletedIds).toEqual(['a', 'b', 'c'])
    expect(report).toEqual({ deleted: 3, failed: 0, more: false })
  })

  it('does nothing, loudly, when nothing has expired', async () => {
    const report = await sweepExpired(storeWith([]), NOW)
    expect(report).toEqual({ deleted: 0, failed: 0, more: false })
  })

  it('asks only for what has expired by the moment it runs', async () => {
    const store = storeWith(['a'])
    await sweepExpired(store, NOW)
    expect(store.asked).toEqual([{ now: NOW, limit: SWEEP_LIMIT }])
  })

  it('carries on past a document it cannot delete', async () => {
    // One undeletable row must not strand the rest. It reappears tomorrow,
    // which is the right retry policy for something that runs daily.
    const store = storeWith(['a', 'b', 'c'], new Set(['b']))
    const report = await sweepExpired(store, NOW)

    expect(store.deletedIds).toEqual(['a', 'c'])
    expect(report.deleted).toBe(2)
    expect(report.failed).toBe(1)
  })

  it('says when there is more to do rather than looping', async () => {
    // A sweep that runs until the collection is clean is one that can outlive
    // its own request timeout, and an interrupted one looks like a failure.
    const store = storeWith(Array.from({ length: 12 }, (_, i) => `v${i}`))
    expect((await sweepExpired(store, NOW, 5)).more).toBe(true)
    expect((await sweepExpired(store, NOW, 50)).more).toBe(false)
  })

  it('never deletes more than the limit in one run', async () => {
    // The limit exists to protect the free tier's 20,000 daily writes, not to
    // make the sweep fast.
    const store = storeWith(Array.from({ length: 500 }, (_, i) => `v${i}`))
    await sweepExpired(store, NOW, 10)
    expect(store.deletedIds).toHaveLength(10)
  })

  it('deletes in the order it was given, one at a time', async () => {
    // Sequential rather than a fan-out: 200 concurrent recursive deletes is a
    // write burst against a quota the product shares with its users.
    const order: string[] = []
    let inFlight = 0
    let peak = 0
    const store: RetentionStore = {
      async expiredVideoIds() {
        return ['a', 'b', 'c']
      },
      async deleteVideo(id) {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        order.push(id)
        inFlight -= 1
      },
    }

    await sweepExpired(store, NOW)
    expect(order).toEqual(['a', 'b', 'c'])
    expect(peak).toBe(1)
  })

  it('propagates a failure to list, because that is not a partial success', async () => {
    const store: RetentionStore = {
      expiredVideoIds: vi.fn().mockRejectedValue(new Error('unavailable')),
      deleteVideo: vi.fn(),
    }
    await expect(sweepExpired(store, NOW)).rejects.toThrow('unavailable')
  })
})
