/**
 * One counter for the whole deployment, and the reservation that makes it
 * honest.
 *
 * `src/data/usage.ts` counts per user. That bounds one person and nothing else,
 * because a signed-out identity is a cookie: clearing it is a keystroke, so ten
 * visitors — or one visitor with ten cookie jars — can still empty the day
 * between them. The provider quota belongs to the Google project, so the last
 * line has to be counted once, for everyone, in a document no user owns.
 *
 * **Why seconds are reserved rather than counted.**
 *
 * The binding limit is hours of video, and a video's length is not known until
 * the metadata call has already happened. A per-user cap can live with that:
 * the overshoot is one video and the blast radius is one person. A deployment
 * ceiling cannot, because *N* requests arriving together would each read the
 * same "plenty left" and each then send up to `MAX_DURATION_SEC` — an overshoot
 * of N × 2.5 h against a ceiling of 7 h. A ceiling that can be exceeded by an
 * unbounded factor is not a ceiling.
 *
 * So an ingest **reserves the worst case up front** and settles to the real
 * duration afterwards. Admission is strict: a claim is refused unless
 * `committed + reserved + worstCase` still fits. Reserved therefore never
 * exceeds the ceiling, and since actual consumption is never more than what was
 * reserved, **actual consumption cannot exceed the ceiling either** — under any
 * amount of concurrency, which is the whole point.
 *
 * The price is paid in concurrency rather than in correctness: at a 7 h ceiling
 * and a 2.5 h worst case, only two ingests can be in flight at once even if
 * both turn out to be three minutes long. At the four-to-eight videos a day
 * this tier is sized for, that is not a constraint anyone will meet; if it ever
 * becomes one, settling the reservation as soon as metadata arrives — rather
 * than when the ingest finishes — collapses the window to milliseconds.
 *
 * Reservations expire (`RESERVATION_TTL_MS`), because a request that dies
 * between reserving and settling would otherwise hold part of the day's budget
 * for ever, and a ceiling one crash can wedge is worse than the problem it was
 * built to solve.
 */

import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore'

import { paths } from '@/data/schema'
import {
  type Decision,
  type DeploymentLimits,
  type Meter,
  RESERVATION_TTL_MS,
  allowed,
  dayKey,
  refusedByDeployment,
} from '@/quota/budget'

/** Seconds held by one in-flight ingest. */
export interface Reservation {
  readonly seconds: number
  readonly expiresAt: number
}

export interface DeploymentUsage {
  readonly day: string
  readonly ingest: number
  readonly ask: number
  /** Seconds settled to a real duration. The accounting number. */
  readonly videoSeconds: number
  /** Seconds held by requests still in flight. Expired holds are not counted. */
  readonly reservedSeconds: number
  readonly updatedAt: number
}

export interface DeploymentClaim {
  readonly decision: Decision
  /**
   * Set only when an ingest was allowed. Hand it back to `settle` or `release`;
   * losing it costs the deployment those seconds until the reservation expires.
   */
  readonly reservation?: string
}

export interface DeploymentStore {
  claim(
    meter: Meter,
    limits: DeploymentLimits,
    worstCaseSeconds: number,
    now: number,
  ): Promise<DeploymentClaim>
  /** The work happened: keep the count, convert the hold into real seconds. */
  settle(meter: Meter, reservation: string | undefined, seconds: number, now: number): Promise<void>
  /** The work cost nothing: give back the count and drop the hold. */
  release(meter: Meter, reservation: string | undefined, now: number): Promise<void>
  read(now: number): Promise<DeploymentUsage>
}

type ReservationMap = Record<string, Reservation>

export function emptyDeploymentUsage(now: number): DeploymentUsage {
  return {
    day: dayKey(now),
    ingest: 0,
    ask: 0,
    videoSeconds: 0,
    reservedSeconds: 0,
    updatedAt: now,
  }
}

/**
 * Drop dead holds and add up what is genuinely still in flight.
 *
 * Compaction happens on every write rather than in a sweep, because a sweep is
 * a scheduled job and *a cron that never fired throws no error* — the failure
 * mode would be a slowly wedging ceiling with nothing to alert on.
 */
