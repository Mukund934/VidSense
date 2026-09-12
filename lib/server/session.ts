import 'server-only'
import { cookies } from 'next/headers'
import { randomUUID } from 'node:crypto'
import { getAuth } from 'firebase-admin/auth'

import { adminApp } from '@/lib/server/deps'

/**
 * Who is asking.
 *
 * Two identities, and the difference between them is the whole of this file.
 *
 * A **signed-in user** is a Firebase session cookie: a JWT the Admin SDK minted
 * and the Admin SDK verifies. It cannot be written by hand, because forging one
 * means forging Google's signature.
 *
 * A **visitor** is `vs_uid`, a random id in a cookie. It is not authentication
 * and nothing treats it as such — it exists so history and marks belong to
 * *someone* before anyone signs in, and so the paths under `users/{uid}` are
 * exercised the same way in development as in production.
 *
 * The namespaces are kept apart deliberately. `vs_uid` is accepted only in the
 * shape this server mints — `anon_` and twenty hex characters — so a visitor
 * cookie can never name a Firebase account. Before that check existed, both
 * cookies were trusted on a shared shape regex, and typing a known uid into
 * either one adopted that person's data: the server writes through the Admin
 * SDK, which bypasses the Firestore rules that would otherwise have stopped it.
 */
export const UID_COOKIE = 'vs_uid'
/** A Firebase session cookie, signed by the Admin SDK. Verified on every read. */
export const SESSION_COOKIE = 'vs_session'

/**
 * A visitor id and nothing else.
 *
 * Anchored at both ends and fixed in length on purpose: this pattern must not
 * be able to match a Firebase uid, or the two identity spaces meet again.
 */
const ANON_SHAPE = /^anon_[0-9a-f]{20}$/

/** Firebase's own bounds are 5 minutes to 14 days. A week is the middle. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function mintVisitorId(): string {
  return `anon_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/**
 * The uid behind a verified session cookie, or null.
 *
 * Verification is a local signature check against public keys the Admin SDK
 * caches, so this costs no network round trip on the hot path. Revocation is
 * deliberately not checked here: it *would* cost a round trip on every request,
 * and the cookie already expires in a week. Sign-out clears it.
 */
export async function verifiedUid(): Promise<string | null> {
  const jar = await cookies()
  const cookie = jar.get(SESSION_COOKIE)?.value
  if (!cookie) return null

  const app = adminApp()
  // No Admin SDK means no way to verify, and an unverifiable session is not a
  // session. Falling back to trusting it is exactly the bug this file fixes.
  if (!app) return null

  try {
    const decoded = await getAuth(app).verifySessionCookie(cookie)
    return decoded.uid
  } catch {
    // Expired, revoked, malformed or forged — all the same answer.
    return null
  }
}

/**
 * A signed-in user takes precedence over the visitor id, so signing in adopts
 * an identity rather than merging two.
 */
export async function currentUid(): Promise<string> {
  const signedIn = await verifiedUid()
  if (signedIn) return signedIn

  const jar = await cookies()
  const visitor = jar.get(UID_COOKIE)?.value
  if (visitor && ANON_SHAPE.test(visitor)) return visitor

  return mintVisitorId()
}

/** True when the current identity came from a verified sign-in. */
export async function isSignedIn(): Promise<boolean> {
  return (await verifiedUid()) !== null
}
