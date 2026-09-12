/**
 * The retention sweep, against a real Firestore.
 *
 * The two things a fake cannot prove are exactly the two that matter here: that
 * the inequality query works without a composite index — which is why
 * `firestore.indexes.json` is allowed to stay empty — and that
 * `recursiveDelete` actually takes the comment pages with the video document.
 * Comment text is precisely what D14 requires deleted at thirty days, and it
 * lives in a subcollection, so a parent-only delete would leave it behind,
 * unreadable and still stored.
 *
 * Requires the Firestore emulator. `npm run test:emulator` provides one.
 */

import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type App, deleteApp, initializeApp } from 'firebase-admin/app'
import { type Firestore, getFirestore } from 'firebase-admin/firestore'

import { FirestoreRetentionStore, sweepExpired } from '@/data/retention'
import { RETENTION_MS, SCHEMA_VERSION, paths, type VideoDoc } from '@/data/schema'
import { encodeBlob } from '@/domain/blob'

const PROJECT = 'vidsense-retention-test'
const NOW = 1_760_000_000_000

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
let store: FirestoreRetentionStore

beforeAll(() => {
  const { host, port } = emulator()
  process.env.FIRESTORE_EMULATOR_HOST = `${host}:${port}`
  app = initializeApp({ projectId: PROJECT }, 'retention-tests')
  db = getFirestore(app)
  store = new FirestoreRetentionStore(db)
})

afterAll(async () => {
  await deleteApp(app)
})

async function wipe() {
  const snapshot = await db.collection('videos').get()
  await Promise.all(snapshot.docs.map((doc) => db.recursiveDelete(doc.ref)))
}

beforeEach(wipe)

function videoDoc(expiresAt: number): VideoDoc {
  return {
    metadata: {
      title: 'Computer Networks',
      channelId: 'c1',
      channelTitle: 'Prof X',
      publishedAt: '2026-01-01',
      durationSec: 600,
    },
    transcript: encodeBlob([{ i: 0, startMs: 0, endMs: 1000, text: 'hello' }]),
    provenance: 'gemini_url',
    ingestedAt: expiresAt - RETENTION_MS,
    refreshedAt: expiresAt - RETENTION_MS,
    expiresAt,
    schemaVersion: SCHEMA_VERSION,
    status: 'ready',
  }
}

async function seed(id: string, expiresAt: number, withComments = false) {
  await db.doc(paths.video(id)).set(videoDoc(expiresAt))
  if (withComments) {
    await db.doc(paths.commentPage(id, '1')).set({
      clusters: encodeBlob([{ text: 'a viewer said something' }]),
      sampleSize: 100,
      fetchedAt: expiresAt - RETENTION_MS,
    })
  }
}

const ids = async () => (await db.collection('videos').get()).docs.map((d) => d.id).sort()

describe('FirestoreRetentionStore', () => {
  it('finds only the videos whose window has closed', async () => {
    await seed('expired0001', NOW - 1)
    await seed('exactly0001', NOW)
    await seed('current0001', NOW + 1)

    expect((await store.expiredVideoIds(NOW, 50)).sort()).toEqual(['exactly0001', 'expired0001'])
  })

  it('runs the query with no composite index', async () => {
    // If this ever needs one, `firestore.indexes.json` stops being empty and
    // the index has to be deployed before the sweep can run in production.
    await seed('expired0001', NOW - 1)
    await expect(store.expiredVideoIds(NOW, 50)).resolves.toHaveLength(1)
  })

  it('returns the oldest first, so a backlog drains in order', async () => {
    await seed('newest00001', NOW - 1000)
    await seed('oldest00001', NOW - 90_000_000)
    await seed('middle00001', NOW - 500_000)

    expect(await store.expiredVideoIds(NOW, 50)).toEqual([
      'oldest00001',
      'middle00001',
      'newest00001',
    ])
  })

  it('honours the limit', async () => {
    for (let i = 0; i < 6; i += 1) await seed(`video00000${i}`, NOW - 1000 * (i + 1))
    expect(await store.expiredVideoIds(NOW, 3)).toHaveLength(3)
  })

  it('takes the comment pages with the video', async () => {
    await seed('expired0001', NOW - 1, true)
    expect((await db.collection(`videos/expired0001/comments`).get()).size).toBe(1)

    await store.deleteVideo('expired0001')

    expect(await ids()).toEqual([])
    // The point of `recursiveDelete`: comment text is what the thirty-day rule
    // names, and it does not live in the parent document.
    expect((await db.collection(`videos/expired0001/comments`).get()).size).toBe(0)
  })
})

describe('sweepExpired, end to end', () => {
  it('removes what has expired and leaves what has not', async () => {
    await seed('expired0001', NOW - 1, true)
    await seed('expired0002', NOW - 500_000)
    await seed('current0001', NOW + RETENTION_MS)

    const report = await sweepExpired(store, NOW)

    expect(report).toEqual({ deleted: 2, failed: 0, more: false })
    expect(await ids()).toEqual(['current0001'])
  })

  it('drains a backlog across runs rather than in one burst', async () => {
    for (let i = 0; i < 5; i += 1) await seed(`video00000${i}`, NOW - 1000 * (i + 1))

    expect((await sweepExpired(store, NOW, 2)).more).toBe(true)
    expect(await ids()).toHaveLength(3)

    expect((await sweepExpired(store, NOW, 2)).more).toBe(true)
    expect((await sweepExpired(store, NOW, 2)).more).toBe(false)
    expect(await ids()).toEqual([])
  })

  it('is a no-op on a collection with nothing expired', async () => {
    await seed('current0001', NOW + RETENTION_MS)
    expect(await sweepExpired(store, NOW)).toEqual({ deleted: 0, failed: 0, more: false })
    expect(await ids()).toEqual(['current0001'])
  })
})
