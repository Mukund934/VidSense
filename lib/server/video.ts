import 'server-only'

import { buildTranscript, type TimedTranscript } from '@/domain/transcript'
import { decodeBlob, decodeChunked } from '@/domain/blob'
import type { Cue } from '@/domain/transcript'
import { recall, remember, type CachedVideo } from '@/lib/server/cache'
import { videoStore } from '@/lib/server/deps'

/**
 * Load a video from wherever it happens to be.
 *
 * In-process first, then Firestore. Both are caches of the same thing, and a
 * miss on both means the video simply has to be ingested again — which is a
 * cost, not a failure.
 */
export async function loadVideo(videoId: string): Promise<CachedVideo | null> {
  const local = recall(videoId)
  if (local) return local

  const stored = await videoStore().get(videoId)
  if (!stored) return null

  let transcript: TimedTranscript | null = null
  try {
    const cues = stored.transcriptParts
      ? decodeChunked<Cue>(stored.transcriptParts)
      : stored.transcript
        ? decodeBlob<Cue>(stored.transcript)
        : null

    if (cues && cues.length > 0) {
      transcript = buildTranscript({
        videoId,
        provenance: stored.provenance,
        language: 'unknown',
        durationMs: stored.metadata.durationSec * 1000,
        cues,
        ...(stored.timing ? { timing: stored.timing } : {}),
      })
    }
  } catch {
    // A blob we cannot decode is a cache miss, not a crash.
    transcript = null
  }

  const video: CachedVideo = { metadata: stored.metadata, transcript }
  remember(videoId, video)
  return video
}
