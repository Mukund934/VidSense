/**
 * Deleting what we are no longer allowed to keep.
 *
 * The YouTube API Terms give a 30-day window on API-derived data, and D14/D44
 * turn that into a rule: refresh the row or drop it. `expiresAt` has been
 * written on every video document since the schema existed, and every read has
 * honoured it — but *honouring* an expiry is not the same as *enforcing* one.
 * An expired document was simply never read again while sitting in Firestore
 * indefinitely, which satisfies the cache and not the obligation.
 *
 * **Why this is application code rather than a Firestore TTL policy.** TTL
 * requires the Blaze plan (`ARCHITECTURE.md` §6, trap 1), and enabling it
 * "because it is tidy" silently moves the project onto billing. So the sweep is
 * a query and a batch of deletes, run on a schedule.
 *
 * Everything here is written against the narrowest slice of the Firestore API
 * that will do the job, so the emulator suite exercises the same code the
 * deployment runs.
 */

import { paths } from '@/data/schema'

/** The parts of Firestore this needs, and nothing more. */
export interface RetentionStore {
  /**
   * Ids of video documents whose `expiresAt` has passed, oldest first, at most
   * `limit` of them.
   */
  expiredVideoIds(now: number, limit: number): Promise<string[]>
  /** Delete one video document and everything beneath it. */
  deleteVideo(videoId: string): Promise<void>
}

export interface SweepReport {
  /** Video documents actually removed. */
  readonly deleted: number
  /** Documents that were expired but could not be deleted. */
  readonly failed: number
  /**
   * True when the batch filled up, so there is more to do.
   *
   * Reported rather than looped over: a sweep that keeps going until the
   * collection is clean is a sweep that can run for an unbounded time inside a
   * request with a 300-second ceiling, and one that is interrupted halfway
   * looks identical to one that failed.
   */
  readonly more: boolean
}

/**
 * How many videos one run will delete.
 *
 * Sized against the free tier rather than against speed: 20,000 deletes a day
 * is the whole Spark allowance, and a sweep that consumes it has taken the
 * product down to protect a retention window. 200 is far more than a day's
 * ingest could produce at this scale, and a backlog drains over consecutive
 * days rather than in one burst.
 */
export const SWEEP_LIMIT = 200

export async function sweepExpired(
  store: RetentionStore,
  now: number,
  limit: number = SWEEP_LIMIT,
): Promise<SweepReport> {
  const ids = await store.expiredVideoIds(now, limit)

  let deleted = 0
  let failed = 0

  // Sequential on purpose. A parallel fan-out over 200 recursive deletes is a
  // write burst against a shared quota, and there is nothing waiting on this.
  for (const id of ids) {
    try {
      await store.deleteVideo(id)
      deleted += 1
    } catch {
      // One undeletable document must not strand the other 199. It will be
      // found again on the next run, which is the right retry policy for
      // something that runs daily.
      failed += 1
    }
  }

  return { deleted, failed, more: ids.length >= limit }
}

/** The Firestore surface `FirestoreRetentionStore` needs. Kept structural for the fakes. */
export interface RetentionDb {
  collection(path: string): {
    where(field: string, op: '<=', value: number): {
      orderBy(field: string): { limit(n: number): { get(): Promise<QuerySnapshotLike> } }
    }
  }
  recursiveDelete(ref: unknown): Promise<void>
  doc(path: string): unknown
}

interface QuerySnapshotLike {
  readonly docs: ReadonlyArray<{ readonly id: string }>
}

export class FirestoreRetentionStore implements RetentionStore {
  constructor(private readonly db: RetentionDb) {}

  async expiredVideoIds(now: number, limit: number): Promise<string[]> {
    // A single-field inequality, so no composite index is needed — which is the
    // reason `firestore.indexes.json` can stay empty.
    const snapshot = await this.db
      .collection('videos')
      .where('expiresAt', '<=', now)
      .orderBy('expiresAt')
      .limit(limit)
      .get()

    return snapshot.docs.map((doc) => doc.id)
  }

  async deleteVideo(videoId: string): Promise<void> {
    // Recursive, because the comment pages live underneath — and comment text
    // is precisely the thing D14 names as delete-at-30-days. Deleting the
    // parent document alone would leave them behind as orphans, invisible to
    // every read and still stored.
    await this.db.recursiveDelete(this.db.doc(paths.video(videoId)))
  }
}
