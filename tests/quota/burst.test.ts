/**
 * The in-process burst limiter.
 *
 * Every test drives the clock explicitly. A rate limiter tested against the
 * real clock is a rate limiter that fails on a slow machine at some point.
 */

import { describe, expect, it } from 'vitest'

import { BurstLimiter, WINDOW_MS } from '@/quota/burst'

const T0 = Date.UTC(2026, 8, 11, 12, 0, 0)

describe('BurstLimiter', () => {
  it('allows up to the limit', () => {
    const limiter = new BurstLimiter()
    expect(limiter.claim('a', 3, T0)).toBeNull()
    expect(limiter.claim('a', 3, T0 + 1)).toBeNull()
    expect(limiter.claim('a', 3, T0 + 2)).toBeNull()
  })

  it('refuses the one after, with a wait in seconds', () => {
    const limiter = new BurstLimiter()
    for (let i = 0; i < 3; i += 1) limiter.claim('a', 3, T0)
    expect(limiter.claim('a', 3, T0 + 10)).toBeGreaterThan(0)
  })

  it('lets the window slide rather than resetting on a boundary', () => {
    const limiter = new BurstLimiter()
    for (let i = 0; i < 3; i += 1) limiter.claim('a', 3, T0)

    // Just inside the window: still refused.
    expect(limiter.claim('a', 3, T0 + WINDOW_MS - 1)).not.toBeNull()
    // Once the oldest hit falls out, one slot opens.
    expect(limiter.claim('a', 3, T0 + WINDOW_MS + 1)).toBeNull()
  })

  it('does not count a refused attempt', () => {
    // Otherwise hammering the endpoint extends your own timeout, which rewards
    // exactly the behaviour this exists to discourage.
    const limiter = new BurstLimiter()
    limiter.claim('a', 1, T0)
    for (let i = 0; i < 50; i += 1) limiter.claim('a', 1, T0 + 1000 + i)

    expect(limiter.count('a', T0 + 2000)).toBe(1)
    expect(limiter.claim('a', 1, T0 + WINDOW_MS + 1)).toBeNull()
  })

  it('keeps keys apart', () => {
    const limiter = new BurstLimiter()
    limiter.claim('alice', 1, T0)
    // One user hitting their limit must not refuse anybody else.
    expect(limiter.claim('bob', 1, T0)).toBeNull()
  })

  it('refuses everything when the limit is zero', () => {
    expect(new BurstLimiter().claim('a', 0, T0)).toBeGreaterThan(0)
  })

  it('reports a wait that actually lets the next claim through', () => {
    const limiter = new BurstLimiter()
    limiter.claim('a', 1, T0)
    const wait = limiter.claim('a', 1, T0 + 5_000)
    expect(wait).not.toBeNull()
    expect(limiter.claim('a', 1, T0 + 5_000 + (wait ?? 0) * 1000)).toBeNull()
  })

  describe('memory', () => {
    it('forgets keys once their hits leave the window', () => {
      const limiter = new BurstLimiter()
      for (let i = 0; i < 10; i += 1) limiter.claim(`user-${i}`, 5, T0)
      expect(limiter.size()).toBe(10)

      limiter.sweep(T0 + WINDOW_MS + 1)
      expect(limiter.size()).toBe(0)
    })

    it('keeps keys that are still active', () => {
      const limiter = new BurstLimiter()
      limiter.claim('old', 5, T0)
      limiter.claim('recent', 5, T0 + WINDOW_MS)

      limiter.sweep(T0 + WINDOW_MS + 1)
      expect(limiter.count('recent', T0 + WINDOW_MS + 1)).toBe(1)
      expect(limiter.size()).toBe(1)
    })

    it('does not accumulate as visitors churn over time', () => {
      // An anonymous id per visitor is the normal case, so without the sweep
      // this map would grow for the life of the process. What it holds should
      // track how many people are *currently* active, not how many have ever
      // arrived — here, two thousand visitors spread over ten minutes.
      const limiter = new BurstLimiter()
      const spacing = 300
      for (let i = 0; i < 2_000; i += 1) limiter.claim(`visitor-${i}`, 5, T0 + i * spacing)

      const active = Math.ceil(WINDOW_MS / spacing)
      expect(limiter.size()).toBeLessThan(active * 6)
    })

    it('still remembers everyone who arrived inside the window', () => {
      // The flip side, and the reason the bound above is not tighter: hits
      // inside the window are exactly what the limiter is for, so a "bound"
      // that dropped them would be a limiter that stops limiting under load.
      const limiter = new BurstLimiter()
      for (let i = 0; i < 1_500; i += 1) limiter.claim(`visitor-${i}`, 1, T0 + i)

      expect(limiter.claim('visitor-0', 1, T0 + 1_600)).not.toBeNull()
    })
  })
})
