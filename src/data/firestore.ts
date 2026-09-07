/**
 * Firestore adapters for the ingest ports.
 *
 * `videos/**` is written only from here. The security rules deny every client
 * write to that zone, and the Admin SDK bypasses rules — so the server is
 * structurally the only writer, which is what makes shared video knowledge safe
 * to read across users.
 *
 * Two things this layer owns, and the orchestrator deliberately does not:
 *
 *   1. **Distrust on read.** A document that does not match the shape this
 *      version expects is reported as a cache miss, not returned half-parsed.
 *      Re-ingesting costs one provider call; handing the orchestrator a
 *      malformed transcript fails somewhere far away from the cause.
 *   2. **Physical layout.** The port speaks in plain objects. Where those
 *      objects actually land — one document, or a document plus a subcollection
 *      — is a storage decision, and it belongs here.
 */

import type { DocumentData, Firestore } from 'firebase-admin/firestore'
import {
  SCHEMA_VERSION,
  paths,
  type AnalysisStatus,
  type HistoryDoc,
  type VideoMetadata,
} from '@/data/schema'
import type { EncodedBlob } from '@/domain/blob'
import type { TranscriptProvenance } from '@/domain/transcript'
import type { Timing, TimingSource } from '@/domain/timing'
import type { HistoryStore, StoredVideo, VideoStore } from '@/ingest/ports'

/** Subcollection holding an oversized transcript, one ordered slice per document. */
const PARTS = 'transcriptParts'

const PROVENANCE: ReadonlySet<string> = new Set<TranscriptProvenance>([
  'gemini_url',
  'user_supplied',
  'creator_oauth',
])

const STATUS: ReadonlySet<string> = new Set<AnalysisStatus>([
  'queued',
  'processing',
  'ready',
  'failed',
  'degraded',
])

const TIMING_SOURCES: ReadonlySet<string> = new Set<TimingSource>([
  'caption_track',
  'clip_window',
  'model_rescaled',
  'model_raw',
  'user_supplied',
])

// ------------------------------------------------------------------ decoding

/**
 * A timing record we cannot vouch for is dropped rather than guessed at.
 * The transcript then falls back to the least trustworthy label, which is the
 * safe direction to be wrong in.
 */
function asTiming(value: unknown): Timing | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Record<string, unknown>
  if (typeof t.source !== 'string' || !TIMING_SOURCES.has(t.source)) return null
  const tol = t.toleranceMs
  if (tol !== null && typeof tol !== 'number') return null
  return { source: t.source as TimingSource, toleranceMs: tol as number | null }
}

function asBlob(value: unknown): EncodedBlob | null {
  if (!value || typeof value !== 'object') return null
  const b = value as Record<string, unknown>
  if (b.codec !== 'gzip+b64') return null
  if (typeof b.blob !== 'string') return null
  if (typeof b.count !== 'number' || typeof b.bytes !== 'number') return null
  return { codec: 'gzip+b64', count: b.count, bytes: b.bytes, blob: b.blob }
}

function asMetadata(value: unknown): VideoMetadata | null {
  if (!value || typeof value !== 'object') return null
  const m = value as Record<string, unknown>
  if (typeof m.title !== 'string') return null
  if (typeof m.channelId !== 'string') return null
  if (typeof m.channelTitle !== 'string') return null
  if (typeof m.publishedAt !== 'string') return null
  if (typeof m.durationSec !== 'number') return null
  return {
    title: m.title,
    channelId: m.channelId,
    channelTitle: m.channelTitle,
    publishedAt: m.publishedAt,
    durationSec: m.durationSec,
    ...(typeof m.thumbnailUrl === 'string' ? { thumbnailUrl: m.thumbnailUrl } : {}),
  }
}

/**
 * Rebuild a `StoredVideo` from a raw document, or return null if anything is
 * off. A stale `schemaVersion` counts as off: a shape written by a different
 * version of this code is not one we can vouch for, and re-ingest is the honest
 * response.
 */
export function parseStoredVideo(data: DocumentData | undefined): StoredVideo | null {
  if (!data) return null
  if (data.schemaVersion !== SCHEMA_VERSION) return null

  const metadata = asMetadata(data.metadata)
  if (!metadata) return null

  if (typeof data.provenance !== 'string' || !PROVENANCE.has(data.provenance)) return null
  if (typeof data.status !== 'string' || !STATUS.has(data.status)) return null

  const { ingestedAt, refreshedAt, expiresAt } = data
  if (typeof ingestedAt !== 'number') return null
  if (typeof refreshedAt !== 'number') return null
  if (typeof expiresAt !== 'number') return null

  const transcript = asBlob(data.transcript)
  const timing = asTiming(data.timing)

  return {
    metadata,
    provenance: data.provenance as TranscriptProvenance,
    status: data.status as AnalysisStatus,
    ingestedAt,
    refreshedAt,
    expiresAt,
    schemaVersion: SCHEMA_VERSION,
    ...(transcript ? { transcript } : {}),
    ...(timing ? { timing } : {}),
    ...(typeof data.failureReason === 'string' ? { failureReason: data.failureReason } : {}),
  }
}

