import 'server-only'

import { paths, type HistoryDoc } from '@/data/schema'
import { firestore } from '@/lib/server/deps'

/**
 * The user's own record of what they have analysed.
 *
 * Read straight from `users/{uid}/history`, ordered by when they last opened
 * it. Degraded entries are included on purpose: a video VidSense could not
 * fully read is still a video the user looked at, and hiding it would make the
 * list quietly lie about what happened.
 */
export async function listHistory(uid: string, limit = 60): Promise<HistoryDoc[]> {
  const db = firestore()
  if (!db) return []

  try {
    const snapshot = await db
      .collection(paths.history(uid))
      .orderBy('lastOpenedAt', 'desc')
      .limit(limit)
      .get()

    return snapshot.docs
      .map((doc) => doc.data() as HistoryDoc)
      .filter((entry) => typeof entry.videoId === 'string' && entry.videoId.length > 0)
  } catch {
    // An unreachable store means an empty list, not a broken page.
    return []
  }
}

/**
 * Delete everything belonging to one user.
 *
 * Only `users/{uid}/**` is removed. Shared video knowledge under `videos/**`
 * contains no user data by construction, so it is deliberately left alone —
 * deleting it would evict a cache that other people are using in order to
 * honour a request that never covered it.
 */
export async function deleteUserData(uid: string): Promise<{ deleted: number }> {
  const db = firestore()
  if (!db) return { deleted: 0 }

  let deleted = 0
  const root = db.doc(paths.user(uid))

  // recursiveDelete handles the subcollections in one server-side operation.
  try {
    const history = await db.collection(paths.history(uid)).get()
    deleted += history.size
    const conversations = await db.collection(paths.conversations(uid)).get()
    deleted += conversations.size
    // Notes, bookmarks and any imported watch history live under the same root
    // and go with it; counted so the confirmation is not an understatement.
    for (const name of ['notes', 'bookmarks', 'watched']) {
      deleted += (await db.collection(`${paths.user(uid)}/${name}`).get()).size
    }

    await db.recursiveDelete(root)
    return { deleted }
  } catch {
    return { deleted }
  }
}
