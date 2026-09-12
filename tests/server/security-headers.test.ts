import { describe, expect, it } from 'vitest'

import { STATIC_SECURITY_HEADERS, contentSecurityPolicy } from '@/lib/security-headers'

/**
 * A CSP is only worth what its weakest directive is worth, and the weak ones
 * arrive by accident — a wildcard added to unbreak one thing, an `unsafe-inline`
 * copied from a tutorial. These tests name the properties that must survive a
 * future edit, so that relaxing one is a decision rather than a diff nobody read.
 */

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/)
      return [name ?? '', values]
    }),
  )
}

const PROD = contentSecurityPolicy('abc123', false)
const DEV = contentSecurityPolicy('abc123', true)

describe('contentSecurityPolicy', () => {
  it('carries the request nonce into script-src', () => {
    expect(directives(PROD).get('script-src')).toContain("'nonce-abc123'")
  })

  it('never allows an inline script', () => {
    // The whole point of the nonce. `unsafe-inline` alongside it would make the
    // nonce decorative, because browsers ignore the nonce once it is present.
    expect(PROD).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(directives(PROD).get('script-src')).not.toContain("'unsafe-inline'")
    expect(directives(DEV).get('script-src')).not.toContain("'unsafe-inline'")
  })

  it('allows eval only while developing', () => {
    // React Refresh needs it. A production bundle that needs it is a bug.
    expect(directives(DEV).get('script-src')).toContain("'unsafe-eval'")
    expect(directives(PROD).get('script-src')).not.toContain("'unsafe-eval'")
  })

  it('opens the hot-reload socket only while developing', () => {
    expect(directives(DEV).get('connect-src')).toContain('ws:')
    expect(directives(PROD).get('connect-src')).not.toContain('ws:')
  })

  it('refuses to be framed', () => {
    // Clickjacking a signed-in session is the attack; there is no legitimate
    // embedder to make an exception for.
    expect(directives(PROD).get('frame-ancestors')).toEqual(["'none'"])
  })

  it('frames the player and the sign-in flow, and nothing else', () => {
    const frames = directives(PROD).get('frame-src') ?? []
    expect(frames).toContain('https://www.youtube.com')
    expect(frames).toContain('https://accounts.google.com')
    expect(frames).not.toContain('*')
    expect(frames).not.toContain("'self'")
  })

  it('locks the directives that have no reason to be open', () => {
    const d = directives(PROD)
    expect(d.get('object-src')).toEqual(["'none'"])
    expect(d.get('base-uri')).toEqual(["'self'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('default-src')).toEqual(["'self'"])
  })

  it('has no bare wildcard anywhere', () => {
    // Subdomain wildcards on a named host are fine; a lone `*` is not.
    for (const [name, values] of directives(PROD)) {
      expect(values, name).not.toContain('*')
      expect(values, name).not.toContain('https:')
      expect(values, name).not.toContain('data:script')
    }
  })

  it('upgrades insecure requests in production only', () => {
    expect(PROD).toContain('upgrade-insecure-requests')
    expect(DEV).not.toContain('upgrade-insecure-requests')
  })
})

describe('STATIC_SECURITY_HEADERS', () => {
  it('covers the four that have no per-request part', () => {
    const names = new Set(STATIC_SECURITY_HEADERS.map(([name]) => name))
    expect(names).toContain('x-content-type-options')
    expect(names).toContain('x-frame-options')
    expect(names).toContain('referrer-policy')
    expect(names).toContain('permissions-policy')
  })

  it('is lower-cased, so setting it twice replaces rather than appends', () => {
    for (const [name] of STATIC_SECURITY_HEADERS) expect(name).toBe(name.toLowerCase())
  })

  it('leaves popups usable, because sign-in is one', () => {
    const coop = STATIC_SECURITY_HEADERS.find(([n]) => n === 'cross-origin-opener-policy')
    expect(coop?.[1]).toBe('same-origin-allow-popups')
  })
})