export function liveReservations(
  raw: unknown,
  now: number,
): { live: ReservationMap; seconds: number } {
  const live: ReservationMap = {}
  let seconds = 0

  if (raw && typeof raw === 'object') {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const { seconds: held, expiresAt } = value as Partial<Reservation>
      if (typeof held !== 'number' || typeof expiresAt !== 'number') continue
      if (!Number.isFinite(held) || held <= 0 || expiresAt <= now) continue
      live[id] = { seconds: held, expiresAt }
      seconds += held
    }
  }

  return { live, seconds }
}

/** Read a stored document back, tolerating anything odd in it. */
export function toDeploymentUsage(
  day: string,
  data: Record<string, unknown> | undefined,
  now: number,
): DeploymentUsage {
  const count = (key: string): number => {
    const value = data?.[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }
  if (!data) return { ...emptyDeploymentUsage(now), day }
  return {
    day,
    ingest: count('ingest'),
    ask: count('ask'),
    videoSeconds: count('videoSeconds'),
    reservedSeconds: liveReservations(data.reservations, now).seconds,
    updatedAt: count('updatedAt') || now,
  }
}

/**
 * Would this claim fit?
 *
 * Pure, so the admission rule can be read and tested in one place rather than
 * inferred from two store implementations that might disagree.
 */
export function admits(
  usage: Pick<DeploymentUsage, 'ingest' | 'ask' | 'videoSeconds'>,
  reservedSeconds: number,
  meter: Meter,
  limits: DeploymentLimits,
  worstCaseSeconds: number,
): boolean {
  if (meter === 'ask') return usage.ask + 1 <= limits.asksPerDay
  if (usage.ingest + 1 > limits.ingestsPerDay) return false
  // Strict, and this is the line that makes the ceiling a ceiling: what is
  // already spent, plus what is promised to requests in flight, plus the worst
  // this one could turn out to be.
  return usage.videoSeconds + reservedSeconds + worstCaseSeconds <= limits.videoSecondsPerDay
}

function newReservationId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * Write the whole document, and **never with `{ merge: true }`**.
 *
 * A merged write does a *deep* merge of map fields, so handing it a compacted
 * `reservations` map adds and updates keys but never removes one. Releasing a
 * hold would silently do nothing, every reservation would live until it expired
 * whether or not it was settled, and the ceiling would drift shut over a day —
 * a bug that only appears under the load nobody tests by hand.
 *
 * Every caller here is already inside a transaction that has read the current
 * state, so a full replace is both safe and the only thing that actually
 * deletes a key.
 */
function write(
  tx: Transaction,
  ref: DocumentReference,
  usage: DeploymentUsage,
  reservations: ReservationMap,
  now: number,
): void {
  tx.set(ref, {
    day: usage.day,
    ingest: usage.ingest,
    ask: usage.ask,
    videoSeconds: usage.videoSeconds,
    reservations,
    updatedAt: now,
  })
}

export class FirestoreDeploymentStore implements DeploymentStore {
  constructor(private readonly db: Firestore) {}

  async claim(
    meter: Meter,
    limits: DeploymentLimits,
    worstCaseSeconds: number,
    now: number,
  ): Promise<DeploymentClaim> {
    const day = dayKey(now)
    const ref = this.db.doc(paths.deploymentDay(day))

    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref)
      const data = snapshot.data()
      const usage = toDeploymentUsage(day, data, now)
      const { live, seconds: reserved } = liveReservations(data?.reservations, now)

      if (!admits(usage, reserved, meter, limits, worstCaseSeconds)) {
        // Expired holds are still compacted away on a refusal, so a ceiling
        // that filled up with dead reservations recovers on the next attempt
        // rather than staying shut until something succeeds.
        write(tx, ref, usage, live, now)
        return { decision: refusedByDeployment(meter, now) }
      }

      if (meter === 'ask') {
        write(tx, ref, { ...usage, ask: usage.ask + 1 }, live, now)
        return { decision: allowed(meter, usage.ask + 1, limits.asksPerDay) }
      }

      const id = newReservationId()
      write(
        tx,
        ref,
        { ...usage, ingest: usage.ingest + 1 },
        { ...live, [id]: { seconds: worstCaseSeconds, expiresAt: now + RESERVATION_TTL_MS } },
        now,
      )
      return { decision: allowed(meter, usage.ingest + 1, limits.ingestsPerDay), reservation: id }
    })
  }

  async settle(
    meter: Meter,
    reservation: string | undefined,
    seconds: number,
    now: number,
  ): Promise<void> {
    if (meter !== 'ingest') return
    const day = dayKey(now)
    const ref = this.db.doc(paths.deploymentDay(day))

    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref)
      if (!snapshot.exists) return
      const data = snapshot.data()
      const usage = toDeploymentUsage(day, data, now)
      const { live } = liveReservations(data?.reservations, now)

      if (reservation) delete live[reservation]
      const spent = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0

      write(tx, ref, { ...usage, videoSeconds: usage.videoSeconds + spent }, live, now)
    })
  }

  async release(meter: Meter, reservation: string | undefined, now: number): Promise<void> {
    const day = dayKey(now)
    const ref = this.db.doc(paths.deploymentDay(day))

    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref)
      if (!snapshot.exists) return
      const data = snapshot.data()
      const usage = toDeploymentUsage(day, data, now)
      const { live } = liveReservations(data?.reservations, now)

      if (reservation) delete live[reservation]

      write(tx, ref, { ...usage, [meter]: Math.max(0, usage[meter] - 1) }, live, now)
    })
  }

  async read(now: number): Promise<DeploymentUsage> {
    const day = dayKey(now)
    const snapshot = await this.db.doc(paths.deploymentDay(day)).get()
    return toDeploymentUsage(day, snapshot.data(), now)
  }
}

