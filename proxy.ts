import { NextResponse, type NextRequest } from 'next/server'

/**
 * Give every visitor a stable id.
 *
 * `currentUid()` can read a cookie but cannot create one — a Server Component
 * render is not allowed to set headers. Without this, every request minted a
 * fresh id and history could never accumulate, which looked like Firestore
 * failing when nothing was wrong with it.
 *
 * This is identity, not authentication. It is not a security boundary and
 * nothing trusts it as one: the server writes through the Admin SDK, and the
 * rules protecting user data are enforced against real Firebase Auth
 * identities.
 */
const UID_COOKIE = 'vs_uid'
const ONE_YEAR = 60 * 60 * 24 * 365

/**
 * The shape must match `ANON_SHAPE` in `lib/server/session.ts` exactly — `anon_`
 * and twenty lowercase hex characters. That server-side pattern is what keeps a
 * visitor cookie from being able to name a Firebase account, so an id minted in
 * any other shape here is simply discarded on the next request and history
 * stops accumulating. `tests/server/session.test.ts` holds the two together.
 */
function mintVisitorId(): string {
  return `anon_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export function proxy(request: NextRequest) {
  const response = NextResponse.next()
  if (request.cookies.get(UID_COOKIE)) return response

  response.cookies.set(UID_COOKIE, mintVisitorId(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR,
    secure: process.env.NODE_ENV === 'production',
  })
  return response
}

export const config = {
  // Everything except static assets, which have no use for an identity.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
