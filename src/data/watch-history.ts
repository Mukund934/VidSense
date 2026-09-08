/**
 * Imported watch history, stored the way transcripts are: one compressed
 * document, not one document per item.
 *
 * The arithmetic is the same and so is the conclusion. Firestore's free tier
 * allows 20,000 writes a day across every user; a single year of one person's
 * viewing is tens of thousands of entries, so a document per watched video
 * would spend the whole day's budget on one import. Compressed into a single
 * blob, an import costs one write.
 *
 * Only two fields per entry ever reach here — a video id and a timestamp. The
 * titles, searches and ad records in the source file are dropped by the parser
 * on the user's own machine and never transmitted.
 */

import type { Firestore } from 'firebase-admin/firestore'
import { BlobTooLargeError, MAX_BLOB_BYTES, decodeBlob, encodeBlob } from '@/domain/blob'
import { paths } from '@/data/schema'
import type { WatchEntry } from '@/ingest/takeout'

/** One document per user; the id is fixed because there is only ever one import. */
export const IMPORT_DOC = 'imported'

export interface StoredWatchHistory {
  readonly entries: readonly WatchEntry[]
  readonly importedAt: number
  /** How many entries the source file held, before filtering and the cap. */
  readonly sourceTotal: number
}

export interface WatchHistoryStore {
  save(uid: string, entries: readonly WatchEntry[], sourceTotal: number): Promise<void>
  load(uid: string): Promise<StoredWatchHistory | null>
  clear(uid: string): Promise<void>
}

function watchedPath(uid: string): string {
  return `${paths.user(uid)}/watched/${IMPORT_DOC}`
}

/** A stored entry we cannot vouch for is dropped rather than guessed at. */
function asEntry(value: unknown): WatchEntry | null {
  if (!value || typeof value !== 'object') return null
  const e = value as Record<string, unknown>
  if (typeof e.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(e.videoId)) return null
  if (typeof e.watchedAt !== 'number' || !Number.isFinite(e.watchedAt)) return null
  return { videoId: e.videoId, watchedAt: e.watchedAt }
}

export class FirestoreWatchHistoryStore implements WatchHistoryStore {
  constructor(private readonly db: Firestore) {}

  /**
   * Replace any previous import.
   *
   * Replacing rather than merging is the honest behaviour: the file is a
   * snapshot of the user's history at a moment, and merging two snapshots would
   * produce a list that matches neither.
   */
  async save(uid: string, entries: readonly WatchEntry[], sourceTotal: number): Promise<void> {
    let blob
    try {
      blob = encodeBlob([...entries], MAX_BLOB_BYTES)
    } catch (err) {
      if (!(err instanceof BlobTooLargeError)) throw err
      // Halve and retry rather than fail the import outright: a shorter history
      // is worth more to the user than an error.
      blob = encodeBlob([...entries].slice(0, Math.floor(entries.length / 2)), MAX_BLOB_BYTES)
    }

    await this.db.doc(watchedPath(uid)).set({
      entries: blob,
      importedAt: Date.now(),
      count: blob.count,
      sourceTotal,
    })
  }

  async load(uid: string): Promise<StoredWatchHistory | null> {
    const snap = await this.db.doc(watchedPath(uid)).get()
    if (!snap.exists) return null

    const data = snap.data()
    const raw = data?.entries
    if (!raw || typeof raw !== 'object') return null

    let decoded: unknown[]
    try {
      decoded = decodeBlob<unknown>(raw as never)
    } catch {
      // An undecodable blob is a missing import, not a crash.
      return null
    }

    const entries = decoded.map(asEntry).filter((e): e is WatchEntry => e !== null)
    return {
      entries,
      importedAt: typeof data?.importedAt === 'number' ? data.importedAt : 0,
      sourceTotal: typeof data?.sourceTotal === 'number' ? data.sourceTotal : entries.length,
    }
  }

  async clear(uid: string): Promise<void> {
    await this.db.doc(watchedPath(uid)).delete()
  }
}
