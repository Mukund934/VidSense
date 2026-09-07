/**
 * Ingest orchestration.
 *
 * Turns a pasted URL into a stored, queryable video. Four things matter here and
 * each is a real cost or correctness constraint, not architecture for its own sake:
 *
 *   1. CACHE FIRST. A stored, unexpired video costs ~2 reads instead of a full
 *      provider call. This is the single largest lever on unit economics.
 *   2. SINGLE-FLIGHT. Two users pasting the same URL at the same moment must not
 *      both pay for it. Concurrent callers join the in-progress ingest.
 *   3. PROVENANCE. A `creator_oauth` transcript is authorised for one channel
 *      owner and must never enter the shared cache. Enforced here, structurally.
 *   4. STAGED PROGRESS. The UI reveals metadata in about a second and fills in
 *      behind it, so waiting reads as progress rather than a spinner.
 *
 * Nothing in this module throws for an expected condition. Every path ends in an
 * `IngestResult`, degraded ones included.
 */

import { encodeBlob, encodeChunked, BlobTooLargeError, MAX_BLOB_BYTES } from '@/domain/blob'
import type { Cue, TimedTranscript } from '@/domain/transcript'
import { buildTranscript } from '@/domain/transcript'
import { SCHEMA_VERSION, nextExpiry, type HistoryDoc, type VideoMetadata } from '@/data/schema'
import { acquireTranscript } from '@/ingest/chain'
import type { DegradedReason, SourceFailure, TranscriptSource, VideoInput } from '@/ingest/source'
import { DEGRADED_MESSAGE } from '@/ingest/source'
import type { Clock, HistoryStore, MetadataSource, StoredVideo, VideoStore } from '@/ingest/ports'
import { decodeBlob, decodeChunked } from '@/domain/blob'
import type { VideoRef } from '@/ingest/url'

export type IngestStage =
  | 'cached'
  | 'metadata'
  | 'transcript'
  | 'storing'
  | 'ready'
  | 'degraded'

export interface IngestProgress {
  readonly stage: IngestStage
  readonly detail?: string
}

export interface IngestResult {
  readonly videoId: string
  readonly status: 'ready' | 'degraded'
  readonly fromCache: boolean
  readonly metadata?: VideoMetadata
  readonly transcript?: TimedTranscript
  readonly degraded?: { readonly reason: DegradedReason; readonly message: string }
  readonly attempts: readonly SourceFailure[]
}

export interface IngestDeps {
  readonly videos: VideoStore
  readonly history: HistoryStore
  readonly metadata: MetadataSource
  readonly sources: readonly TranscriptSource[]
  readonly now: Clock
  readonly onProgress?: (p: IngestProgress) => void
}

export interface IngestRequest {
  readonly uid: string
  readonly ref: VideoRef
  /** Raw transcript the user pasted, if any. */
  readonly suppliedTranscript?: string
  /** Skip the cache and re-ingest. Used by the refresh sweep. */
  readonly force?: boolean
}

/**
 * A transcript obtained under a creator's own authorisation is licensed to that
 * creator, not to everyone who later pastes the same link. Keeping it out of the
 * shared collection is the mechanism, not a policy note in a document.
 */
function isShareable(provenance: TimedTranscript['provenance']): boolean {
  return provenance !== 'creator_oauth'
}

function historyEntry(
  videoId: string,
  metadata: VideoMetadata | undefined,
  status: 'ready' | 'degraded',
  now: number,
): HistoryDoc {
  return {
    videoId,
    lastOpenedAt: now,
    firstAnalyzedAt: now,
    status: status === 'ready' ? 'ready' : 'degraded',
    ...(metadata
      ? {
          title: metadata.title,
          channelTitle: metadata.channelTitle,
          durationSec: metadata.durationSec,
          ...(metadata.thumbnailUrl ? { thumbnailUrl: metadata.thumbnailUrl } : {}),
        }
      : {}),
  }
}

/** Rehydrate a stored video into a live transcript. */
function transcriptFromStored(videoId: string, stored: StoredVideo): TimedTranscript | undefined {
  const cues = stored.transcriptParts
    ? decodeChunked<Cue>(stored.transcriptParts)
    : stored.transcript
      ? decodeBlob<Cue>(stored.transcript)
      : null
  if (!cues || cues.length === 0) return undefined

  return buildTranscript({
    videoId,
    provenance: stored.provenance,
    language: 'unknown',
    durationMs: stored.metadata.durationSec * 1000,
    cues,
    // Restored rather than recomputed: without this a cache hit would relabel a
    // corrected transcript as raw model output and lose the precision claim.
    ...(stored.timing ? { timing: stored.timing } : {}),
  })
}

/**
 * Record the open, and never fail the ingest over it.
 *
 * History is a convenience: it makes a video easy to find again. The transcript
 * is the thing the user waited for and the provider was paid for. Losing the
 * first must never cost the second, so a storage outage degrades to forgetting
 * rather than to an error.
 */
async function touchHistory(deps: IngestDeps, uid: string, entry: HistoryDoc): Promise<void> {
  await deps.history.touch(uid, entry).catch(() => undefined)
}

/** In-process single-flight. One server instance; see the note in `ingestVideo`. */
const inFlight = new Map<string, Promise<IngestResult>>()

export function inFlightCount(): number {
  return inFlight.size
}

