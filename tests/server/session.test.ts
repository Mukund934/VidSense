import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Identity, and what it takes to claim one.
 *
 * The property under test is not precedence — it is *forgeability*. A session
 * cookie must be worth something only because the Admin SDK signed it, and a
 * visitor cookie must never be able to name a Firebase account. An earlier
 * version trusted both on a shared shape regex, so typing a known uid into
 * either cookie adopted that person's history, marks and delete button.
 */

const jar = new Map<string, string>()

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name)
      return value === undefined ? undefined : { name, value }
    },
  }),
}))

/** Present unless a test says otherwise: an absent Admin SDK is its own case. */
let adminConfigured = true
vi.mock('@/lib/server/deps', () => ({
  adminApp: () => (adminConfigured ? ({} as object) : null),
}))

/**
 * The stand-in for Google's signature. Only `signed:<uid>` verifies, so every
 * other string in these tests is what a forger would actually be holding.
 */
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifySessionCookie: async (cookie: string) => {
      if (!cookie.startsWith('signed:')) throw new Error('invalid signature')
      return { uid: cookie.slice('signed:'.length) }
    },
  }),
}))

const { SESSION_COOKIE, UID_COOKIE, currentUid, isSignedIn, mintVisitorId } = await import(
  '@/lib/server/session'
)

const VISITOR = 'anon_0123456789abcdef0123'

beforeEach(() => {
  jar.clear()
  adminConfigured = true
})

describe('currentUid', () => {
  it('prefers a verified session over the visitor id', async () => {
    jar.set(UID_COOKIE, VISITOR)
    jar.set(SESSION_COOKIE, 'signed:firebase-uid-123456')
    expect(await currentUid()).toBe('firebase-uid-123456')
  })

  it('falls back to the visitor id when nobody has signed in', async () => {
    jar.set(UID_COOKIE, VISITOR)
    expect(await currentUid()).toBe(VISITOR)
  })

  it('mints an id when there is no cookie at all', async () => {
    expect(await currentUid()).toMatch(/^anon_[0-9a-f]{20}$/)
  })

  it('mints a different id each time it has to', async () => {
    expect(await currentUid()).not.toBe(await currentUid())
  })

  it('mints ids the visitor cookie will actually be accepted with', async () => {
    // The proxy mints this shape too. If the two ever drift, every visitor is
    // handed an id the next request throws away, and history stops sticking.
    jar.set(UID_COOKIE, mintVisitorId())
    expect(await currentUid()).toBe(jar.get(UID_COOKIE))
  })
})

describe('a session cookie is worth only what its signature is worth', () => {
  it('refuses a cookie holding a bare uid', async () => {
    // The exact attack: paste someone's Firebase uid into the cookie the server
    // used to hand out, and become them.
    jar.set(SESSION_COOKIE, 'firebase-uid-123456')
    expect(await currentUid()).not.toBe('firebase-uid-123456')
    expect(await isSignedIn()).toBe(false)
  })

  it.each([
    ['an unsigned string', 'not-a-jwt'],
    ['something JWT-shaped', 'eyJhbGciOiJub25lIn0.eyJ1aWQiOiJ2aWN0aW0ifQ.'],
    ['empty', ''],
  ])('refuses %s', async (_label, value) => {
    jar.set(SESSION_COOKIE, value)
    expect(await isSignedIn()).toBe(false)
    expect(await currentUid()).toMatch(/^anon_/)
  })

  it('refuses every session when the Admin SDK is not configured', async () => {
    // Unverifiable is not the same as trusted. A deployment without credentials
    // has no signed-in users, rather than a cookie that means whatever it says.
    adminConfigured = false
    jar.set(SESSION_COOKIE, 'signed:firebase-uid-123456')
    expect(await isSignedIn()).toBe(false)
    expect(await currentUid()).toMatch(/^anon_/)
  })
})

describe('the visitor cookie cannot name a Firebase account', () => {
  it.each([
    ['a plain uid', 'firebase-uid-123456'],
    ['a uid wearing the prefix', 'anon_firebase-uid-1234'],
    ['the right prefix, the wrong alphabet', 'anon_ZZZZZZZZZZZZZZZZZZZZ'],
    ['too short', 'anon_0123'],
    ['too long', `anon_${'0'.repeat(40)}`],
    ['a firestore path separator', 'users/alice/history'],
    ['path traversal', '../../etc/passwd'],
    ['whitespace', 'anon_0123456789abcdef012 '],
  ])('refuses %s', async (_label, value) => {
    jar.set(UID_COOKIE, value)
    const uid = await currentUid()
    expect(uid).not.toBe(value)
    expect(uid).toMatch(/^anon_[0-9a-f]{20}$/)
  })
})

describe('isSignedIn', () => {
  it('is true only for a cookie the Admin SDK verified', async () => {
    expect(await isSignedIn()).toBe(false)

    jar.set(UID_COOKIE, VISITOR)
    expect(await isSignedIn()).toBe(false)

    jar.set(SESSION_COOKIE, 'signed:firebase-uid-123456')
    expect(await isSignedIn()).toBe(true)
  })
})
