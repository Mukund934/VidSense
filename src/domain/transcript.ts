/**
 * The transcript model.
 *
 * The central invariant of VidSense: **the model never emits a timestamp.**
 * It emits a cue index, and we resolve that index to a time range ourselves.
 * A hallucinated timestamp is therefore not something we have to detect — it is
 * something the system cannot represent.
 */

import { sanitiseUntrusted } from '@/domain/untrusted'
import {
  type ReceiptPrecision,
  type Timing,
  precisionOf,
  timingFor,
} from '@/domain/timing'

/** One timed unit of speech. Cues are contiguous and ordered by `startMs`. */
export interface Cue {
  /** Position in the transcript. Equals the array index; carried explicitly so a
   *  cue remains self-describing once detached from its array. */
  readonly i: number
  readonly startMs: number
  readonly endMs: number
  readonly text: string
  /** Optional speaker label. Absent until diarization exists. */
  readonly speaker?: string
}

export type TranscriptProvenance = 'gemini_url' | 'user_supplied' | 'creator_oauth'

export interface TimedTranscript {
  readonly videoId: string
  readonly cues: readonly Cue[]
  readonly provenance: TranscriptProvenance
  readonly language: string
  /** Milliseconds of the source media the transcript is believed to cover. */
  readonly durationMs: number
  /**
   * How far these cue times can be trusted, and why. Required, because a
   * transcript whose precision is unstated is one the UI will quietly assume is
   * exact — and measured against ground truth, it usually is not.
   */
  readonly timing: Timing
}

/** A resolved evidence span. Produced only by {@link resolveReceipt}. */
export interface Receipt {
  readonly cueStart: number
  readonly cueEnd: number
  readonly startMs: number
  readonly endMs: number
  readonly quote: string
  /** Carried from the transcript, so a receipt can never outrun its evidence. */
  readonly timing: Timing
  /** What this receipt may honestly claim: exact, approximate, or unlocated. */
  readonly precision: ReceiptPrecision
}

export class CueRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CueRangeError'
  }
}

/**
 * Resolve a model-supplied cue range into a timestamped receipt.
 *
 * This is the only sanctioned way to produce a timestamp for display. Throwing on
 * an out-of-range index is deliberate: a model that invents a cue index must fail
 * loudly at the boundary rather than silently yield a plausible wrong moment.
 */
export function resolveReceipt(
  transcript: TimedTranscript,
  cueStart: number,
  cueEnd: number,
): Receipt {
  const { cues } = transcript
  if (!Number.isInteger(cueStart) || !Number.isInteger(cueEnd)) {
    throw new CueRangeError(`cue indices must be integers, got ${cueStart}..${cueEnd}`)
  }
  if (cueStart < 0 || cueEnd >= cues.length) {
    throw new CueRangeError(
      `cue range ${cueStart}..${cueEnd} is outside 0..${cues.length - 1}`,
    )
  }
  if (cueStart > cueEnd) {
    throw new CueRangeError(`cue range ${cueStart}..${cueEnd} is inverted`)
  }

  const first = cues[cueStart]
  const last = cues[cueEnd]
  // Guarded by the bounds check above; this satisfies noUncheckedIndexedAccess.
  if (!first || !last) throw new CueRangeError(`cue range ${cueStart}..${cueEnd} is not populated`)

  const quote = cues
    .slice(cueStart, cueEnd + 1)
    .map((c) => c.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    cueStart,
    cueEnd,
    startMs: first.startMs,
    endMs: last.endMs,
    quote,
    timing: transcript.timing,
    precision: precisionOf(transcript.timing),
  }
}

/** Build a transcript from raw cue data, normalising indices and ordering. */
export function buildTranscript(input: {
  videoId: string
  provenance: TranscriptProvenance
  language: string
  durationMs: number
  cues: ReadonlyArray<{ startMs: number; endMs: number; text: string; speaker?: string }>
  /** Omitted only by callers that genuinely have no better claim than the model's raw output. */
  timing?: Timing
}): TimedTranscript {
  const ordered = [...input.cues].sort((a, b) => a.startMs - b.startMs)
  const cues: Cue[] = ordered.map((c, i) => {
    const cue: Cue = {
      i,
      startMs: Math.max(0, Math.round(c.startMs)),
      endMs: Math.max(0, Math.round(c.endMs)),
      // Sanitised here because every transcript in the system is built through
      // this function — provider, user paste and rehydration from storage alike.
      // A single choke point is the only kind that cannot be forgotten at a
      // call site. Invisibles go first, so whitespace collapsing sees the real
      // text rather than a zero-width character wedged between two words.
      text: sanitiseUntrusted(c.text).replace(/\s+/g, ' ').trim(),
      ...(c.speaker === undefined ? {} : { speaker: c.speaker }),
    }
    return cue
  })
  return {
    videoId: input.videoId,
    cues,
    provenance: input.provenance,
    language: input.language,
    durationMs: input.durationMs,
    // Defaulting to the least trustworthy source is deliberate: a caller that
    // has not thought about timing should not be granted precision it never
    // established.
    timing: input.timing ?? timingFor('model_raw'),
  }
}

/** `14:32` or `1:04:07`. Used for display and for YouTube deep links. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** A watch URL that opens the video at the given moment. */
export function youtubeMomentUrl(videoId: string, ms: number): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(ms / 1000)}s`
}

/**
 * A jump link for a receipt, or null when the timing does not support one.
 *
 * The null is the point. An `unlocated` receipt still carries a verbatim quote,
 * which is real evidence; attaching a link that lands in the wrong sentence
 * would turn that evidence into a false claim with a timestamp on it.
 */
export function receiptSeekUrl(videoId: string, receipt: Receipt): string | null {
  if (receipt.precision === 'unlocated') return null
  return youtubeMomentUrl(videoId, receipt.startMs)
}
