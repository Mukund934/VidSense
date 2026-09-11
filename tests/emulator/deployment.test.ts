/**
 * The deployment ceiling, against the emulator.
 *
 * The in-memory suite proves the arithmetic. This proves the thing the
 * arithmetic depends on and a map cannot demonstrate: that the read, the
 * decision and the write are **one indivisible step**, so a crowd of requests
 * arriving together cannot each be told there is room.
 *
 * That is the whole guarantee. If it does not hold here, the ceiling is a
 * suggestion.
 *
 * Requires the Firestore emulator. `npm run test:emulator` provides one.
 */

import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type App, deleteApp, initializeApp } from 'firebase-admin/app'
import { type Firestore, getFirestore } from 'firebase-admin/firestore'

import { FirestoreDeploymentStore } from '@/data/deployment'
import { paths } from '@/data/schema'
import { RESERVATION_TTL_MS, dayKey, type DeploymentLimits } from '@/quota/budget'

const PROJECT = 'vidsense-deployment-test'
const HOUR = 60 * 60
const T0 = Date.UTC(2026, 8, 11, 12, 0, 0)

const limits: DeploymentLimits = {
  videoSecondsPerDay: 3 * HOUR,
  ingestsPerDay: 50,
  asksPerDay: 5,
}
const WORST = 1 * HOUR

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
let store: FirestoreDeploymentStore

