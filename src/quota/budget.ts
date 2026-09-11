/**
 * What one user is allowed to spend in a day.
 *
 * This is not an anti-abuse feature bolted on for tidiness. The free tiers this
 * product runs on are **shared across every user at once**: Gemini's YouTube-URL
 * path is capped at roughly eight hours of video per day for the whole project,
 * not per person (`docs/ARCHITECTURE.md` §6). One person pasting links in a loop
 * does not degrade their own experience — it ends everybody else's day.
 *
 * So the cap exists to make one user's enthusiasm survivable for the rest, and
 * it has to be enforced **before** the provider is called rather than noticed
 * afterwards in a bill. There is no bill here; there is a wall.
 *
 * Two independent controls, because they stop different things:
 *
 *   - **A daily budget**, counted per user per UTC day and held in Firestore, so
 *     it survives a restart and cannot be reset by reconnecting.
 *   - **A burst limit**, counted in-process over a sliding minute, which stops a
 *     script hammering the route faster than the daily counter can be written.
 *     See `./burst.ts` for why that one is deliberately not persisted.
 *
 * Nothing here talks to a database or a clock. It is the arithmetic and the
 * wording, so both are testable and neither can drift between call sites.
 */

/** The things worth counting, because each one spends somebody else's quota. */
export type Meter = 'ingest' | 'ask'

export const METERS: readonly Meter[] = ['ingest', 'ask']

export interface Limits {
  /** Per user, per UTC day. */
  readonly perDay: Readonly<Record<Meter, number>>
  /** Per user, per rolling minute. */
  readonly perMinute: Readonly<Record<Meter, number>>
  /**
   * Seconds of video one user may send to the provider in a day.
   *
   * A count of videos cannot bound this on its own. `MAX_DURATION_SEC` allows a
   * single video of two and a half hours, so five of them is twelve and a half
   * hours against a provider ceiling of eight — the count cap is either
   * generous or provably safe, and it cannot be both.
   */
  readonly videoSecondsPerDay: number
}

/**
 * The defaults, and where each number comes from.
 *
 * `ingest` is five because the binding constraint is Gemini's ~8 h/day of
 * YouTube video **for the entire deployment**, which ARCHITECTURE §6 puts at
 * four to eight videos a day in total. Five per user is therefore generous
 * while there is one user and too generous the moment there are ten — which is
 * exactly why it is an environment variable and not a constant in a route.
 *
 * `ask` is fifty because an answer re-sends the whole transcript, so it is the
 * expensive call repeated most often. Fifty is more than a thorough session and
 * far less than a loop.
 *
 * The per-minute numbers are not a cost control. They are there so that a
 * runaway client hits a wall in the first second rather than at the end of a
 * budget, and so that the daily counter is never the only thing standing
 * between a retry loop and the provider.
 */
export const DEFAULT_LIMITS: Limits = {
  perDay: { ingest: 5, ask: 50 },
  perMinute: { ingest: 3, ask: 12 },
  // Five hours. The check runs before the video's own length is known, so the
  // worst case is this budget plus one more video — and `MAX_DURATION_SEC`
  // caps that at two and a half hours. Five plus two and a half is seven and a
  // half, which is under the provider's eight, so the bound holds even in the
  // worst case rather than only on average.
  videoSecondsPerDay: 5 * 60 * 60,
}

/** How a meter reads in a sentence written for the person who hit it. */
const NOUN: Readonly<Record<Meter, { one: string; many: string }>> = {
  ingest: { one: 'video', many: 'videos' },
  ask: { one: 'question', many: 'questions' },
}

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The UTC day a moment belongs to, as `YYYY-MM-DD`.
 *
 * UTC rather than the user's local day, because the quota being protected is
 * Google's and it resets on Pacific time for one product and UTC for another.
 * A server-side day that never moves is the only one that can be reasoned about
 * from a log; a local day would also hand anyone a second budget by changing
 * their timezone.
 */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** Milliseconds until the daily counters roll over. */
export function msUntilNextDay(now: number): number {
  const startOfDay = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  )
  return startOfDay + DAY_MS - now
}

/** One user's consumption for one day. */
export interface Usage {
  readonly day: string
  readonly ingest: number
  readonly ask: number
  /**
   * Seconds of video sent to the provider today.
   *
   * This is the provider's own unit, so it is the one the cap has to be
   * expressed in. It is checked against the running total rather than against
   * the video being asked for, because a video's length is not known until the
   * metadata call has already been made — see `videoSecondsPerDay` for why that
   * still bounds the worst case.
   */
  readonly videoSeconds: number
  readonly updatedAt: number
}

