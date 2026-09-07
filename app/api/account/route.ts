import { deleteUserData } from '@/lib/server/history'
import { currentUid } from '@/lib/server/session'

export const runtime = 'nodejs'

/**
 * Delete everything this user has.
 *
 * Scoped to `users/{uid}/**`. Shared video knowledge is untouched: it contains
 * no user data by construction, and evicting a cache other people are using is
 * not what anyone means by "delete my data".
 */
export async function DELETE(): Promise<Response> {
  const uid = await currentUid()
  const { deleted } = await deleteUserData(uid)
  return Response.json({ deleted })
}
