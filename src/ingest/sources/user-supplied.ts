/**
 * Transcript supplied by the user.
 *
 * The one source with no provider dependency, no quota, and no policy question:
 * the user already possesses the text. It is the floor beneath the whole chain —
 * if every provider route closes, this still works.
 */

import { buildTranscript } from '@/domain/transcript'
import { parseTranscriptText } from '@/ingest/parse-transcript'
import type { FetchResult, TranscriptSource, VideoInput } from '@/ingest/source'

/** Below this, the paste is more likely a stray copy than a transcript. */
const MIN_CUES = 2

export class UserSuppliedSource implements TranscriptSource {
  readonly id = 'user_supplied' as const

  canHandle(input: VideoInput): boolean {
    return typeof input.suppliedTranscript === 'string' && input.suppliedTranscript.trim().length > 0
  }

  async fetch(input: VideoInput): Promise<FetchResult> {
    const raw = input.suppliedTranscript
    if (!raw) return { ok: false, reason: 'unsupported_input', detail: 'no transcript supplied' }

    const { format, cues } = parseTranscriptText(raw)

    if (cues.length < MIN_CUES) {
      return {
        ok: false,
        reason: 'no_transcript',
        detail:
          format === 'unknown'
            ? 'unrecognised format — expected WebVTT, SRT, or lines beginning with a timestamp'
            : `parsed as ${format} but found ${cues.length} usable cue(s)`,
      }
    }

    const last = cues[cues.length - 1]!
    return {
      ok: true,
      transcript: buildTranscript({
        videoId: input.ref.videoId,
        provenance: 'user_supplied',
        language: input.language ?? 'unknown',
        durationMs: input.durationSec !== undefined ? input.durationSec * 1000 : last.endMs,
        cues,
      }),
    }
  }
}
