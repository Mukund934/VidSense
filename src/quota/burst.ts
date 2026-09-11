/**
 * A short-window rate limit, held in memory.
 *
 * This is the control that stops a retry loop, and it is deliberately *not*
 * persisted. Two reasons, and the second is the real one:
 *
 *   1. A Firestore read and write on every request — including the ones being
 *      refused — would spend the free tier's 20,000 daily writes on telling
 *      people no. The daily budget in `./budget.ts` is persisted because losing
 *      it would matter; a one-minute window is not worth a write.
 *   2. It is the same posture the ingest single-flight already takes
 *      (`src/ingest/orchestrator.ts`). Through Stage B this runs as one process,
 *      so one process is where the counter belongs.
 *
 * **What that costs, stated plainly:** across several instances each gets its
 * own window, so the effective burst limit is the configured one multiplied by
 * the number of instances. That is acceptable here only because the *daily*
 * cap is shared and persisted — the burst limit shapes traffic, it does not
 * bound spend. If this ever becomes the thing standing between a user and the
 * bill, it has to move to shared storage first.
 */

/** Milliseconds in the window every limit is expressed over. */
export const WINDOW_MS = 60_000

/**
 * How many keys to hold before sweeping expired ones.
 *
 * Without a bound, a burst of unique visitor ids would grow this map for the
 * life of the process. The sweep is O(keys) and runs rarely, which is the right
 * trade for something on the request path.
 */
const SWEEP_AT = 1_000

export class BurstLimiter {
  /** Key to the timestamps of its recent hits, oldest first. */
  private readonly hits = new Map<string, number[]>()

  constructor(private readonly windowMs: number = WINDOW_MS) {}

  /**
   * Claim one slot for `key`.
   *
   * Returns `null` when the claim succeeded, or the whole number of seconds to
   * wait before it would. A refused claim is **not** recorded: counting the
   * attempts as well as the successes would let a client extend its own
   * timeout by continuing to hammer, which is precisely the behaviour this
   * exists to discourage.
   */
  claim(key: string, limit: number, now: number): number | null {
    if (limit <= 0) return Math.ceil(this.windowMs / 1000)

    const cutoff = now - this.windowMs
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff)

    if (recent.length >= limit) {
      this.hits.set(key, recent)
      const oldest = recent[0] ?? now
      // When the oldest hit leaves the window, a slot opens.
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000))
    }

    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > SWEEP_AT) this.sweep(now)
    return null
  }

  /** Drop keys with nothing left inside the window. */
  sweep(now: number): void {
    const cutoff = now - this.windowMs
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => t > cutoff)
      if (recent.length === 0) this.hits.delete(key)
      else this.hits.set(key, recent)
    }
  }

  /** Hits currently inside the window for `key`. Exists for tests and debug. */
  count(key: string, now: number): number {
    const cutoff = now - this.windowMs
    return (this.hits.get(key) ?? []).filter((t) => t > cutoff).length
  }

  /** Number of keys held. Exists so the sweep can be proven to work. */
  size(): number {
    return this.hits.size
  }

  /** Forget everything. Used between tests. */
  reset(): void {
    this.hits.clear()
  }
}