export function emptyUsage(now: number): Usage {
  return { day: dayKey(now), ingest: 0, ask: 0, videoSeconds: 0, updatedAt: now }
}

/** What a caller is told when it asks to spend something. */
export interface Decision {
  readonly allowed: boolean
  readonly meter: Meter
  /** Including the unit just claimed, when one was. */
  readonly used: number
  readonly limit: number
  /** How long until this could succeed. Absent when nothing is exhausted. */
  readonly retryAfterSec?: number
  /** Shown to the user. Says what ran out and when it comes back. */
  readonly message: string
}

export function allowed(meter: Meter, used: number, limit: number): Decision {
  return { allowed: true, meter, used, limit, message: '' }
}

/**
 * A refusal, worded for the person who hit it.
 *
 * It names the limit and when it lifts. A cap that says only "rate limited"
 * reads as a fault, and someone who thinks the product is broken behaves very
 * differently from someone who knows they have used their five videos.
 */
export function refusedForToday(meter: Meter, used: number, limit: number, now: number): Decision {
  const noun = limit === 1 ? NOUN[meter].one : NOUN[meter].many
  const hours = Math.max(1, Math.round(msUntilNextDay(now) / (60 * 60 * 1000)))
  return {
    allowed: false,
    meter,
    used,
    limit,
    retryAfterSec: Math.ceil(msUntilNextDay(now) / 1000),
    message:
      `That is today's ${limit} ${noun}. This is a free-tier limit shared by everyone ` +
      `using VidSense, not a fault — it resets in about ${hours} ${hours === 1 ? 'hour' : 'hours'}.`,
  }
}

/**
 * A refusal because the day's *video* is gone rather than the day's count.
 *
 * Worded separately because "you have watched five hours today" and "you have
 * opened five videos today" are different facts, and someone who has hit the
 * first while having opened two videos would read the second as a bug.
 */
export function refusedForSeconds(used: number, limit: number, now: number): Decision {
  const hours = Math.max(1, Math.round(msUntilNextDay(now) / (60 * 60 * 1000)))
  const budgetHours = Math.round(limit / 3600)
  return {
    allowed: false,
    meter: 'ingest',
    used,
    limit,
    retryAfterSec: Math.ceil(msUntilNextDay(now) / 1000),
    message:
      `That is about ${budgetHours} ${budgetHours === 1 ? 'hour' : 'hours'} of video today, ` +
      `which is this deployment's share of a free tier everyone using VidSense draws on. ` +
      `It resets in about ${hours} ${hours === 1 ? 'hour' : 'hours'}.`,
  }
}

/** A burst refusal: the same budget, just not this second. */
export function refusedForNow(meter: Meter, limit: number, retryAfterSec: number): Decision {
  const noun = limit === 1 ? NOUN[meter].one : NOUN[meter].many
  return {
    allowed: false,
    meter,
    used: limit,
    limit,
    retryAfterSec,
    message:
      `That is ${limit} ${noun} in under a minute. Give it ${retryAfterSec} ` +
      `${retryAfterSec === 1 ? 'second' : 'seconds'} and try again.`,
  }
}

/** Would claiming one more unit of `meter` exceed the day's budget? */
export function wouldExceed(usage: Usage, meter: Meter, limits: Limits): boolean {
  return usage[meter] + 1 > limits.perDay[meter]
}

/**
 * Limits from the environment, falling back to the defaults.
 *
 * Read through a function rather than frozen at module load so a test can set
 * one without reaching into module state, and so a deployment can tighten the
 * cap without a code change when the number of beta users moves.
 */
export function limitsFrom(env: Record<string, string | undefined>): Limits {
  const read = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const value = Number(raw)
    // A malformed limit falls back rather than throwing: a typo in an
    // environment variable must not take the product down, and it must
    // certainly not be read as "no limit".
    return Number.isInteger(value) && value >= 0 ? value : fallback
  }

  return {
    perDay: {
      ingest: read('INGESTS_PER_DAY', DEFAULT_LIMITS.perDay.ingest),
      ask: read('ASKS_PER_DAY', DEFAULT_LIMITS.perDay.ask),
    },
    perMinute: {
      ingest: read('INGESTS_PER_MINUTE', DEFAULT_LIMITS.perMinute.ingest),
      ask: read('ASKS_PER_MINUTE', DEFAULT_LIMITS.perMinute.ask),
    },
    videoSecondsPerDay: read('VIDEO_SECONDS_PER_DAY', DEFAULT_LIMITS.videoSecondsPerDay),
  }
}
