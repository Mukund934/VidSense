import { cookies } from 'next/headers'
import { getAuth } from 'firebase-admin/auth'

import { adminApp } from '@/lib/server/deps'
import { SESSION_COOKIE, SESSION_MAX_AGE_MS } from '@/lib/server/session'

export const runtime = 'nodejs'

/**
 * Exchange a Firebase ID token for a session.
 *
 * The cookie is a **session cookie the Admin SDK mints and signs**, not the uid
 * it decoded. That distinction is the security of the whole product: a cookie
 * holding a bare uid is a cookie anyone can type, and every route that resolves
 * a uid writes through the Admin SDK, which bypasses the Firestore rules that
 * would otherwise stand between a forged identity and someone else's data.
 *
 * `createSessionCookie` also re-verifies the ID token as it goes, so a token
 * that is expired, from another project, or simply invented never reaches the
 * point of minting anything.
 */
export async function POST(request: Request): Promise<Response> {
  const app = adminApp()
  if (!app) {
    return Response.json(
      { error: 'not_configured', detail: 'This server cannot verify sign-ins.' },
      { status: 503 },
    )
  }

  let body: { idToken?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'Send a JSON body.' }, { status: 400 })
  }
  if (!body.idToken) return Response.json({ error: 'idToken is required.' }, { status: 400 })

  try {
    const session = await getAuth(app).createSessionCookie(body.idToken, {
      expiresIn: SESSION_MAX_AGE_MS,
    })
    const jar = await cookies()
    jar.set(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS / 1000,
      secure: process.env.NODE_ENV === 'production',
    })
    return Response.json({ ok: true })
  } catch {
    // Deliberately not echoing the verification error: it can describe the
    // token, and the caller already knows what they sent.
    return Response.json({ error: 'invalid_token' }, { status: 401 })
  }
}

export async function DELETE(): Promise<Response> {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
  return Response.json({ ok: true })
}
