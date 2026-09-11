import 'server-only'

/**
 * The one place a route asks "may this cost something?".
 *
 * Both controls live behind a single call so that no route can accidentally
 * enforce one and not the other, and so the order is fixed: the burst limit
 * first, because it is free and answers in microseconds, then the daily budget,
 * which costs a Firestore transaction.
 *
 * The rule this exists to keep is from `docs/ARCHITECTURE.md` §10 — *rate
 * limiting per uid before any model call, and a hard per-user daily ingest cap
 * so one user cannot exhaust the Gemini free tier*. "Before" is the load-bearing
 * word: a check that runs after the provider has been called has already spent
 * the thing it was protecting.
 */

import { FirestoreUsageStore, InMemoryUsageStore, type UsageStore } from '@/data/usage'
import {
  type Decision,
  type Limits,
  type Meter,
  type Usage,
  limitsFrom,
  refusedForNow,
} from '@/quota/budget'
import { BurstLimiter } from '@/quota/burst'
import { firestore } from '@/lib/server/deps'

/**
 * Process-wide, and deliberately so.
 *
 * A limiter constructed per request would count to one for ever. See
 * `src/quota/burst.ts` for what holding this in memory does and does not buy.
 */
const burst = new BurstLimiter()

/**
 * The fallback ledger, kept at module scope for the same reason.
 *
 * A fresh clone has no Firestore credentials, and a per-request store would
 * mean no cap at all in exactly the configuration most likely to be pointed at
 * a live API key for the first time.
 */
const memory = new InMemoryUsageStore()

export function usageStore(): UsageStore {
  const db = firestore()
  return db ? new FirestoreUsageStore(db) : memory
}

export function limits(): Limits {
  return limitsFrom(process.env)
}

/**
 * Claim one unit of `meter` for this user.
 *
 * A storage failure **allows** the request. That is a deliberate choice and it
 * is the less obvious one: refusing would turn a Firestore outage into a total
 * outage of a product whose whole degraded-mode posture is that storage is
 * optional. The daily cap protects a free-tier quota, not a payment method, and
 * the burst limiter — which cannot fail, because it is a map — still stands
 * between a loop and the provider.
 */
export async function spend(uid: string, meter: Meter, now = Date.now()): Promise<Decision> {
  const configured = limits()

  const wait = burst.claim(`${meter}:${uid}`, configured.perMinute[meter], now)
  if (wait !== null) return refusedForNow(meter, configured.perMinute[meter], wait)

  // Resolved outside the catch, so a wiring mistake here fails loudly instead
  // of being read as a storage outage and waved through.
  const store = usageStore()
  try {
    return await store.claim(uid, meter, configured, now)
  } catch {
    return { allowed: true, meter, used: 0, limit: configured.perDay[meter], message: '' }
  }
}

/**
 * Hand a unit back, for work that turned out to cost the provider nothing.
 *
 * A cache hit is the case this exists for. Charging a user a video from their
 * daily five for re-opening one already in the shared cache would be charging
 * them for the cheapest thing the system does.
 */
export async function refund(uid: string, meter: Meter, now = Date.now()): Promise<void> {
  await usageStore()
    .refund(uid, meter, now)
    .catch(() => undefined)
}

/** Record video actually sent to the provider. Accounting only; never refuses. */
export async function recordVideoSeconds(uid: string, seconds: number, now = Date.now()): Promise<void> {
  await usageStore()
    .recordSeconds(uid, seconds, now)
    .catch(() => undefined)
}

export async function usageToday(uid: string, now = Date.now()): Promise<Usage> {
  return usageStore()
    .read(uid, now)
    .catch(() => ({ day: '', ingest: 0, ask: 0, videoSeconds: 0, updatedAt: now }))
}

/**
 * The refusal, as a response.
 *
 * 429 with `Retry-After`, because that is the status that means "you, later"
 * rather than "this, never" — and because a client that reads the header can
 * back off correctly without anyone writing bespoke retry logic. The body
 * carries the sentence from `budget.ts` so the wording is the same everywhere.
 */
export function tooManyRequests(decision: Decision): Response {
  return Response.json(
    {
      error: 'rate_limited',
      detail: decision.message,
      meter: decision.meter,
      used: decision.used,
      limit: decision.limit,
      retryAfterSec: decision.retryAfterSec,
    },
    {
      status: 429,
      ...(decision.retryAfterSec
        ? { headers: { 'retry-after': String(decision.retryAfterSec) } }
        : {}),
    },
  )
}

/**
 * Forget every counter held in this process.
 *
 * Both of them are module-scoped singletons, which is right in production and
 * means a test would otherwise inherit the previous one's spending.
 */
export function resetQuota(): void {
  burst.reset()
  memory.reset()
}
