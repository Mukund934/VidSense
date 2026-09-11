/**
 * The daily ledger, against the emulator.
 *
 * One property here cannot be tested any other way, and it is the reason the
 * store uses a transaction at all: **two requests arriving together must not
 * both spend the last unit.** A read, a decision and a write would let them,
 * and the gap is widest under exactly the load that makes it matter.
 *
 * Requires the Firestore emulator. `npm run test:emulator` provides one.
 */

import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type App, deleteApp, initializeApp } from 'firebase-admin/app'
import { type Firestore, getFirestore } from 'firebase-admin/firestore'

import { FirestoreUsageStore } from '@/data/usage'
import { paths } from '@/data/schema'
import { dayKey, type Limits } from '@/quota/budget'

const PROJECT = 'vidsense-usage-test'
const DAY_MS = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 8, 11, 12, 0, 0)

const limits: Limits = {
  perDay: { ingest: 3, ask: 5 },
  perMinute: { ingest: 99, ask: 99 },
  videoSecondsPerDay: 10_000,
}

function emulator(): { host: string; port: number } {
  const config = JSON.parse(readFileSync('firebase.json', 'utf8')) as {
    emulators?: { firestore?: { host?: string; port?: number } }
  }
  const port = config.emulators?.firestore?.port
  if (typeof port !== 'number') throw new Error('firebase.json has no emulators.firestore.port')
  return { host: config.emulators?.firestore?.host ?? '127.0.0.1', port }
}

let app: App
let db: Firestore
let store: FirestoreUsageStore

beforeAll(() => {
  const { host, port } = emulator()
  process.env.FIRESTORE_EMULATOR_HOST = `${host}:${port}`
  app = initializeApp({ projectId: PROJECT }, 'usage-tests')
  db = getFirestore(app)
  store = new FirestoreUsageStore(db)
})

afterAll(async () => {
  await deleteApp(app)
})

beforeEach(async () => {
  const { host, port } = emulator()
  await fetch(
    `http://${host}:${port}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  )
})

describe('FirestoreUsageStore', () => {
  it('creates the day document on the first claim', async () => {
    await store.claim('alice', 'ingest', limits, T0)

    const snapshot = await db.doc(paths.usageDay('alice', dayKey(T0))).get()
    expect(snapshot.exists).toBe(true)
    expect(snapshot.data()?.ingest).toBe(1)
  })

  it('allows up to the limit and refuses after it', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(true)
    }
    expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(false)
  })

  it('writes under the path the security rules govern', async () => {
    // The rules deny client writes to this collection. If the path drifts, the
    // counter silently becomes something a client could reset.
    await store.claim('alice', 'ingest', limits, T0)
    expect(paths.usageDay('alice', dayKey(T0))).toBe(`users/alice/usage/${dayKey(T0)}`)

    const direct = await db.doc(`users/alice/usage/${dayKey(T0)}`).get()
    expect(direct.exists).toBe(true)
  })

  describe('two requests at once', () => {
    it('spends the last unit only once', async () => {
      const attempts = Array.from({ length: 12 }, () =>
        store.claim('alice', 'ingest', limits, T0),
      )
      const decisions = await Promise.all(attempts)

      // Twelve callers, three units. Anything above three means the read and
      // the write were not one step.
      expect(decisions.filter((d) => d.allowed)).toHaveLength(3)

      const stored = await store.read('alice', T0)
      expect(stored.ingest).toBe(3)
    })

    it('does not let concurrent meters interfere', async () => {
      const [ingests, asks] = await Promise.all([
        Promise.all(Array.from({ length: 6 }, () => store.claim('alice', 'ingest', limits, T0))),
        Promise.all(Array.from({ length: 8 }, () => store.claim('alice', 'ask', limits, T0))),
      ])

      // Both meters live in one document, so a lost update would show up here
      // as one meter overspending or the other under-counting.
      expect(ingests.filter((d) => d.allowed)).toHaveLength(3)
      expect(asks.filter((d) => d.allowed)).toHaveLength(5)
    })
  })

  describe('refund', () => {
    it('returns a unit so it can be claimed again', async () => {
      for (let i = 0; i < 3; i += 1) await store.claim('alice', 'ingest', limits, T0)
      expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(false)

      await store.refund('alice', 'ingest', T0)
      expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(true)
    })

    it('does not create a document for a day with no claims', async () => {
      await store.refund('bob', 'ingest', T0)

      // Inventing a record of a refund that cannot have happened would hide a
      // bug rather than surface it.
      const snapshot = await db.doc(paths.usageDay('bob', dayKey(T0))).get()
      expect(snapshot.exists).toBe(false)
    })

    it('never goes negative', async () => {
      await store.claim('alice', 'ingest', limits, T0)
      await store.refund('alice', 'ingest', T0)
      await store.refund('alice', 'ingest', T0)

      expect((await store.read('alice', T0)).ingest).toBe(0)
    })
  })

  describe('seconds', () => {
    it('accumulates across calls', async () => {
      await store.recordSeconds('alice', 600, T0)
      await store.recordSeconds('alice', 900, T0)

      expect((await store.read('alice', T0)).videoSeconds).toBe(1_500)
    })

    it('refuse an ingest once the day of video is spent', async () => {
      await store.recordSeconds('alice', limits.videoSecondsPerDay, T0)

      const decision = await store.claim('alice', 'ingest', limits, T0)
      expect(decision.allowed).toBe(false)
      // The count is nowhere near its limit; it is the hours that ran out, and
      // the two budgets are checked in the same transaction so they cannot
      // disagree about what has been spent.
      expect((await store.read('alice', T0)).ingest).toBe(0)
    })

    it('does not refuse a question, which sends no video anywhere', async () => {
      await store.recordSeconds('alice', limits.videoSecondsPerDay * 5, T0)
      expect((await store.claim('alice', 'ask', limits, T0)).allowed).toBe(true)
    })

    it('leaves the count alone while under the budget', async () => {
      await store.recordSeconds('alice', limits.videoSecondsPerDay - 1, T0)
      expect((await store.claim('alice', 'ingest', limits, T0)).allowed).toBe(true)
    })
  })

  describe('the day boundary', () => {
    it('starts a new document, leaving yesterday intact', async () => {
      for (let i = 0; i < 3; i += 1) await store.claim('alice', 'ingest', limits, T0)
      expect((await store.claim('alice', 'ingest', limits, T0 + DAY_MS)).allowed).toBe(true)

      // Yesterday is kept: it is the only record of what the product actually
      // consumes, and the limits were set from guesses it will correct.
      const yesterday = await db.doc(paths.usageDay('alice', dayKey(T0))).get()
      expect(yesterday.data()?.ingest).toBe(3)
    })
  })

  it('reports an untouched day as empty rather than failing', async () => {
    expect(await store.read('nobody', T0)).toMatchObject({ ingest: 0, ask: 0, videoSeconds: 0 })
  })
})
