/**
 * The annotation store, against the emulator.
 *
 * The property that matters most is negative: one user's marks must be
 * unreachable from another's. Ownership bugs do not announce themselves, so it
 * gets an explicit test rather than an assumption.
 *
 * Requires the Firestore emulator. `npm run test:emulator` provides one.
 */

import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type App, deleteApp, initializeApp } from 'firebase-admin/app'
import { type Firestore, getFirestore } from 'firebase-admin/firestore'

import { FirestoreAnnotationStore, type NewAnnotation } from '@/data/annotations'
import { paths } from '@/data/schema'

const PROJECT = 'vidsense-annotations-test'
const ZWSP = '\u200B' // zero-width space
const VIDEO = 'dQw4w9WgXcQ'
const OTHER = 'jNQXAC9IVRw'

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
let store: FirestoreAnnotationStore

beforeAll(() => {
  const { host, port } = emulator()
  process.env.FIRESTORE_EMULATOR_HOST = `${host}:${port}`
  app = initializeApp({ projectId: PROJECT }, 'annotation-tests')
  db = getFirestore(app)
  store = new FirestoreAnnotationStore(db)
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

const mark = (over: Partial<NewAnnotation> = {}): NewAnnotation => ({
  kind: 'note',
  videoId: VIDEO,
  tMs: 30_000,
  text: 'a thought',
  ...over,
})

describe('FirestoreAnnotationStore', () => {
  it('returns nothing for a video with no marks', async () => {
    expect(await store.list('alice', VIDEO)).toEqual([])
  })

  it('round-trips a note', async () => {
    const saved = await store.add('alice', mark())
    const [found] = await store.list('alice', VIDEO)

    expect(found?.id).toBe(saved.id)
    expect(found?.kind).toBe('note')
    expect(found?.text).toBe('a thought')
    expect(found?.tMs).toBe(30_000)
  })

  it('round-trips a labelled bookmark', async () => {
    await store.add('alice', mark({ kind: 'bookmark', text: 'the good bit' }))
    const [found] = await store.list('alice', VIDEO)
    expect(found?.kind).toBe('bookmark')
    expect(found?.text).toBe('the good bit')
  })

  it('round-trips an unlabelled bookmark', async () => {
    await store.add('alice', mark({ kind: 'bookmark', text: '' }))
    const [found] = await store.list('alice', VIDEO)
    expect(found?.kind).toBe('bookmark')
    expect(found?.text).toBe('')
  })

  it('merges both kinds into one list in video order', async () => {
    await store.add('alice', mark({ tMs: 90_000, text: 'third' }))
    await store.add('alice', mark({ kind: 'bookmark', tMs: 10_000, text: 'first' }))
    await store.add('alice', mark({ tMs: 50_000, text: 'second' }))

    const found = await store.list('alice', VIDEO)
    expect(found.map((m) => m.text)).toEqual(['first', 'second', 'third'])
  })

  it('keeps marks for different videos apart', async () => {
    await store.add('alice', mark({ text: 'about this one' }))
    await store.add('alice', mark({ videoId: OTHER, text: 'about the other' }))

    expect((await store.list('alice', VIDEO)).map((m) => m.text)).toEqual(['about this one'])
    expect((await store.list('alice', OTHER)).map((m) => m.text)).toEqual(['about the other'])
  })

  it('keeps users apart', async () => {
    await store.add('alice', mark({ text: "alice's note" }))
    await store.add('bob', mark({ text: "bob's note" }))

    expect((await store.list('alice', VIDEO)).map((m) => m.text)).toEqual(["alice's note"])
    expect((await store.list('bob', VIDEO)).map((m) => m.text)).toEqual(["bob's note"])
  })

  it('deletes a mark', async () => {
    const saved = await store.add('alice', mark())
    await store.remove('alice', 'note', saved.id)
    expect(await store.list('alice', VIDEO)).toEqual([])
  })

  it('leaves another user untouched when deleting by id', async () => {
    const hers = await store.add('alice', mark({ text: 'hers' }))
    await store.add('bob', mark({ text: 'his' }))

    // The path is scoped by uid, so bob cannot delete alice's mark by guessing.
    await store.remove('bob', 'note', hers.id)

    expect((await store.list('alice', VIDEO)).map((m) => m.text)).toEqual(['hers'])
  })

  it('deleting something that is not there is not an error', async () => {
    await expect(store.remove('alice', 'note', 'never-existed')).resolves.toBeUndefined()
  })

  it('sanitises a note before it is stored', async () => {
    // A user's own writing still crosses the untrusted boundary — it will be
    // rendered, and may reach a model later.
    await store.add('alice', mark({ text: `hi${ZWSP}there` }))
    expect((await store.list('alice', VIDEO))[0]?.text).toBe('hithere')
  })

  it('writes a note into the collection the security rules govern', async () => {
    await store.add('alice', mark())
    const snapshot = await db.collection(paths.notes('alice')).get()
    expect(snapshot.size).toBe(1)
    expect(snapshot.docs[0]?.get('videoId')).toBe(VIDEO)
  })

  it('writes a bookmark into its own collection, not the notes one', async () => {
    await store.add('alice', mark({ kind: 'bookmark', text: 'x' }))
    expect((await db.collection(paths.notes('alice')).get()).empty).toBe(true)
    expect((await db.collection(paths.bookmarks('alice')).get()).size).toBe(1)
  })

  it('omits an absent label rather than storing undefined', async () => {
    await store.add('alice', mark({ kind: 'bookmark', text: '' }))
    const doc = (await db.collection(paths.bookmarks('alice')).get()).docs[0]
    expect(doc?.data()).not.toHaveProperty('label')
  })
})