beforeAll(() => {
  const { host, port } = emulator()
  process.env.FIRESTORE_EMULATOR_HOST = `${host}:${port}`
  app = initializeApp({ projectId: PROJECT }, 'deployment-tests')
  db = getFirestore(app)
  store = new FirestoreDeploymentStore(db)
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

describe('FirestoreDeploymentStore', () => {
  it('writes to one document for the whole deployment', async () => {
    await store.claim('ingest', limits, WORST, T0)

    // Not under users/**. The counter belongs to nobody, which is what makes it
    // immune to someone arriving as somebody new.
    const snapshot = await db.doc(paths.deploymentDay(dayKey(T0))).get()
    expect(snapshot.exists).toBe(true)
    expect(snapshot.data()?.ingest).toBe(1)
  })

  describe('everyone arriving at once', () => {
    // Sized to what Firestore will actually serialise on one document. Push
    // this far higher and transactions start aborting with a lock timeout
    // instead of returning a decision — which is a real behaviour, handled in
    // `spend` and tested deterministically in tests/server/quota-contention,
    // rather than something worth reproducing here with a stopwatch.
    it('admits only what the ceiling can cover', async () => {
      const claims = await Promise.all(
        Array.from({ length: 15 }, () => store.claim('ingest', limits, WORST, T0)),
      )
      const admitted = claims.filter((c) => c.decision.allowed)
      const usage = await store.read(T0)

      // Fifteen callers, three hours, an hour of worst case each. A read, a
      // decision and a write that were not one step would let more than three
      // through, every one of them holding an hour.
      expect(admitted).toHaveLength(3)
      expect(usage.reservedSeconds).toBe(3 * HOUR)

      // Actual consumption is never more than what was reserved, so this single
      // inequality is the guarantee the whole design exists to make.
      expect(usage.videoSeconds + usage.reservedSeconds).toBeLessThanOrEqual(
        limits.videoSecondsPerDay,
      )
    })

    it('hands out a distinct reservation to each winner', async () => {
      const claims = await Promise.all(
        Array.from({ length: 3 }, () => store.claim('ingest', limits, WORST, T0)),
      )
      const ids = claims.map((c) => c.reservation).filter(Boolean)

      // A collision would mean one settlement releasing somebody else's hold.
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('counts questions exactly once each', async () => {
      const claims = await Promise.all(
        Array.from({ length: 12 }, () => store.claim('ask', limits, WORST, T0)),
      )

      expect(claims.filter((c) => c.decision.allowed)).toHaveLength(5)
      expect((await store.read(T0)).ask).toBe(5)
    })
  })

  describe('settlement', () => {
    it('replaces the hold with the real duration', async () => {
      const claim = await store.claim('ingest', limits, WORST, T0)
      await store.settle('ingest', claim.reservation, 420, T0)

      const usage = await store.read(T0)
      expect(usage.videoSeconds).toBe(420)
      expect(usage.reservedSeconds).toBe(0)
      expect(usage.ingest).toBe(1)
    })

    it('frees the room the hold was taking', async () => {
      const claims = await Promise.all(
        Array.from({ length: 3 }, () => store.claim('ingest', limits, WORST, T0)),
      )
      expect((await store.claim('ingest', limits, WORST, T0)).decision.allowed).toBe(false)

      for (const c of claims) await store.settle('ingest', c.reservation, 60, T0)
      expect((await store.claim('ingest', limits, WORST, T0)).decision.allowed).toBe(true)
    })

    it('gives back the count as well when nothing was spent', async () => {
      const claim = await store.claim('ingest', limits, WORST, T0)
      await store.release('ingest', claim.reservation, T0)

      const usage = await store.read(T0)
      expect(usage.ingest).toBe(0)
      expect(usage.reservedSeconds).toBe(0)
      expect(usage.videoSeconds).toBe(0)
    })

    it('settles concurrently without losing an update', async () => {
      const claims = await Promise.all(
        Array.from({ length: 3 }, () => store.claim('ingest', limits, WORST, T0)),
      )
      await Promise.all(claims.map((c) => store.settle('ingest', c.reservation, 100, T0)))

      // Three settlements into one document. A lost update would show up as a
      // total below 300 and as a hold that was never released.
      const usage = await store.read(T0)
      expect(usage.videoSeconds).toBe(300)
      expect(usage.reservedSeconds).toBe(0)
    })

    it('does nothing for a day that was never opened', async () => {
      await store.settle('ingest', 'nonexistent', 500, T0)
      expect((await db.doc(paths.deploymentDay(dayKey(T0))).get()).exists).toBe(false)
    })
  })

  describe('a reservation nobody ever settles', () => {
    it('stops counting once it expires', async () => {
      // The process died between claiming and settling. Without expiry this
      // ceiling stays three-quarters full until midnight.
      for (let i = 0; i < 3; i += 1) await store.claim('ingest', limits, WORST, T0)
      expect((await store.claim('ingest', limits, WORST, T0)).decision.allowed).toBe(false)

      const later = T0 + RESERVATION_TTL_MS + 1
      expect((await store.read(later)).reservedSeconds).toBe(0)
      expect((await store.claim('ingest', limits, WORST, later)).decision.allowed).toBe(true)
    })

    it('is cleared out of the document rather than merely ignored', async () => {
      for (let i = 0; i < 3; i += 1) await store.claim('ingest', limits, WORST, T0)

      const later = T0 + RESERVATION_TTL_MS + 1
      await store.claim('ingest', limits, WORST, later)

      // Compaction on write, because a document that only ever accumulates
      // reservations grows for the life of the day.
      const data = (await db.doc(paths.deploymentDay(dayKey(T0))).get()).data()
      expect(Object.keys(data?.reservations ?? {})).toHaveLength(1)
    })
  })

  it('starts a new document on the next UTC day', async () => {
    const claim = await store.claim('ingest', limits, WORST, T0)
    await store.settle('ingest', claim.reservation, 3 * HOUR, T0)
    expect((await store.claim('ingest', limits, WORST, T0)).decision.allowed).toBe(false)

    const tomorrow = T0 + 24 * 60 * 60 * 1000
    expect((await store.claim('ingest', limits, WORST, tomorrow)).decision.allowed).toBe(true)
    // Yesterday is kept: it is the record of what the deployment actually used.
    expect((await db.doc(paths.deploymentDay(dayKey(T0))).get()).data()?.videoSeconds).toBe(3 * HOUR)
  })
})
