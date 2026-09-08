import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Identity precedence.
 *
 * The rule that matters: a verified session outranks the anonymous visitor id.
 * Getting this backwards would file a signed-in user's history under a cookie
 * anyone can forge, which is the difference between an identity and a guess.
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

const { SESSION_COOKIE, UID_COOKIE, currentUid, isSignedIn } = await import('@/lib/server/session')

beforeEach(() => {
  jar.clear()
})

describe('currentUid', () => {
  it('prefers a verified session over the anonymous id', async () => {
    jar.set(UID_COOKIE, 'anon_abcdefghij')
    jar.set(SESSION_COOKIE, 'firebase-uid-123456')
    expect(await currentUid()).toBe('firebase-uid-123456')
  })

  it('falls back to the anonymous id when nobody has signed in', async () => {
    jar.set(UID_COOKIE, 'anon_abcdefghij')
    expect(await currentUid()).toBe('anon_abcdefghij')
  })

  it('mints an id when there is no cookie at all', async () => {
    const uid = await currentUid()
    expect(uid).toMatch(/^anon_[a-f0-9]{20}$/)
  })

  it('mints a different id each time it has to', async () => {
    expect(await currentUid()).not.toBe(await currentUid())
  })

  describe('rejects a cookie it cannot vouch for', () => {
    it.each([
      ['too short', 'abc'],
      ['path traversal', '../../etc/passwd'],
      ['a firestore path separator', 'users/alice/history'],
      ['whitespace', 'has space'],
      ['far too long', 'x'.repeat(200)],
    ])('%s', async (_label, value) => {
      jar.set(UID_COOKIE, value)
      const uid = await currentUid()
      expect(uid).not.toBe(value)
      expect(uid).toMatch(/^anon_/)
    })
  })

  it('ignores a malformed session and uses the valid anonymous id', async () => {
    jar.set(SESSION_COOKIE, 'no')
    jar.set(UID_COOKIE, 'anon_abcdefghij')
    expect(await currentUid()).toBe('anon_abcdefghij')
  })
})

describe('isSignedIn', () => {
  it('is true only for a well-formed session cookie', async () => {
    expect(await isSignedIn()).toBe(false)

    jar.set(UID_COOKIE, 'anon_abcdefghij')
    expect(await isSignedIn()).toBe(false)

    jar.set(SESSION_COOKIE, 'firebase-uid-123456')
    expect(await isSignedIn()).toBe(true)
  })

  it('is false for a session cookie that fails the shape check', async () => {
    jar.set(SESSION_COOKIE, 'users/alice')
    expect(await isSignedIn()).toBe(false)
  })
})
