import 'server-only'

/**
 * The one place a route asks "may this cost something?".
 *
 * Three controls live behind a single call, so that no route can enforce one
 * and forget another, and so the order is fixed:
 *
 *   1. **The burst limit**, in process, free, answers in microseconds.
 *   2. **The per-user daily budget**, which bounds one honest person.
 *   3. **The deployment ceiling**, which bounds everyone at once — including
 *      the same person behind ten cookies, which is all a signed-out identity
 *      is. Without it the first two describe good manners rather than a limit.
 *
 * The rule this exists to keep is from `docs/ARCHITECTURE.md` §10 — *rate
 * limiting per uid before any model call, and a hard per-user daily ingest cap
 * so one user cannot exhaust the Gemini free tier*. "Before" is the load-bearing
 * word: a check that runs after the provider has been called has already spent
 * the thing it was protecting.
 *
 * Every allowed claim must be **settled**. `settle` is what turns a reservation
 * into real consumption, or gives it back when the work turned out to cost the
 * provider nothing. A claim that is never settled holds part of the day's
 * budget until its reservation expires.
 */

import {
  FirestoreDeploymentStore,
  InMemoryDeploymentStore,
  type DeploymentStore,
  type DeploymentUsage,
} from '@/data/deployment'
import { FirestoreUsageStore, InMemoryUsageStore, type UsageStore } from '@/data/usage'
import { MAX_DURATION_SEC } from '@/ingest/chain'
import {
  type Decision,
  type DeploymentLimits,
  type Limits,
  type Meter,
  type Usage,
  deploymentLimitsFrom,
  limitsFrom,
  refusedForNow,
  refusedWhileBusy,
} from '@/quota/budget'
import { BurstLimiter } from '@/quota/burst'
import { firestore } from '@/lib/server/deps'
import { log } from '@/lib/server/log'
import { withTimeout } from '@/lib/server/timeout'

/**
 * Process-wide, and deliberately so.
 *
 * A limiter constructed per request would count to one for ever. See
 * `src/quota/burst.ts` for what holding this in memory does and does not buy.
 */
const burst = new BurstLimiter()

/**
 * The fallback ledgers, kept at module scope for the same reason.
 *
 * A fresh clone has no Firestore credentials, and a per-request store would
 * mean no cap at all in exactly the configuration most likely to be pointed at
 * a live API key for the first time.
 */
const memoryUsage = new InMemoryUsageStore()
const memoryDeployment = new InMemoryDeploymentStore()

export function usageStore(): UsageStore {
  const db = firestore()
  return db ? new FirestoreUsageStore(db) : memoryUsage
}

export function deploymentStore(): DeploymentStore {
  const db = firestore()
  return db ? new FirestoreDeploymentStore(db) : memoryDeployment
}

export function limits(): Limits {
  return limitsFrom(process.env)
}

export function deploymentLimits(): DeploymentLimits {
  return deploymentLimitsFrom(process.env)
}

/**
 * An allowed or refused claim, and what is needed to settle it.
 *
 * The reservation is opaque to the caller; it only has to survive until
 * `settle` is called with it.
 */
export interface Spend {
  readonly decision: Decision
  readonly meter: Meter
  readonly uid: string
  readonly reservation?: string
}

/**
 * Claim one unit of `meter` for this user, and one against the deployment.
 *
 * A storage failure **allows** the request. That is deliberate and it is the
 * less obvious choice: refusing would turn a Firestore outage into a total
 * outage of a product whose whole degraded-mode posture is that storage is
 * optional. The caps protect a free-tier quota, not a payment method, and the
 * burst limiter — which cannot fail, because it is a map — still stands between
 * a retry loop and the provider.
 */
export async function spend(uid: string, meter: Meter, now = Date.now()): Promise<Spend> {
  const configured = limits()

  const wait = burst.claim(`${meter}:${uid}`, configured.perMinute[meter], now)
  if (wait !== null) {
    return { decision: refusedForNow(meter, configured.perMinute[meter], wait), meter, uid }
  }

  // Resolved outside the catch, so a wiring mistake here fails loudly instead
  // of being read as a storage outage and waved through.
  const users = usageStore()
  const deployment = deploymentStore()

  let userDecision: Decision
  try {
    // Every store call here is on a clock. An unreachable Firestore does not
    // fail — it retries for about ninety seconds — so without a bound the
    // "allow on storage failure" rule below only takes effect long after the
    // request was any use. See `lib/server/timeout.ts`.
    userDecision = await withTimeout('usage.claim', users.claim(uid, meter, configured, now))
  } catch {
    userDecision = { allowed: true, meter, used: 0, limit: configured.perDay[meter], message: '' }
  }
  if (!userDecision.allowed) return { decision: userDecision, meter, uid }

  try {
    const claim = await withTimeout(
      'deployment.claim',
      deployment.claim(meter, deploymentLimits(), MAX_DURATION_SEC, now),
    )
    if (!claim.decision.allowed) {
      // The user's own budget must not be spent on a request the deployment
      // then refused: they did nothing, so it should cost them nothing.
      await withTimeout('usage.refund', users.refund(uid, meter, now)).catch(() => undefined)
      return { decision: claim.decision, meter, uid }
    }
    return {
      decision: userDecision,
      meter,
      uid,
      ...(claim.reservation ? { reservation: claim.reservation } : {}),
    }
  } catch (err) {
    await withTimeout('usage.refund', users.refund(uid, meter, now)).catch(() => undefined)

    // The two ledgers fail in opposite directions, on purpose.
    //
    // A per-user counter that cannot be read costs one person their cap, so it
    // allows — losing a cap is better than losing the product. The deployment
    // ceiling is the last line, so *contention* refuses: an aborted transaction
    // means the database could not establish there was room, and that happens
    // exactly when many requests are arriving, which is when assuming there is
    // room is most expensive.
    //
    // Anything that is not contention is treated as an outage and allowed, so a
    // Firestore failure still degrades rather than closing the product.
    if (isContention(err)) return { decision: refusedWhileBusy(meter), meter, uid }
    return { decision: userDecision, meter, uid }
  }
}

