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
/** Set only after the Admin SDK has verified a Firebase ID token. */
export const SESSION_COOKIE = 'vs_session'

const UID_SHAPE = /^[A-Za-z0-9_-]{8,128}$/

/**
 * A signed-in user takes precedence over the anonymous visitor id, so signing
 * in adopts an identity rather than merging two.
 */
export async function currentUid(): Promise<string> {
  const jar = await cookies()

  const session = jar.get(SESSION_COOKIE)?.value
  if (session && UID_SHAPE.test(session)) return session

  const anonymous = jar.get(UID_COOKIE)?.value
  if (anonymous && UID_SHAPE.test(anonymous)) return anonymous

  return `anon_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/** True when the current identity came from a verified sign-in. */
export async function isSignedIn(): Promise<boolean> {
  const jar = await cookies()
  const session = jar.get(SESSION_COOKIE)?.value
  return Boolean(session && UID_SHAPE.test(session))
}
