import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

import { proxy } from '../../proxy'

/**
 * The visitor cookie is minted in one file and validated in another, and the
 * two are only correct together. If the proxy hands out an id the server will
 * not accept, every request mints a fresh one, nothing accumulates, and it
 * looks exactly like Firestore failing when nothing is wrong with it.
 *
 * The pattern is duplicated here rather than imported because `session.ts` is
 * `server-only` and the proxy runs somewhere it cannot go. Duplication is the
 * cost; this test is what stops the copies drifting.
 */
const ANON_SHAPE = /^anon_[0-9a-f]{20}$/

function visit(cookie?: string) {
  const request = new NextRequest('https://vidsense.test/')
  if (cookie) request.cookies.set('vs_uid', cookie)
  return proxy(request)
}

describe('proxy', () => {
  it('mints a visitor id the server will accept', () => {
    const value = visit().cookies.get('vs_uid')?.value
    expect(value).toMatch(ANON_SHAPE)
  })

  it('mints a different one for each visitor', () => {
    expect(visit().cookies.get('vs_uid')?.value).not.toBe(visit().cookies.get('vs_uid')?.value)
  })

  it('leaves an existing id alone', () => {
    expect(visit('anon_0123456789abcdef0123').cookies.get('vs_uid')).toBeUndefined()
  })

  it('keeps the cookie out of reach of scripts', () => {
    const cookie = visit().cookies.get('vs_uid')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('lax')
  })
})

describe('security headers', () => {
  it('sends a policy carrying a nonce', () => {
    const csp = visit().headers.get('content-security-policy')
    expect(csp).toMatch(/script-src [^;]*'nonce-[A-Za-z0-9+/=]+'/)
  })

  it('mints a fresh nonce per request', () => {
    const of = (r: ReturnType<typeof visit>) =>
      /'nonce-([A-Za-z0-9+/=]+)'/.exec(r.headers.get('content-security-policy') ?? '')?.[1]
    expect(of(visit())).not.toBe(of(visit()))
  })

  it('sets the static headers alongside it', () => {
    const response = visit()
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  it('protects a request that already has a visitor id', () => {
    // The cookie is set once and the headers are needed every time. An early
    // return after the cookie check would leave a returning visitor unprotected.
    expect(visit('anon_0123456789abcdef0123').headers.get('content-security-policy')).toBeTruthy()
  })
})
