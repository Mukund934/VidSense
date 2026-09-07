import 'server-only'
import { cookies } from 'next/headers'
import { randomUUID } from 'node:crypto'

/**
 * Who is asking.
 *
 * Firebase Auth is the intended identity for the deployed product. Until that
 * is wired, a local visitor gets a stable anonymous id in a cookie so history
 * and conversations still belong to *someone* — which keeps the data model
 * honest and means the Firestore paths under `users/{uid}` are exercised the
 * same way in development as in production.
 *
 * This is deliberately not a security boundary and is not treated as one: the
 * server writes through the Admin SDK, and the rules that protect user data are
 * enforced against real Firebase Auth identities, not against this cookie.
 */
export const UID_COOKIE = 'vs_uid'

export async function currentUid(): Promise<string> {
  const jar = await cookies()
  const existing = jar.get(UID_COOKIE)?.value
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing
  return `anon_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}