export async function ingestVideo(req: IngestRequest, deps: IngestDeps): Promise<IngestResult> {
  const { videoId } = req.ref

  // A supplied transcript is specific to this caller, so it must not join or
  // populate a shared in-flight ingest.
  const shareableRequest = !req.suppliedTranscript && !req.force
  const existing = shareableRequest ? inFlight.get(videoId) : undefined
  if (existing) {
    const result = await existing
    // The joiner still gets their own history entry.
    await touchHistory(deps, req.uid, historyEntry(videoId, result.metadata, result.status, deps.now()))
    return result
  }

  const run = performIngest(req, deps)
  if (shareableRequest) {
    inFlight.set(videoId, run)
    void run.catch(() => undefined).finally(() => inFlight.delete(videoId))
  }
  return run
}

async function performIngest(req: IngestRequest, deps: IngestDeps): Promise<IngestResult> {
  const { videoId } = req.ref
  const now = deps.now()
  const emit = deps.onProgress ?? (() => undefined)

  // ---- 1. cache ----------------------------------------------------------
  if (!req.force && !req.suppliedTranscript) {
    const cached = await deps.videos.get(videoId).catch(() => null)
    if (cached && cached.expiresAt > now && cached.status === 'ready' && isShareable(cached.provenance)) {
      const transcript = transcriptFromStored(videoId, cached)
      if (transcript) {
        emit({ stage: 'cached' })
        await touchHistory(deps, req.uid, historyEntry(videoId, cached.metadata, 'ready', now))
        emit({ stage: 'ready' })
        return {
          videoId,
          status: 'ready',
          fromCache: true,
          metadata: cached.metadata,
          transcript,
          attempts: [],
        }
      }
    }
  }

  // ---- 2. metadata -------------------------------------------------------
  emit({ stage: 'metadata' })
  const meta = await deps.metadata.fetch(videoId).catch(
    (err: unknown) =>
      ({ ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) }) as const,
  )

  if (!meta.ok) {
    const reason: DegradedReason =
      meta.reason === 'live' || meta.reason === 'upcoming'
        ? 'live_content'
        : meta.reason === 'error'
          ? 'all_sources_failed'
          : 'video_unavailable'
    return degradedResult(req, deps, reason, [], now, undefined)
  }

  // ---- 3. transcript -----------------------------------------------------
  emit({ stage: 'transcript' })
  const input: VideoInput = {
    ref: req.ref,
    durationSec: meta.metadata.durationSec,
    availability: meta.availability,
    ...(req.suppliedTranscript === undefined ? {} : { suppliedTranscript: req.suppliedTranscript }),
  }

  const outcome = await acquireTranscript(deps.sources, input, {
    onAttempt: (sourceId) => emit({ stage: 'transcript', detail: sourceId }),
  })

  if (outcome.kind === 'degraded') {
    return degradedResult(req, deps, outcome.reason, outcome.attempts, now, meta.metadata)
  }

  // ---- 4. store ----------------------------------------------------------
  emit({ stage: 'storing' })
  const stored = await storeVideo(videoId, meta.metadata, outcome.transcript, now, deps)

  await touchHistory(deps, req.uid, historyEntry(videoId, meta.metadata, 'ready', now))
  emit({ stage: 'ready' })

  return {
    videoId,
    status: 'ready',
    fromCache: false,
    metadata: meta.metadata,
    transcript: outcome.transcript,
    attempts: stored.attempts,
  }
}

async function storeVideo(
  videoId: string,
  metadata: VideoMetadata,
  transcript: TimedTranscript,
  now: number,
  deps: IngestDeps,
): Promise<{ attempts: SourceFailure[] }> {
  // A creator-authorised transcript is usable in this session but is never
  // written to the shared collection other users read from.
  if (!isShareable(transcript.provenance)) return { attempts: [] }

  const doc: StoredVideo = {
    metadata,
    provenance: transcript.provenance,
    timing: transcript.timing,
    ingestedAt: now,
    refreshedAt: now,
    // Retention is enforced in application code: Firestore TTL policies require billing.
    expiresAt: nextExpiry(now),
    schemaVersion: SCHEMA_VERSION,
    status: 'ready',
  }

  const cues = [...transcript.cues]
  try {
    doc.transcript = encodeBlob(cues, MAX_BLOB_BYTES)
  } catch (err) {
    if (!(err instanceof BlobTooLargeError)) throw err
    doc.transcriptParts = encodeChunked(cues, MAX_BLOB_BYTES).parts
  }

  // A storage failure must not lose the transcript the caller already has.
  await deps.videos.put(videoId, doc).catch(() => undefined)
  return { attempts: [] }
}

async function degradedResult(
  req: IngestRequest,
  deps: IngestDeps,
  reason: DegradedReason,
  attempts: readonly SourceFailure[],
  now: number,
  metadata: VideoMetadata | undefined,
): Promise<IngestResult> {
  deps.onProgress?.({ stage: 'degraded', detail: reason })
  await touchHistory(deps, req.uid, historyEntry(req.ref.videoId, metadata, 'degraded', now))

  return {
    videoId: req.ref.videoId,
    status: 'degraded',
    fromCache: false,
    ...(metadata ? { metadata } : {}),
    degraded: { reason, message: DEGRADED_MESSAGE[reason] },
    attempts,
  }
}