/**
 * Did this fail because the document was busy, rather than unreachable?
 *
 * gRPC `ABORTED` is 10, and the Firestore emulator and the live service word
 * the accompanying message differently, so both the code and the text are
 * checked. Anything unrecognised is deliberately *not* treated as contention:
 * the fallback has to be the one that keeps the product working.
 */
function isContention(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  if ((err as { code?: unknown }).code === 10) return true
  const message = String((err as { message?: unknown }).message ?? '')
  return /ABORTED|lock timeout|too much contention|contention/i.test(message)
}

/** What actually happened, once the work is done. */
export type Outcome =
  /** The provider was used. `seconds` is the video actually sent, if any. */
  | { readonly charged: true; readonly seconds?: number }
  /** It cost the provider nothing — a cache hit, a refusal, or a failure. */
  | { readonly charged: false }

/**
 * Close out a claim.
 *
 * Both ledgers are settled together, because a refund applied to one and not
 * the other leaves the two disagreeing about the same event — and the one that
 * drifts high is the deployment ceiling, which then shuts early for everybody.
 *
 * Failures are swallowed. Settlement runs after the user already has their
 * answer, and turning a bookkeeping error into a failed response would spend
 * the provider call and then throw it away.
 */
export async function settle(spent: Spend, outcome: Outcome, now = Date.now()): Promise<void> {
  if (!spent.decision.allowed) return

  const { uid, meter, reservation } = spent
  const users = usageStore()
  const deployment = deploymentStore()

  if (outcome.charged) {
    const seconds = outcome.seconds ?? 0
    await Promise.all([
      seconds > 0
        ? withTimeout('usage.recordSeconds', users.recordSeconds(uid, seconds, now)).catch(
            () => undefined,
          )
        : undefined,
      withTimeout(
        'deployment.settle',
        deployment.settle(meter, reservation, seconds, now),
      ).catch(() => undefined),
    ])
    return
  }

  await Promise.all([
    withTimeout('usage.refund', users.refund(uid, meter, now)).catch(() => undefined),
    withTimeout('deployment.release', deployment.release(meter, reservation, now)).catch(
      () => undefined,
    ),
  ])
}

export async function usageToday(uid: string, now = Date.now()): Promise<Usage> {
  return usageStore()
    .read(uid, now)
    .catch(() => ({ day: '', ingest: 0, ask: 0, videoSeconds: 0, updatedAt: now }))
}

export async function deploymentToday(now = Date.now()): Promise<DeploymentUsage> {
  return deploymentStore()
    .read(now)
    .catch(() => ({
      day: '',
      ingest: 0,
      ask: 0,
      videoSeconds: 0,
      reservedSeconds: 0,
      updatedAt: now,
    }))
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
  // The one refusal a user sees that is not about their video. Logged because
  // it is also the signal that a cap is set wrong: a deployment where the
  // deployment-wide meter refuses all day needs its ceiling raised or its
  // provider plan changed, and nothing else would ever say so.
  log.warn('quota.refused', {
    meter: decision.meter,
    used: decision.used,
    limit: decision.limit,
    retryAfterSec: decision.retryAfterSec,
  })

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
 * All three are module-scoped singletons, which is right in production and
 * means a test would otherwise inherit the previous one's spending.
 */
export function resetQuota(): void {
  burst.reset()
  memoryUsage.reset()
  memoryDeployment.reset()
}

/**
 * What this user has left today.
 *
 * The Firestore rules already say why this exists: `users/{uid}/usage/{day}` is
 * readable by its owner *"so the product can show them what they have left"*.
 * Nothing showed it, so the first signal a user got was a 429 — a refusal is a
 * fine thing to hit and a poor thing to be surprised by.
 *
 * Read-only and never claims anything. A storage failure reports null rather
 * than throwing: a panel that cannot be drawn must not take the settings page
 * with it, and "we do not know" is an honest thing for it to say.
 *
 * The deployment ceiling is deliberately absent. `firestore.rules` denies it to
 * every client for reading as well as writing, because the remaining headroom
 * is exactly the fact that makes exhausting it easy to time.
 */
export interface Headroom {
  readonly meter: Meter | 'video'
  readonly label: string
  readonly used: number
  readonly limit: number
}

export async function headroom(uid: string, now = Date.now()): Promise<Headroom[] | null> {
  const configured = limits()
  try {
    const usage = await withTimeout('usage.read', usageStore().read(uid, now))
    return [
      { meter: 'ingest', label: 'Videos analysed', used: usage.ingest, limit: configured.perDay.ingest },
      { meter: 'ask', label: 'Questions asked', used: usage.ask, limit: configured.perDay.ask },
      {
        meter: 'video',
        label: 'Video sent for reading',
        // Minutes, because seconds of video is the provider's unit and not a
        // person's. Rounded up so a partial minute is not reported as free.
        used: Math.ceil(usage.videoSeconds / 60),
        limit: Math.floor(configured.videoSecondsPerDay / 60),
      },
    ]
  } catch {
    return null
  }
}
