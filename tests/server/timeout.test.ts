import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STORAGE_TIMEOUT_MS, StorageTimeoutError, withTimeout } from '@/lib/server/timeout'

/**
 * Degradation on a clock.
 *
 * Every Firestore call in this product already degrades — a cache miss, a
 * forgotten history row, a cap that allows rather than refuses. None of it
 * helped, because a client pointed at somewhere nothing is listening does not
 * fail: it retries for about ninety seconds. Measured against a
 * configured-but-absent emulator, an ingest sat on the first stage for 86 s and
 * then threw, having spent most of a 300-second function budget arriving at a
 * degraded mode it could have reached immediately.
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const never = () => new Promise<string>(() => {})

describe('withTimeout', () => {
  it('passes a value straight through', async () => {
    await expect(withTimeout('read', Promise.resolve('done'))).resolves.toBe('done')
  })

  it('passes a rejection straight through, unchanged', async () => {
    // A real storage error must stay a real storage error: `isContention` in
    // the quota module reads its code, and wrapping it would lose that.
    const boom = new Error('PERMISSION_DENIED')
    await expect(withTimeout('read', Promise.reject(boom))).rejects.toBe(boom)
  })

  it('rejects once the deadline passes', async () => {
    const pending = withTimeout('videos.get', never(), 5_000)
    const assertion = expect(pending).rejects.toBeInstanceOf(StorageTimeoutError)
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })

  it('names the operation, so a log line says which store hung', async () => {
    const pending = withTimeout('deployment.claim', never(), 100)
    const assertion = expect(pending).rejects.toThrow(/deployment\.claim did not answer within 100ms/)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it('does not fire early', async () => {
    let settled = false
    void withTimeout('read', never(), 5_000).catch(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
  })

  it('clears its timer on the happy path', async () => {
    // Otherwise every successful read holds the event loop open for the whole
    // window, and a serverless function bills for the waiting.
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    await withTimeout('read', Promise.resolve(1))
    expect(clear).toHaveBeenCalled()
  })

  it('defaults to a bound short enough to matter', () => {
    // Firestore answers a document read in tens of milliseconds. A hundred
    // times that is not slowness, it is absence.
    expect(STORAGE_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
    expect(STORAGE_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000)
  })
})

describe('the quota ledgers degrade rather than hang', () => {
  it('allows the request when the user ledger never answers', async () => {
    vi.resetModules()
    vi.doMock('@/lib/server/deps', () => ({ firestore: () => null }))

    const quota = await import('@/lib/server/quota')
    // A store whose every call hangs is exactly what an unreachable Firestore
    // behaves like for the first ninety seconds.
    vi.spyOn(quota, 'usageStore').mockReturnValue({
      claim: never as never,
      refund: never as never,
      recordSeconds: never as never,
      read: never as never,
    })

    const spent = quota.spend('hung-user', 'ingest')
    await vi.advanceTimersByTimeAsync(STORAGE_TIMEOUT_MS + 50)

    // Allowed, and within the bound rather than ninety seconds later: losing a
    // cap beats losing the product, but only if it happens promptly.
    expect((await spent).decision.allowed).toBe(true)
  })
})
