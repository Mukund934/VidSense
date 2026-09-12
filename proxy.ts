import { NextResponse, type NextRequest } from 'next/server'

import { STATIC_SECURITY_HEADERS, contentSecurityPolicy } from '@/lib/security-headers'

/**
 * Two jobs, both of which have to happen before a page renders.
 *
 * **Identity.** `currentUid()` can read a cookie but cannot create one — a
 * Server Component render is not allowed to set headers. Without this, every
 * request minted a fresh id and history could never accumulate, which looked
 * like Firestore failing when nothing was wrong with it.
 *
 * This is identity, not authentication. It is not a security boundary and
 * nothing trusts it as one: a signed-in user is a Firebase session cookie the
 * Admin SDK verifies, and `lib/server/session.ts` will not accept a visitor id
 * that could name a Firebase account.
 *
 * **The nonce.** A strict script policy needs a fresh nonce per request, and
 * the only place to mint one is ahead of the render. Next.js reads it back out
 * of the request's own CSP header and stamps it onto the scripts it emits.
 */
const UID_COOKIE = 'vs_uid'
const ONE_YEAR = 60 * 60 * 24 * 365

/**
 * The shape must match `ANON_SHAPE` in `lib/server/session.ts` exactly — `anon_`
 * and twenty lowercase hex characters. That server-side pattern is what keeps a
 * visitor cookie from being able to name a Firebase account, so an id minted in
 * any other shape here is simply discarded on the next request and history
 * stops accumulating. `tests/server/proxy.test.ts` holds the two together.
 */
function mintVisitorId(): string {
  return `anon_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID())
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV !== 'production')

  // Set on the *request* as well as the response: that inbound copy is how
  // Next.js discovers the nonce and applies it to its own hydration scripts.
  // Without it every inline script Next emits is blocked and the page never
  // becomes interactive.
  const headers = new Headers(request.headers)
  headers.set('x-nonce', nonce)
  headers.set('content-security-policy', csp)

  const response = NextResponse.next({ request: { headers } })
  response.headers.set('content-security-policy', csp)
  for (const [name, value] of STATIC_SECURITY_HEADERS) response.headers.set(name, value)

  if (!request.cookies.get(UID_COOKIE)) {
    response.cookies.set(UID_COOKIE, mintVisitorId(), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ONE_YEAR,
      secure: process.env.NODE_ENV === 'production',
    })
  }

  return response
}

export const config = {
  // Everything except static assets, which have no use for an identity — and
  // which `next.config.ts` covers with the static headers on their own.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
