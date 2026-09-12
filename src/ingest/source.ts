/**
 * The transcript acquisition port.
 *
 * VidSense's single largest structural risk is that transcript supply depends on
 * one provider — a preview feature owned by a competitor. The mitigation is not
 * optimism; it is that no code above this file knows which provider was used.
 *
 * Everything that touches a transcript takes a `TimedTranscript`. Swapping the
 * supply chain is an edit to one adapter and one array in `chain.ts`.
 *
 * Explicitly not implemented, at any tier: page scraping, timedtext endpoints,
 * third-party transcript resellers, and yt-dlp against YouTube. All are RED under
 * the YouTube Developer Policies. A source that cannot be named in a compliance
 * audit does not belong behind this interface.
 */

import type { TimedTranscript } from '@/domain/transcript'
import type { VideoRef } from '@/ingest/url'

export type SourceId = 'gemini_url' | 'user_supplied' | 'creator_oauth'

/** Availability states a production ingester must expect, per the constraints research. */
export type Availability =
  | 'public'
  | 'unlisted'
  | 'private'
  | 'members_only'
  | 'age_restricted'
  | 'region_blocked'
  | 'removed'
  | 'live_now'
  | 'upcoming'

export interface VideoInput {
  readonly ref: VideoRef
  readonly durationSec?: number
  readonly availability?: Availability
  /** Raw transcript text a user pasted or uploaded. Only `user_supplied` reads this. */
  readonly suppliedTranscript?: string
  readonly language?: string
}

/**
 * Why a source could not produce a transcript.
 *
 * `terminal` reasons stop the chain: no other source can help with a removed
 * video or a livestream, so trying them wastes time and quota and produces a
 * misleading error. Non-terminal reasons advance to the next source.
 */
export type FailureReason =
  | 'not_configured'
  | 'unsupported_input'
  | 'no_transcript'
  | 'rate_limited'
  | 'upstream_error'
  | 'video_unavailable'
  | 'live_content'
  | 'too_long'

const TERMINAL: ReadonlySet<FailureReason> = new Set<FailureReason>([
  'video_unavailable',
  'live_content',
  'too_long',
])

export function isTerminal(reason: FailureReason): boolean {
  return TERMINAL.has(reason)
}

/**
 * Does calling this source send the video to a metered provider?
 *
 * The distinction is what the daily *seconds* budget is actually counting.
 * `gemini_url` hands Google a video to watch, and that is the eight-hours-a-day
 * ceiling being spent. `user_supplied` parses text the user already had — it is
 * still an ingest, and still counts as one, but it costs the provider nothing
 * and must not be billed hours it never used.
 *
 * `creator_oauth` is unimplemented, and when it arrives it spends YouTube quota
 * units rather than provider video-hours, so it belongs on this side of the
 * line until something measures otherwise.
 */
export function sendsVideoToProvider(id: SourceId): boolean {
  return id === 'gemini_url'
}

export interface SourceFailure {
  readonly source: SourceId
  readonly reason: FailureReason
  readonly detail?: string
}

export type FetchResult =
  | { readonly ok: true; readonly transcript: TimedTranscript }
  | { readonly ok: false; readonly reason: FailureReason; readonly detail?: string }

export interface TranscriptSource {
  readonly id: SourceId
  /** Cheap, synchronous pre-check. Returning false costs nothing; failing costs a call. */
  canHandle(input: VideoInput): boolean
  fetch(input: VideoInput): Promise<FetchResult>
}

/** Why the product is running without a transcript. Each maps to a designed screen. */
export type DegradedReason =
  | 'no_transcript_available'
  | 'video_unavailable'
  | 'live_content'
  | 'too_long'
  | 'all_sources_failed'

export type IngestOutcome =
  | {
      readonly kind: 'ok'
      readonly transcript: TimedTranscript
      readonly source: SourceId
      readonly attempts: readonly SourceFailure[]
    }
  | {
      readonly kind: 'degraded'
      readonly reason: DegradedReason
      /** Shown to the user verbatim. Honest degradation is part of the product. */
      readonly message: string
      readonly attempts: readonly SourceFailure[]
    }

/**
 * User-facing copy for each degraded outcome.
 *
 * These are deliberately specific and non-apologetic. "No transcript available"
 * with a working metadata and comments view is a correct product outcome, and it
 * should read as a deliberate state rather than a crash.
 */
export const DEGRADED_MESSAGE: Record<DegradedReason, string> = {
  no_transcript_available:
    'No transcript is available for this video. You can still browse its details and what viewers said — or paste your own transcript to unlock questions.',
  video_unavailable:
    'This video cannot be opened. It may be private, removed, members-only, age-restricted, or blocked in your region.',
  live_content:
    'This is a live or upcoming stream. VidSense can analyse it once the recording is published.',
  too_long:
    'This video is longer than VidSense can process in one pass. Try a specific section, or a shorter upload.',
  all_sources_failed:
    'Something went wrong while reading this video. Nothing was charged, and retrying usually works.',
}

/** Availability states that cannot yield a transcript from any source. */
export function terminalFor(availability: Availability | undefined): FailureReason | null {
  switch (availability) {
    case 'private':
    case 'removed':
    case 'members_only':
    case 'region_blocked':
    case 'age_restricted':
      return 'video_unavailable'
    case 'live_now':
    case 'upcoming':
      return 'live_content'
    default:
      return null
  }
}
