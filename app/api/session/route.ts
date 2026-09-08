import { cookies } from 'next/headers'
import { getAuth } from 'firebase-admin/auth'

import { adminApp } from '@/lib/server/deps'
import { SESSION_COOKIE } from '@/lib/server/session'

export const runtime = 'nodejs'

const ONE_WEEK_SEC = 60 * 60 * 24 * 7

/**
 * Exchange a Firebase ID token for a session.
 *
 * The token is verified server-side with the Admin SDK before anything is
 * written. A uid the browser merely asserts is worth nothing; only a verified
 * one gets to own data under `users/{uid}`.
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
    const decoded = await getAuth(app).verifyIdToken(body.idToken)
    const jar = await cookies()
    jar.set(SESSION_COOKIE, decoded.uid, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ONE_WEEK_SEC,
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