// ------------------------------------------------------------------ encoding

/**
 * Build the document to write.
 *
 * Written out field by field rather than spread from the input: it keeps the
 * storage contract explicit, and it means an `undefined` can never reach
 * Firestore, which rejects them.
 */
function toDocument(doc: StoredVideo, partCount: number): DocumentData {
  const { metadata } = doc
  return {
    metadata: {
      title: metadata.title,
      channelId: metadata.channelId,
      channelTitle: metadata.channelTitle,
      publishedAt: metadata.publishedAt,
      durationSec: metadata.durationSec,
      ...(metadata.thumbnailUrl ? { thumbnailUrl: metadata.thumbnailUrl } : {}),
    },
    provenance: doc.provenance,
    ...(doc.timing ? { timing: { source: doc.timing.source, toleranceMs: doc.timing.toleranceMs } } : {}),
    status: doc.status,
    ingestedAt: doc.ingestedAt,
    refreshedAt: doc.refreshedAt,
    expiresAt: doc.expiresAt,
    schemaVersion: doc.schemaVersion,
    transcriptPartCount: partCount,
    ...(doc.transcript ? { transcript: doc.transcript } : {}),
    ...(doc.failureReason ? { failureReason: doc.failureReason } : {}),
  }
}

// -------------------------------------------------------------------- stores

export class FirestoreVideoStore implements VideoStore {
  constructor(private readonly db: Firestore) {}

  async get(videoId: string): Promise<StoredVideo | null> {
    const ref = this.db.doc(paths.video(videoId))
    const snap = await ref.get()
    if (!snap.exists) return null

    const base = parseStoredVideo(snap.data())
    if (!base) return null

    // Oversized transcripts live in a subcollection; only pay for that read when
    // the document says there is something there.
    const partCount = snap.get('transcriptPartCount')
    if (typeof partCount !== 'number' || partCount === 0) return base

    const snapshot = await ref.collection(PARTS).orderBy('index').get()

    // A partial set reassembles into a transcript with a hole in it, which is
    // worse than no transcript at all. Treat any gap as a miss.
    const blobs: EncodedBlob[] = []
    for (const part of snapshot.docs) {
      const blob = asBlob(part.get('part'))
      if (!blob) return null
      blobs.push(blob)
    }
    if (blobs.length !== partCount) return null

    return { ...base, transcriptParts: blobs }
  }

  async put(videoId: string, doc: StoredVideo): Promise<void> {
    const ref = this.db.doc(paths.video(videoId))
    const parts = doc.transcriptParts ?? []

    const batch = this.db.batch()
    batch.set(ref, toDocument(doc, parts.length))

    parts.forEach((part, index) => {
      batch.set(ref.collection(PARTS).doc(String(index)), { index, part })
    })

    // A re-ingest of a shorter transcript must not leave the old tail behind.
    // Parts 0..n-1 are overwritten by the writes above; only the surplus needs
    // deleting, which also keeps one document from being both set and deleted
    // in the same batch.
    const existing = await ref.collection(PARTS).get()
    for (const stale of existing.docs) {
      const index = stale.get('index')
      if (typeof index !== 'number' || index >= parts.length) batch.delete(stale.ref)
    }

    await batch.commit()
  }
}

export class FirestoreHistoryStore implements HistoryStore {
  constructor(private readonly db: Firestore) {}

  /**
   * Record that this user opened this video.
   *
   * A transaction rather than a merge, because two fields cannot be expressed as
   * one: `firstAnalyzedAt` must survive every later open, and `openCount` has to
   * count. Both are read-then-write on a single document.
   */
  async touch(uid: string, entry: HistoryDoc): Promise<void> {
    const ref = this.db.doc(paths.historyEntry(uid, entry.videoId))

    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const previous = snap.data()

      const firstAnalyzedAt =
        typeof previous?.firstAnalyzedAt === 'number'
          ? previous.firstAnalyzedAt
          : (entry.firstAnalyzedAt ?? entry.lastOpenedAt)

      const openCount = typeof previous?.openCount === 'number' ? previous.openCount + 1 : 1

      tx.set(
        ref,
        {
          videoId: entry.videoId,
          lastOpenedAt: entry.lastOpenedAt,
          firstAnalyzedAt,
          openCount,
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.channelTitle ? { channelTitle: entry.channelTitle } : {}),
          ...(entry.thumbnailUrl ? { thumbnailUrl: entry.thumbnailUrl } : {}),
          ...(entry.durationSec === undefined ? {} : { durationSec: entry.durationSec }),
          ...(entry.status ? { status: entry.status } : {}),
        },
        { merge: true },
      )
    })
  }
}