/**
 * The same ceiling, in memory.
 *
 * Used when Firestore is not configured, which is the state of a fresh clone —
 * and that is exactly the configuration most likely to be pointed at a live API
 * key for the first time. A deployment with no ceiling at all is the one case
 * this feature exists to prevent, so the fallback is a working implementation
 * rather than a no-op.
 */
export class InMemoryDeploymentStore implements DeploymentStore {
  private days = new Map<string, { usage: DeploymentUsage; reservations: ReservationMap }>()

  private current(now: number): { usage: DeploymentUsage; reservations: ReservationMap } {
    const day = dayKey(now)
    return this.days.get(day) ?? { usage: { ...emptyDeploymentUsage(now), day }, reservations: {} }
  }

  async claim(
    meter: Meter,
    limits: DeploymentLimits,
    worstCaseSeconds: number,
    now: number,
  ): Promise<DeploymentClaim> {
    const state = this.current(now)
    const { live, seconds: reserved } = liveReservations(state.reservations, now)

    if (!admits(state.usage, reserved, meter, limits, worstCaseSeconds)) {
      this.days.set(state.usage.day, { usage: state.usage, reservations: live })
      return { decision: refusedByDeployment(meter, now) }
    }

    if (meter === 'ask') {
      const usage = { ...state.usage, ask: state.usage.ask + 1, updatedAt: now }
      this.days.set(usage.day, { usage, reservations: live })
      return { decision: allowed(meter, usage.ask, limits.asksPerDay) }
    }

    const id = newReservationId()
    const usage = { ...state.usage, ingest: state.usage.ingest + 1, updatedAt: now }
    this.days.set(usage.day, {
      usage,
      reservations: { ...live, [id]: { seconds: worstCaseSeconds, expiresAt: now + RESERVATION_TTL_MS } },
    })
    return { decision: allowed(meter, usage.ingest, limits.ingestsPerDay), reservation: id }
  }

  async settle(
    meter: Meter,
    reservation: string | undefined,
    seconds: number,
    now: number,
  ): Promise<void> {
    if (meter !== 'ingest') return
    const state = this.current(now)
    const { live } = liveReservations(state.reservations, now)
    if (reservation) delete live[reservation]

    const spent = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0
    this.days.set(state.usage.day, {
      usage: { ...state.usage, videoSeconds: state.usage.videoSeconds + spent, updatedAt: now },
      reservations: live,
    })
  }

  async release(meter: Meter, reservation: string | undefined, now: number): Promise<void> {
    const state = this.current(now)
    const { live } = liveReservations(state.reservations, now)
    if (reservation) delete live[reservation]

    this.days.set(state.usage.day, {
      usage: { ...state.usage, [meter]: Math.max(0, state.usage[meter] - 1), updatedAt: now },
      reservations: live,
    })
  }

  async read(now: number): Promise<DeploymentUsage> {
    const state = this.current(now)
    return { ...state.usage, reservedSeconds: liveReservations(state.reservations, now).seconds }
  }

  reset(): void {
    this.days = new Map()
  }
}
