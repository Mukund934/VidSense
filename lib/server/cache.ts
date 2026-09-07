import 'server-only'
import type { TimedTranscript } from '@/domain/transcript'
import type { VideoMetadata } from '@/data/schema'

/**
 * A small in-process cache of what has been ingested.
 *
 * `ARCHITECTURE.md` §4 specifies exactly this alongside Firestore, and it earns
 * its place twice over: it saves a decode on the hot path, and it means the
 * product still answers questions on a machine where Firestore is not
 * configured at all. Losing it costs a re-ingest, never correctness.
 *
 * Deliberately not a shared cache. One process, one map, bounded — anything
 * cleverer is a second storage system pretending to be an optimisation.
 */
export interface CachedVideo {
  readonly metadata: VideoMetadata
  readonly transcript: TimedTranscript | null
}

const MAX_ENTRIES = 24
const store = new Map<string, CachedVideo>()

export function remember(videoId: string, video: CachedVideo): void {
  // Re-inserting moves the key to the end, so deletion below is least-recent.
  store.delete(videoId)
  store.set(videoId, video)
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

export function recall(videoId: string): CachedVideo | null {
  const hit = store.get(videoId)
  if (!hit) return null
  store.delete(videoId)
  store.set(videoId, hit)
  return hit
}

export function forget(videoId: string): void {
  store.delete(videoId)
}

export function cacheSize(): number {
  return store.size
}
