/**
 * The fallback chain.
 *
 * Sources are tried in order until one produces a transcript. A terminal failure
 * — a removed video, a livestream, something too long — stops the chain
 * immediately, because no later source can succeed where the video itself is the
 * obstacle, and pretending otherwise burns quota to produce a worse error message.
 *
 * The chain never throws. Every path ends in an `IngestOutcome`, and a degraded
 * outcome carries copy the UI can show as-is.
 */

import {
  DEGRADED_MESSAGE,
  type DegradedReason,
  type FailureReason,
  type IngestOutcome,
  type SourceFailure,
  type TranscriptSource,
  type VideoInput,
  isTerminal,
  terminalFor,
} from '@/ingest/source'

/** Videos beyond this are refused before any provider call. */
export const MAX_DURATION_SEC = 8 * 60 * 60

function degradedReasonFor(reason: FailureReason): DegradedReason {
  switch (reason) {
    case 'video_unavailable':
      return 'video_unavailable'
    case 'live_content':
      return 'live_content'
    case 'too_long':
      return 'too_long'
    case 'no_transcript':
      return 'no_transcript_available'
    default:
      return 'all_sources_failed'
  }
}

function degrade(reason: DegradedReason, attempts: SourceFailure[]): IngestOutcome {
  return { kind: 'degraded', reason, message: DEGRADED_MESSAGE[reason], attempts }
}

export interface AcquireOptions {
  /** Called as each source is attempted, for progressive ingest UI. */
  readonly onAttempt?: (sourceId: string) => void
}

export async function acquireTranscript(
  sources: readonly TranscriptSource[],
  input: VideoInput,
  options: AcquireOptions = {},
): Promise<IngestOutcome> {
  const attempts: SourceFailure[] = []

  // Refuse what no source can serve, before spending anything.
  const upfront = terminalFor(input.availability)
  if (upfront) return degrade(degradedReasonFor(upfront), attempts)

  if (input.durationSec !== undefined && input.durationSec > MAX_DURATION_SEC) {
    return degrade('too_long', attempts)
  }

  for (const source of sources) {
    if (!source.canHandle(input)) {
      attempts.push({ source: source.id, reason: 'unsupported_input' })
      continue
    }

    options.onAttempt?.(source.id)

    let result
    try {
      result = await source.fetch(input)
    } catch (err) {
      // A source that throws is a bug in that source, not a reason to fail the
      // whole ingest. Record it and continue.
      attempts.push({
        source: source.id,
        reason: 'upstream_error',
        detail: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    if (result.ok) {
      if (result.transcript.cues.length === 0) {
        attempts.push({ source: source.id, reason: 'no_transcript', detail: 'zero cues returned' })
        continue
      }
      return { kind: 'ok', transcript: result.transcript, source: source.id, attempts }
    }

    attempts.push({
      source: source.id,
      reason: result.reason,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    })

    if (isTerminal(result.reason)) return degrade(degradedReasonFor(result.reason), attempts)
  }

  // Nothing succeeded. "Nobody had a transcript" and "everything broke" are
  // different stories and deserve different copy, so decide carefully.
  //
  // `unsupported_input` and `not_configured` mean a source was never in play —
  // a missing API key or an absent paste says nothing about whether a transcript
  // exists. Counting them as errors would tell a user to retry when the honest
  // answer is that this video has no transcript.
  const INAPPLICABLE: ReadonlySet<FailureReason> = new Set<FailureReason>([
    'unsupported_input',
    'not_configured',
  ])
  const realFailures = attempts.filter((a) => !INAPPLICABLE.has(a.reason))
  const allEmpty =
    realFailures.length > 0 && realFailures.every((a) => a.reason === 'no_transcript')

  return degrade(allEmpty ? 'no_transcript_available' : 'all_sources_failed', attempts)
}
