/**
 * How much a timestamp can be trusted, and where that trust comes from.
 *
 * VidSense sells receipts. A receipt that says 2:15 when the moment is at 3:20
 * is worse than no receipt at all, because it looks like evidence. Measured on
 * 2026-09-07, Gemini's own transcript timestamps are wrong by a median of 82
 * seconds on a six-minute talk, and rescaling them against the true duration
 * still leaves a 7.5s median and a 16.6s p95. Neither is a receipt.
 *
 * The response is not to hide the error behind a fudge factor. It is to make
 * the *precision of a timestamp part of the timestamp*, so nothing downstream
 * can present an estimate as if it were a measurement.
 *
 * Every cue therefore carries a `TimingSource`, and every source carries a
 * tolerance. The UI reads the tolerance, not the number, when it decides what
 * to promise the user.
 */

/**
 * Where a cue's time came from, ordered from most to least trustworthy.
 *
 * - `caption_track` — the creator's own published cue times. Exact by
 *   definition; nothing here is inferred. Not reachable in v1 (it needs
 *   `captions.download` and owner authorisation) but the enum ships complete so
 *   the seam is real when it arrives.
 * - `clip_window` — we chose a span, sent only that span, and the text came
 *   back. The time is bounded by the span we picked, so the error cannot exceed
 *   the window regardless of what the model believes.
 * - `model_rescaled` — the model's own timestamps, linearly corrected against
 *   the true duration. An estimate with a measured error distribution.
 * - `model_raw` — the model's timestamps, uncorrected. Retained only so that
 *   stored data written before this existed can be labelled honestly.
 * - `user_supplied` — times from a transcript the user pasted. As good as
 *   whatever they pasted, which we cannot check.
 */
export type TimingSource =
  | 'caption_track'
  | 'clip_window'
  | 'model_rescaled'
  | 'model_raw'
  | 'user_supplied'

/**
 * Worst-case error in milliseconds, by source.
 *
 * `clip_window` is filled in per ingest from the window actually used, because
 * its bound *is* the window. The others are measured or, for `user_supplied`,
 * unknowable — and unknowable is represented as unknowable, not as zero.
 */
export const TOLERANCE_MS: Record<TimingSource, number | null> = {
  caption_track: 0,
  clip_window: null,
  model_rescaled: 17_000,
  model_raw: 160_000,
  user_supplied: null,
}

export interface Timing {
  readonly source: TimingSource
  /**
   * Half-width of the interval this timestamp is believed to lie in, in
   * milliseconds. `null` means "not established" — which is a different claim
   * from zero and must never be rendered as precision.
   */
  readonly toleranceMs: number | null
}

/** Timing for a clip-derived cue: the bound is the window we chose. */
export function clipWindowTiming(windowMs: number): Timing {
  // A cue is placed proportionally inside its window, so the worst case is
  // being at one end while placed at the other — half the window each way.
  return { source: 'clip_window', toleranceMs: Math.max(0, Math.round(windowMs / 2)) }
}

export function timingFor(source: TimingSource): Timing {
  return { source, toleranceMs: TOLERANCE_MS[source] }
}

/**
 * Is this timing precise enough to send a viewer to a specific second?
 *
 * The bar is deliberately tight. Landing more than a couple of seconds out puts
 * the viewer in a different sentence, and a receipt that lands in a different
 * sentence is a false citation with a timestamp attached.
 */
export const SEEK_TOLERANCE_MS = 2_500

export function canSeekPrecisely(timing: Timing): boolean {
  return timing.toleranceMs !== null && timing.toleranceMs <= SEEK_TOLERANCE_MS
}

/**
 * What a receipt may honestly claim.
 *
 * `exact`    — jump the player to the second and say so.
 * `approximate` — jump, but tell the viewer the window it might be in.
 * `unlocated` — quote the words; do not offer a jump at all. Better to give a
 *               verifiable quote with no link than a link that lands wrong.
 */
export type ReceiptPrecision = 'exact' | 'approximate' | 'unlocated'

/** Beyond this, a jump link does more harm than the quote alone. */
export const UNLOCATED_ABOVE_MS = 30_000

export function precisionOf(timing: Timing): ReceiptPrecision {
  if (timing.toleranceMs === null) return 'unlocated'
  if (timing.toleranceMs <= SEEK_TOLERANCE_MS) return 'exact'
  return timing.toleranceMs <= UNLOCATED_ABOVE_MS ? 'approximate' : 'unlocated'
}

/**
 * User-facing wording for a timestamp's precision.
 *
 * Written out here rather than at each call site so the product cannot drift
 * into overclaiming in one screen while being careful in another.
 */
export function precisionLabel(timing: Timing): string {
  switch (precisionOf(timing)) {
    case 'exact':
      return 'exact moment'
    case 'approximate': {
      const seconds = Math.round((timing.toleranceMs ?? 0) / 1000)
      return `within about ${seconds}s`
    }
    case 'unlocated':
      return 'timing not established'
  }
}
