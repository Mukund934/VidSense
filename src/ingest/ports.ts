/**
 * Ports the orchestrator depends on.
 *
 * Kept separate from their Firestore implementations so the whole ingest flow —
 * cache hits, single-flight, retention, failure paths — is testable in memory,
 * with no emulator and no network.
 */

import type { EncodedBlob } from '@/domain/blob'
import type { TranscriptProvenance } from '@/domain/transcript'
import type { AnalysisStatus, HistoryDoc, VideoMetadata } from '@/data/schema'

/** The shared video-knowledge record as the orchestrator sees it. */
export interface StoredVideo {
  metadata: VideoMetadata
  transcript?: EncodedBlob
  transcriptParts?: EncodedBlob[]
  provenance: TranscriptProvenance
  ingestedAt: number
  refreshedAt: number
  expiresAt: number
  schemaVersion: number
  status: AnalysisStatus
  failureReason?: string
}

export interface VideoStore {
  get(videoId: string): Promise<StoredVideo | null>
  put(videoId: string, doc: StoredVideo): Promise<void>
}

export interface HistoryStore {
  /** Upsert the user's record that they opened this video. */
  touch(uid: string, entry: HistoryDoc): Promise<void>
}

export type MetadataResult =
  | { ok: true; metadata: VideoMetadata; availability: 'public' | 'unlisted' }
  | { ok: false; reason: 'unavailable' | 'live' | 'upcoming' | 'not_found' | 'error'; detail?: string }

export interface MetadataSource {
  fetch(videoId: string): Promise<MetadataResult>
}

/** Injectable so tests are deterministic and the retention window is checkable. */
export type Clock = () => number
