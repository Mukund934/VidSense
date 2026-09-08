/**
 * Notes and bookmarks — the moments a user marks for themselves.
 *
 * Worth stating up front, because it is the opposite of everything else in this
 * product: **these timestamps are exact.** A receipt's time is derived from a
 * transcript a model wrote, and D55 exists because that is only approximately
 * right. A note's time comes from the player's own clock at the moment the user
 * pressed the button — it is the video's real position, not an estimate of it.
 * So a note can always be jumped to precisely, and the UI is allowed to say so.
 *
 * Two kinds, kept apart because they mean different things:
 *
 *   - a **bookmark** says "come back to this moment"
 *   - a **note** says "here is what I thought at this moment"
 *
 * They live in separate collections with separate shapes, because that is what
 * the security rules already enforce. They are merged into one time-ordered
 * list at the edge, because that is how a person wants to read their own marks.
 */

import type { Firestore } from 'firebase-admin/firestore'
import { paths } from '@/data/schema'
import { sanitiseUntrusted } from '@/domain/untrusted'

export type AnnotationKind = 'note' | 'bookmark'

export interface Annotation {
  readonly id: string
  readonly kind: AnnotationKind
  readonly videoId: string
  /** Milliseconds into the video, from the player clock. Exact. */
  readonly tMs: number
  /** A note's body, or a bookmark's label. Empty for an unlabelled bookmark. */
  readonly text: string
  readonly createdAt: number
}

export interface NewAnnotation {
  readonly kind: AnnotationKind
  readonly videoId: string
  readonly tMs: number
  readonly text: string
}

export interface AnnotationStore {
  list(uid: string, videoId: string): Promise<Annotation[]>
  add(uid: string, input: NewAnnotation): Promise<Annotation>
  remove(uid: string, kind: AnnotationKind, id: string): Promise<void>
}

/** The security rules cap these; validating here gives a usable error instead of a write failure. */
export const MAX_NOTE_CHARS = 10_000
export const MAX_LABEL_CHARS = 300

export type ValidationError =
  | 'bad_kind'
  | 'bad_video'
  | 'bad_time'
  | 'empty_note'
  | 'too_long'

/**
 * Check an annotation before it reaches Firestore.
 *
 * The rules would reject a bad write anyway, but a rejected write surfaces as
 * "permission denied", which tells a user nothing about the note they just
 * lost. Validating first turns that into a sentence they can act on.
 */
export function validate(input: NewAnnotation): ValidationError | null {
  if (input.kind !== 'note' && input.kind !== 'bookmark') return 'bad_kind'
  if (!/^[A-Za-z0-9_-]{11}$/.test(input.videoId)) return 'bad_video'
  if (!Number.isInteger(input.tMs) || input.tMs < 0) return 'bad_time'

  const text = input.text.trim()
  if (input.kind === 'note' && text.length === 0) return 'empty_note'
  if (input.kind === 'note' && text.length > MAX_NOTE_CHARS) return 'too_long'
  if (input.kind === 'bookmark' && text.length > MAX_LABEL_CHARS) return 'too_long'

  return null
}

export const VALIDATION_MESSAGE: Record<ValidationError, string> = {
  bad_kind: 'That is not a kind of mark VidSense keeps.',
  bad_video: 'That video reference is not one we can attach a mark to.',
  bad_time: 'A mark needs a real moment in the video.',
  empty_note: 'Write something, or save it as a bookmark instead.',
  too_long: 'That is longer than a mark can hold.',
}

function collection(uid: string, kind: AnnotationKind): string {
  return kind === 'note' ? paths.notes(uid) : paths.bookmarks(uid)
}

export class FirestoreAnnotationStore implements AnnotationStore {
  constructor(private readonly db: Firestore) {}

  /**
   * Both kinds for one video, in video order.
   *
   * Ordered by time rather than by when they were written, because a person
   * reading their own marks is walking the video, not their own history.
   */
  async list(uid: string, videoId: string): Promise<Annotation[]> {
    const kinds: AnnotationKind[] = ['note', 'bookmark']
    const found: Annotation[] = []

    for (const kind of kinds) {
      const snapshot = await this.db
        .collection(collection(uid, kind))
        .where('videoId', '==', videoId)
        .get()

      for (const doc of snapshot.docs) {
        const data = doc.data()
        const tMs = data.tMs
        if (typeof tMs !== 'number') continue
        found.push({
          id: doc.id,
          kind,
          videoId,
          tMs,
          text: String((kind === 'note' ? data.text : data.label) ?? ''),
          createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
        })
      }
    }

    return found.sort((a, b) => a.tMs - b.tMs || a.createdAt - b.createdAt)
  }

  async add(uid: string, input: NewAnnotation): Promise<Annotation> {
    const createdAt = Date.now()
    // A user's own note is still text that will be rendered and may reach a
    // model later; it goes through the same boundary as anyone else's.
    const text = sanitiseUntrusted(input.text).trim()

    const doc =
      input.kind === 'note'
        ? { videoId: input.videoId, tMs: input.tMs, text, createdAt }
        : {
            videoId: input.videoId,
            tMs: input.tMs,
            createdAt,
            ...(text ? { label: text } : {}),
          }

    const ref = await this.db.collection(collection(uid, input.kind)).add(doc)
    return { id: ref.id, kind: input.kind, videoId: input.videoId, tMs: input.tMs, text, createdAt }
  }

  async remove(uid: string, kind: AnnotationKind, id: string): Promise<void> {
    await this.db.collection(collection(uid, kind)).doc(id).delete()
  }
}
