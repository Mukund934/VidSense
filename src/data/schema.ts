/**
 * Firestore document shapes and collection paths.
 *
 * Two zones, and the boundary between them is the design:
 *
 *   users/{uid}/**   PRODUCT STATE  — private, small, per-user
 *   videos/{videoId} VIDEO KNOWLEDGE — shared, no user data, server-written only
 *
 * Because `videos/**` provably contains no user data, one user's ingest can serve
 * another user's request without any privacy question arising. That is what makes
 * the cross-user cache — and with it the margin story — defensible.
 */

import type { EncodedBlob } from '@/domain/blob'
import type { TranscriptProvenance } from '@/domain/transcript'
import type { Timing } from '@/domain/timing'

// ---------------------------------------------------------------- product state

export interface UserDoc {
  createdAt: number
  displayName?: string
  email?: string
  photoURL?: string
  lastSeenAt?: number
  settings?: {
    theme?: 'light' | 'dark' | 'system'
    telemetryOptIn?: boolean
  }
}

export type AnalysisStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'degraded'

/** The user's own record that they analysed a video. Never holds transcript data. */
export interface HistoryDoc {
  videoId: string
  lastOpenedAt: number
  title?: string
  channelTitle?: string
  thumbnailUrl?: string
  durationSec?: number
  firstAnalyzedAt?: number
  openCount?: number
  conversationCount?: number
  noteCount?: number
  bookmarkCount?: number
  status?: AnalysisStatus
}

export interface ConversationDoc {
  videoId: string
  createdAt: number
  title?: string
  updatedAt?: number
  messageCount?: number
}

export type Lane = 'VIDEO' | 'VIEWERS' | 'EXTERNAL' | 'INFERENCE'

/** A receipt as persisted. Resolved server-side via `resolveReceipt`, never model-authored. */
export interface StoredReceipt {
  cueStart: number
  cueEnd: number
  startMs: number
  endMs: number
  quote: string
  lane: Lane
  confidence?: number
}

/** Immutable once written — rules deny update. You may delete it; you may not rewrite it. */
export interface MessageDoc {
  role: 'user' | 'assistant'
  text: string
  createdAt: number
  receipts?: StoredReceipt[]
  lane?: Lane
  confidence?: number
  model?: string
}

export interface NoteDoc {
  videoId: string
  tMs: number
  text: string
  createdAt: number
  updatedAt?: number
}

export interface BookmarkDoc {
  videoId: string
  tMs: number
  createdAt: number
  label?: string
}

// -------------------------------------------------------------- video knowledge

export interface VideoMetadata {
  title: string
  channelId: string
  channelTitle: string
  publishedAt: string
  durationSec: number
  thumbnailUrl?: string
}

/**
 * One document per video. The transcript lives in a compressed blob field rather
 * than as one document per cue — see docs/ARCHITECTURE.md §3 for the arithmetic
 * that forces this (one doc per cue caps the product at 13 videos/day).
 */
export interface VideoDoc {
  metadata: VideoMetadata
  transcript?: EncodedBlob
  /** Present only when the transcript exceeded the single-document budget. */
  transcriptParts?: EncodedBlob[]
  timeline?: EncodedBlob
  provenance: TranscriptProvenance
  /** Timing trust for the stored cues. See src/domain/timing.ts. */
  timing?: Timing
  ingestedAt: number
  refreshedAt: number
  /** Enforced in application code, NOT by a Firestore TTL policy — TTL requires billing. */
  expiresAt: number
  schemaVersion: number
  status: AnalysisStatus
  failureReason?: string
}

export interface CommentPageDoc {
  clusters: EncodedBlob
  sampleSize: number
  fetchedAt: number
}

export const SCHEMA_VERSION = 1

/** YouTube data retention: refresh or drop within 30 days. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------- paths

export const paths = {
  user: (uid: string) => `users/${uid}`,
  history: (uid: string) => `users/${uid}/history`,
  historyEntry: (uid: string, videoId: string) => `users/${uid}/history/${videoId}`,
  conversations: (uid: string) => `users/${uid}/conversations`,
  conversation: (uid: string, cid: string) => `users/${uid}/conversations/${cid}`,
  messages: (uid: string, cid: string) => `users/${uid}/conversations/${cid}/messages`,
  message: (uid: string, cid: string, mid: string) =>
    `users/${uid}/conversations/${cid}/messages/${mid}`,
  notes: (uid: string) => `users/${uid}/notes`,
  note: (uid: string, id: string) => `users/${uid}/notes/${id}`,
  bookmarks: (uid: string) => `users/${uid}/bookmarks`,
  bookmark: (uid: string, id: string) => `users/${uid}/bookmarks/${id}`,
  usage: (uid: string) => `users/${uid}/usage`,
  /** `day` is a UTC `YYYY-MM-DD`, so the id is the thing the counter resets on. */
  usageDay: (uid: string, day: string) => `users/${uid}/usage/${day}`,
  video: (videoId: string) => `videos/${videoId}`,
  commentPage: (videoId: string, page: string) => `videos/${videoId}/comments/${page}`,
} as const

/** True once the stored copy is older than the retention window. */
export function isExpired(doc: Pick<VideoDoc, 'expiresAt'>, now: number): boolean {
  return doc.expiresAt <= now
}

export function nextExpiry(now: number): number {
  return now + RETENTION_MS
}
