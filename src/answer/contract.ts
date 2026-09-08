/**
 * The answer contract — what the model is allowed to say, and what we do with it.
 *
 * The whole design rests on one restriction: **the model may not write a
 * timestamp, a URL, or a quote.** It writes a claim and a pair of cue indices.
 * Everything a user finally sees as evidence — the quote, the time, the jump
 * link — is resolved on our side from the transcript we already hold.
 *
 * That makes two classes of fabrication structurally impossible rather than
 * merely unlikely. A model cannot cite a passage that does not exist, because
 * an out-of-range index has nothing to resolve to. And it cannot misquote a
 * passage that does, because it never supplies the words.
 *
 * What it *can* still do is cite a real passage that does not support the
 * claim. That is an entailment failure and no amount of index discipline
 * catches it; `src/answer/verify.ts` is the gate for that, and per D32 it runs
 * offline rather than in the request path until O20 has measured what it costs
 * in wrongly-rejected good citations.
 */

import { type Receipt, type TimedTranscript, resolveReceipt } from '@/domain/transcript'

/** Where a statement came from. Lanes are never blended in a single claim. */
export type Lane = 'VIDEO' | 'VIEWERS' | 'EXTERNAL' | 'INFERENCE'

const LANES: ReadonlySet<string> = new Set<Lane>(['VIDEO', 'VIEWERS', 'EXTERNAL', 'INFERENCE'])

/** A claim as the model emits it: prose plus a cue range, never a time. */
export interface RawClaim {
  readonly text: string
  readonly cueStart: number
  readonly cueEnd: number
  readonly lane: Lane
}

/** A claim after resolution, with evidence we produced ourselves. */
export interface AnswerClaim {
  readonly text: string
  readonly lane: Lane
  /**
   * Null for lanes that are not grounded in the video, and for a VIDEO claim
   * whose citation the verifier found does not support it.
   */
  readonly receipt: Receipt | null
  /**
   * Present only when the entailment gate has run. Absent means unchecked,
   * which is a different thing from checked-and-fine — see src/answer/verify.ts.
   */
  readonly verification?: { readonly entailment: string; readonly detail?: string }
}

export type AnswerStatus =
  /** The video addresses the question and the claims below are supported. */
  | 'answered'
  /** The video does not address the question. Not a failure — a finding. */
  | 'not_in_video'
  /** The model produced something we could not read as an answer. */
  | 'unreadable'

export interface Answer {
  readonly status: AnswerStatus
  readonly claims: readonly AnswerClaim[]
  /** Shown to the user verbatim when there is something to explain. */
  readonly message?: string
  /**
   * Claims the model made that we refused to render, and why. Kept rather than
   * silently dropped: a model that repeatedly cites out of range is a signal,
   * and one that disappears is a signal nobody sees.
   */
  readonly rejected: readonly RejectedClaim[]
}

export interface RejectedClaim {
  readonly text: string
  readonly reason: 'cue_out_of_range' | 'malformed' | 'unknown_lane'
  readonly detail?: string
}

/** The sentinel the model is told to emit when the video does not address the question. */
export const NOT_IN_VIDEO = 'NOT_IN_VIDEO'

function asInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) ? n : null
}

/**
 * Read the model's JSON into claims, discarding anything malformed.
 *
 * Deliberately permissive about *shape* and strict about *substance*: a missing
 * optional field is tolerated, a claim without a usable cue range is not.
 */
export function parseClaims(raw: unknown): { claims: RawClaim[]; rejected: RejectedClaim[] } {
  const claims: RawClaim[] = []
  const rejected: RejectedClaim[] = []

  if (!Array.isArray(raw)) return { claims, rejected }

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      rejected.push({ text: '', reason: 'malformed', detail: 'not an object' })
      continue
    }
    const c = item as Record<string, unknown>
    const text = typeof c.text === 'string' ? c.text.trim() : ''
    if (!text) {
      rejected.push({ text: '', reason: 'malformed', detail: 'empty text' })
      continue
    }

    const lane = typeof c.lane === 'string' ? c.lane.toUpperCase() : 'VIDEO'
    if (!LANES.has(lane)) {
      rejected.push({ text, reason: 'unknown_lane', detail: String(c.lane) })
      continue
    }

    // Non-VIDEO lanes are not grounded in the transcript and carry no cues.
    if (lane !== 'VIDEO') {
      claims.push({ text, cueStart: -1, cueEnd: -1, lane: lane as Lane })
      continue
    }

    const start = asInt(c.cueStart)
    const end = asInt(c.cueEnd ?? c.cueStart)
    if (start === null || end === null) {
      rejected.push({ text, reason: 'malformed', detail: 'cue indices are not integers' })
      continue
    }

    claims.push({ text, cueStart: start, cueEnd: end, lane: 'VIDEO' })
  }

  return { claims, rejected }
}

/**
 * Resolve claims into an answer, dropping any that cite outside the transcript.
 *
 * `resolveReceipt` throws on an out-of-range index by design. Catching it here
 * is what turns a hallucinated citation into a discarded claim instead of a
 * failed request — the rest of the answer is still worth showing.
 */
export function buildAnswer(
  transcript: TimedTranscript,
  raw: unknown,
  options: { readonly abstained?: boolean; readonly message?: string } = {},
): Answer {
  if (options.abstained) {
    return {
      status: 'not_in_video',
      claims: [],
      rejected: [],
      message:
        options.message ??
        'This video does not address that question. Nothing here is being inferred for you.',
    }
  }

  const { claims: parsed, rejected } = parseClaims(raw)
  if (parsed.length === 0 && rejected.length === 0) {
    return {
      status: 'unreadable',
      claims: [],
      rejected,
      message: 'The answer could not be read. Nothing is shown rather than something unverified.',
    }
  }

  const claims: AnswerClaim[] = []
  const dropped: RejectedClaim[] = [...rejected]

  for (const claim of parsed) {
    if (claim.lane !== 'VIDEO') {
      claims.push({ text: claim.text, lane: claim.lane, receipt: null })
      continue
    }
    try {
      const receipt = resolveReceipt(transcript, claim.cueStart, claim.cueEnd)
      claims.push({ text: claim.text, lane: 'VIDEO', receipt })
    } catch (err) {
      dropped.push({
        text: claim.text,
        reason: 'cue_out_of_range',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (claims.length === 0) {
    return {
      status: 'unreadable',
      claims: [],
      rejected: dropped,
      message:
        'Every claim cited evidence that does not exist in this transcript, so none of it is shown.',
    }
  }

  return { status: 'answered', claims, rejected: dropped }
}
