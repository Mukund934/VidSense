/**
 * The daily ledger: what each user has spent today, and whether they may spend
 * more.
 *
 * One document per user per UTC day, at `users/{uid}/usage/{YYYY-MM-DD}`. Old
 * days are simply never read again — there is no sweep, because a handful of
 * tiny documents per user is far cheaper than the reads and writes a cleanup
 * job would cost on a free tier, and because the history is worth keeping: it
 * is the only record of what the product actually consumes, and the limits in
 * `src/quota/budget.ts` were set from guesses that these numbers will correct.
 *
 * **Claiming is transactional and refusal happens inside the transaction.**
 * Reading the counter, deciding, and then writing would let two requests
 * arriving together both see four of five used and both proceed. Firestore
 * transactions retry on contention, so the check and the increment are one
 * indivisible step and the fifth video is only ever spent once.
 *
 * The store is also the reason the cap survives a restart, a new browser, and a
 * cleared cookie — for a signed-in user. An anonymous visitor's identity is a
 * cookie, so their cap is exactly as durable as that cookie, which is a real
 * limitation and is stated rather than papered over: the burst limiter and the
 * *shared* nature of the daily budget are what actually protect the provider
 * quota from someone determined to churn identities.
 */

import type { Firestore } from 'firebase-admin/firestore'

import { paths } from '@/data/schema'

import {
  type Decision,
  type Limits,
  type Meter,
  type Usage,
  allowed,
  dayKey,
  emptyUsage,
  refusedForSeconds,
  refusedForToday,
} from '@/quota/budget'

export interface UsageStore {
  /** Atomically claim one unit of `meter` for today, or refuse. */
  claim(uid: string, meter: Meter, limits: Limits, now: number): Promise<Decision>
  /** Hand back a unit that turned out to cost the provider nothing. */
  refund(uid: string, meter: Meter, now: number): Promise<void>
  /** Record consumption measured after the fact. Never refuses. */
  recordSeconds(uid: string, seconds: number, now: number): Promise<void>
  read(uid: string, now: number): Promise<Usage>
}

/** Read a stored document back into a `Usage`, tolerating anything odd in it. */
function toUsage(day: string, data: Record<string, unknown> | undefined, now: number): Usage {
  const count = (key: string): number => {
    const value = data?.[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }
  if (!data) return { ...emptyUsage(now), day }
  return {
    day,
    ingest: count('ingest'),
    ask: count('ask'),
    videoSeconds: count('videoSeconds'),
    updatedAt: count('updatedAt') || now,
  }
}

export class FirestoreUsageStore implements UsageStore {
  constructor(private readonly db: Firestore) {}

  async claim(uid: string, meter: Meter, limits: Limits, now: number): Promise<Decision> {
    const day = dayKey(now)
    const ref = this.db.doc(paths.usageDay(uid, day))

    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref)
      const usage = toUsage(day, snapshot.data(), now)
      const limit = limits.perDay[meter]

      if (usage[meter] + 1 > limit) return refusedForToday(meter, usage[meter], limit, now)

      // Checked inside the same transaction as the count, so the two budgets
      // cannot disagree about what has been spent.
      if (meter === 'ingest' && usage.videoSeconds >= limits.videoSecondsPerDay) {
        return refusedForSeconds(usage.videoSeconds, limits.videoSecondsPerDay, now)
      }

      const next = usage[meter] + 1
      // `set` with merge rather than `update`, because the first claim of the
      // day is a create and an update would fail on a document that is not
      // there yet.
      tx.set(ref, { [meter]: next, updatedAt: now, day }, { merge: true })
      return allowed(meter, next, limit)
    })
  }

  /**
   * Give a unit back.
   *
   * Never drops below zero, and never creates a document: a refund for a day
   * with no claims is a bug somewhere else, and inventing a record of it would
   * hide that.
   */
  async refund(uid: string, meter: Meter, now: number): Promise<void> {
    const day = dayKey(now)
    const ref = this.db.doc(paths.usageDay(uid, day))

    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref)
      if (!snapshot.exists) return
      const usage = toUsage(day, snapshot.data(), now)
      if (usage[meter] <= 0) return
      tx.set(ref, { [meter]: usage[meter] - 1, updatedAt: now }, { merge: true })
    })
  }

  async recordSeconds(uid: string, seconds: number, now: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const day = dayKey(now)
    const ref = this.db.doc(paths.usageDay(uid, day))

    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref)
      const usage = toUsage(day, snapshot.data(), now)
      tx.set(
        ref,
        { videoSeconds: usage.videoSeconds + Math.round(seconds), updatedAt: now, day },
        { merge: true },
      )
    })
  }

  async read(uid: string, now: number): Promise<Usage> {
    const day = dayKey(now)
    const snapshot = await this.db.doc(paths.usageDay(uid, day)).get()
    return toUsage(day, snapshot.data(), now)
  }
}

/**
 * The same ledger, in memory.
 *
 * Used when Firestore is not configured — which is the normal state of a fresh
 * clone — and by the tests. It is not a stub: an unconfigured deployment still
 * gets a working cap for the life of the process, because the alternative is a
 * deployment where the provider quota is defended by nothing at all.
 */
export class InMemoryUsageStore implements UsageStore {
  private readonly days = new Map<string, Usage>()

  private key(uid: string, day: string): string {
    return `${uid}/${day}`
  }

  private current(uid: string, now: number): Usage {
    const day = dayKey(now)
    return this.days.get(this.key(uid, day)) ?? { ...emptyUsage(now), day }
  }

  // Single-threaded, so there is no interleaving to protect against; the
  // Firestore implementation is where the transaction matters.
  async claim(uid: string, meter: Meter, limits: Limits, now: number): Promise<Decision> {
    const usage = this.current(uid, now)
    const limit = limits.perDay[meter]
    if (usage[meter] + 1 > limit) return refusedForToday(meter, usage[meter], limit, now)

    if (meter === 'ingest' && usage.videoSeconds >= limits.videoSecondsPerDay) {
      return refusedForSeconds(usage.videoSeconds, limits.videoSecondsPerDay, now)
    }

    const next = { ...usage, [meter]: usage[meter] + 1, updatedAt: now }
    this.days.set(this.key(uid, usage.day), next)
    return allowed(meter, next[meter], limit)
  }

  async refund(uid: string, meter: Meter, now: number): Promise<void> {
    const usage = this.current(uid, now)
    if (usage[meter] <= 0) return
    this.days.set(this.key(uid, usage.day), { ...usage, [meter]: usage[meter] - 1, updatedAt: now })
  }

  async recordSeconds(uid: string, seconds: number, now: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const usage = this.current(uid, now)
    this.days.set(this.key(uid, usage.day), {
      ...usage,
      videoSeconds: usage.videoSeconds + Math.round(seconds),
      updatedAt: now,
    })
  }

  async read(uid: string, now: number): Promise<Usage> {
    return this.current(uid, now)
  }

  reset(): void {
    this.days.clear()
  }
}
