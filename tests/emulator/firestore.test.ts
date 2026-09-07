/**
 * Firestore adapters, proven against the emulator.
 *
 * The interesting cases are the ones the in-memory stores cannot express: what
 * a real document round-trips to, what happens when one has been written by a
 * different version of the code, and where an oversized transcript actually
 * lands. Everything here is a real read and a real write.
 *
 * Requires the Firestore emulator. `npm run test:emulator` provides one.
 */

import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type App, deleteApp, initializeApp } from 'firebase-admin/app'
import { type Firestore, getFirestore } from 'firebase-admin/firestore'

import { FirestoreHistoryStore, FirestoreVideoStore } from '@/data/firestore'
import { RETENTION_MS, SCHEMA_VERSION, paths, type VideoMetadata } from '@/data/schema'
import { encodeBlob } from '@/domain/blob'
import { buildTranscript } from '@/domain/transcript'
import { ingestVideo, type IngestDeps } from '@/ingest/orchestrator'
import type { MetadataSource, StoredVideo } from '@/ingest/ports'
import type { FetchResult, TranscriptSource, VideoInput } from '@/ingest/source'
import { parseYouTubeUrl } from '@/ingest/url'

const PROJECT = 'vidsense-adapter-test'
const VIDEO_ID = 'dQw4w9WgXcQ'
const NOW = 1_760_000_000_000
const ref = parseYouTubeUrl(`https://www.youtube.com/watch?v=${VIDEO_ID}`)!

const META: VideoMetadata = {
  title: 'Computer Networks',
  channelId: 'c1',
  channelTitle: 'Prof X',
  publishedAt: '2026-01-01',
  durationSec: 7200,
  thumbnailUrl: 'https://i.ytimg.com/x.jpg',
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
let videos: FirestoreVideoStore
let history: FirestoreHistoryStore

beforeAll(() => {
  const { host, port } = emulator()
  // Read when the Firestore instance is constructed, so it must be set first.
  process.env.FIRESTORE_EMULATOR_HOST = `${host}:${port}`
  app = initializeApp({ projectId: PROJECT }, 'adapter-tests')
  db = getFirestore(app)
  videos = new FirestoreVideoStore(db)
  history = new FirestoreHistoryStore(db)
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

function storedVideo(over: Partial<StoredVideo> = {}): StoredVideo {
  return {
    metadata: META,
    provenance: 'gemini_url',
    ingestedAt: NOW,
    refreshedAt: NOW,
    expiresAt: NOW + RETENTION_MS,
    schemaVersion: SCHEMA_VERSION,
    status: 'ready',
    ...over,
  }
}

function cues(count: number, prefix = 'segment') {
  return Array.from({ length: count }, (_, i) => ({
    i,
    startMs: i * 4000,
    endMs: (i + 1) * 4000,
    text: `${prefix} ${i}`,
  }))
}

const videoRef = () => db.doc(paths.video(VIDEO_ID))

// --------------------------------------------------------------- video store

describe('FirestoreVideoStore', () => {
  it('reports a video it has never seen as a miss', async () => {
    expect(await videos.get('neverStored')).toBeNull()
  })

  it('round-trips a stored video', async () => {
    await videos.put(VIDEO_ID, storedVideo())
    expect(await videos.get(VIDEO_ID)).toEqual(storedVideo())
  })

  it('round-trips a transcript blob unchanged', async () => {
    const transcript = encodeBlob(cues(40))
    await videos.put(VIDEO_ID, storedVideo({ transcript }))

    const loaded = await videos.get(VIDEO_ID)
    expect(loaded?.transcript).toEqual(transcript)
  })

  it('leaves absent optional fields absent rather than undefined', async () => {
    await videos.put(VIDEO_ID, storedVideo())

    const loaded = await videos.get(VIDEO_ID)
    expect(loaded).not.toBeNull()
    expect('transcript' in loaded!).toBe(false)
    expect('failureReason' in loaded!).toBe(false)
    expect('transcriptParts' in loaded!).toBe(false)
  })

  it('preserves a degraded status and its reason', async () => {
    await videos.put(VIDEO_ID, storedVideo({ status: 'degraded', failureReason: 'no_transcript' }))

    const loaded = await videos.get(VIDEO_ID)
    expect(loaded?.status).toBe('degraded')
    expect(loaded?.failureReason).toBe('no_transcript')
  })

  it('preserves a video with no thumbnail', async () => {
    const { thumbnailUrl: _drop, ...bare } = META
    await videos.put(VIDEO_ID, storedVideo({ metadata: bare }))

    const loaded = await videos.get(VIDEO_ID)
    expect('thumbnailUrl' in loaded!.metadata).toBe(false)
  })

  it('replaces rather than merges, so a re-ingest cannot leave stale fields', async () => {
    await videos.put(VIDEO_ID, storedVideo({ failureReason: 'transient' }))
    await videos.put(VIDEO_ID, storedVideo())

    expect('failureReason' in (await videos.get(VIDEO_ID))!).toBe(false)
  })

  describe('distrusts what it did not write', () => {
    it('treats a document from another schema version as a miss', async () => {
      await videos.put(VIDEO_ID, storedVideo())
      await videoRef().update({ schemaVersion: SCHEMA_VERSION + 1 })

      expect(await videos.get(VIDEO_ID)).toBeNull()
    })

    it('treats malformed metadata as a miss', async () => {
      await videos.put(VIDEO_ID, storedVideo())
      await videoRef().update({ 'metadata.durationSec': 'two hours' })

      expect(await videos.get(VIDEO_ID)).toBeNull()
    })

    it('treats an unknown provenance as a miss', async () => {
      await videos.put(VIDEO_ID, storedVideo())
      await videoRef().update({ provenance: 'scraped' })

      expect(await videos.get(VIDEO_ID)).toBeNull()
    })

    it('treats an unknown status as a miss', async () => {
      await videos.put(VIDEO_ID, storedVideo())
      await videoRef().update({ status: 'halfway' })

      expect(await videos.get(VIDEO_ID)).toBeNull()
    })

    it('treats a missing timestamp as a miss', async () => {
      await videos.put(VIDEO_ID, storedVideo())
      await videoRef().update({ expiresAt: 'soon' })

      expect(await videos.get(VIDEO_ID)).toBeNull()
    })

    it('drops a transcript in an unrecognised codec but keeps the video', async () => {
      await videos.put(VIDEO_ID, storedVideo({ transcript: encodeBlob(cues(10)) }))
      await videoRef().update({ 'transcript.codec': 'brotli' })

      const loaded = await videos.get(VIDEO_ID)
      expect(loaded).not.toBeNull()
      expect('transcript' in loaded!).toBe(false)
    })
  })

  describe('oversized transcripts', () => {
    it('stores parts in a subcollection, not on the video document', async () => {
      const parts = [encodeBlob(cues(5, 'a')), encodeBlob(cues(5, 'b'))]
      await videos.put(VIDEO_ID, storedVideo({ transcriptParts: parts }))

      const doc = await videoRef().get()
      expect(doc.get('transcriptParts')).toBeUndefined()
      expect(doc.get('transcriptPartCount')).toBe(2)

      const stored = await videoRef().collection('transcriptParts').get()
      expect(stored.size).toBe(2)
    })

    it('round-trips parts in order', async () => {
      const parts = [encodeBlob(cues(5, 'a')), encodeBlob(cues(5, 'b')), encodeBlob(cues(5, 'c'))]
      await videos.put(VIDEO_ID, storedVideo({ transcriptParts: parts }))

      expect((await videos.get(VIDEO_ID))?.transcriptParts).toEqual(parts)
    })

    it('drops the surplus tail when a re-ingest is shorter', async () => {
      const long = [encodeBlob(cues(5, 'a')), encodeBlob(cues(5, 'b')), encodeBlob(cues(5, 'c'))]
      await videos.put(VIDEO_ID, storedVideo({ transcriptParts: long }))

      const short = [encodeBlob(cues(5, 'a'))]
      await videos.put(VIDEO_ID, storedVideo({ transcriptParts: short }))

      expect((await videos.get(VIDEO_ID))?.transcriptParts).toEqual(short)
      expect((await videoRef().collection('transcriptParts').get()).size).toBe(1)
    })

    it('treats a gap in the parts as a miss rather than a transcript with a hole', async () => {
      const parts = [encodeBlob(cues(5, 'a')), encodeBlob(cues(5, 'b'))]
      await videos.put(VIDEO_ID, storedVideo({ transcriptParts: parts }))
      await videoRef().collection('transcriptParts').doc('1').delete()

      expect(await videos.get(VIDEO_ID)).toBeNull()
    })

    it('writes no parts at all when the transcript fits in one document', async () => {
      await videos.put(VIDEO_ID, storedVideo())
      expect((await videoRef().collection('transcriptParts').get()).empty).toBe(true)
      expect(await videos.get(VIDEO_ID)).toEqual(storedVideo())
    })
  })
})

// ------------------------------------------------------------- history store

describe('FirestoreHistoryStore', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    videoId: VIDEO_ID,
    lastOpenedAt: NOW,
    firstAnalyzedAt: NOW,
    title: 'Computer Networks',
    status: 'ready' as const,
    ...over,
  })

  const read = (uid: string) => db.doc(paths.historyEntry(uid, VIDEO_ID)).get()

  it('records a first open', async () => {
    await history.touch('alice', entry())

    const doc = await read('alice')
    expect(doc.get('videoId')).toBe(VIDEO_ID)
    expect(doc.get('openCount')).toBe(1)
    expect(doc.get('firstAnalyzedAt')).toBe(NOW)
  })

  it('counts opens', async () => {
    await history.touch('alice', entry())
    await history.touch('alice', entry({ lastOpenedAt: NOW + 5000 }))
    await history.touch('alice', entry({ lastOpenedAt: NOW + 9000 }))

    expect((await read('alice')).get('openCount')).toBe(3)
  })

  it('keeps the first analysis time across later opens', async () => {
    await history.touch('alice', entry())
    await history.touch('alice', entry({ lastOpenedAt: NOW + 60_000, firstAnalyzedAt: NOW + 60_000 }))

    const doc = await read('alice')
    expect(doc.get('firstAnalyzedAt')).toBe(NOW)
    expect(doc.get('lastOpenedAt')).toBe(NOW + 60_000)
  })

  it('keeps a title that a later open does not carry', async () => {
    await history.touch('alice', entry())
    await history.touch('alice', { videoId: VIDEO_ID, lastOpenedAt: NOW + 1000 })

    expect((await read('alice')).get('title')).toBe('Computer Networks')
  })

  it('records a degraded open like any other', async () => {
    await history.touch('alice', entry({ status: 'degraded' }))
    expect((await read('alice')).get('status')).toBe('degraded')
  })

  it('keeps users apart', async () => {
    await history.touch('alice', entry())
    await history.touch('alice', entry({ lastOpenedAt: NOW + 1 }))
    await history.touch('bob', entry())

    expect((await read('alice')).get('openCount')).toBe(2)
    expect((await read('bob')).get('openCount')).toBe(1)
  })
})

// --------------------------------------------------- orchestrator, end to end

describe('ingest against real stores', () => {
  function source(provenance: 'gemini_url' | 'creator_oauth' = 'gemini_url') {
    const fetch = vi.fn(async (input: VideoInput): Promise<FetchResult> => ({
      ok: true,
      transcript: buildTranscript({
        videoId: input.ref.videoId,
        provenance,
        language: 'en',
        durationMs: 7_200_000,
        cues: cues(12),
      }),
    }))
    return { id: provenance, canHandle: () => true, fetch } satisfies TranscriptSource & {
      fetch: typeof fetch
    }
  }

  const metadata: MetadataSource = {
    async fetch() {
      return { ok: true, metadata: META, availability: 'public' }
    },
  }

  function deps(transcripts: TranscriptSource[]): IngestDeps {
    return { videos, history, metadata, sources: transcripts, now: () => NOW }
  }

  it('stores on the first ingest and serves the second from the cache', async () => {
    const transcripts = source()

    const first = await ingestVideo({ uid: 'alice', ref }, deps([transcripts]))
    expect(first.status).toBe('ready')
    expect(first.fromCache).toBe(false)

    const second = await ingestVideo({ uid: 'alice', ref }, deps([transcripts]))
    expect(second.status).toBe('ready')
    expect(second.fromCache).toBe(true)
    expect(second.transcript?.cues).toHaveLength(12)

    // The whole point of the cache: the provider is paid once.
    expect(transcripts.fetch).toHaveBeenCalledTimes(1)
  })

  it('serves another user from the same shared video', async () => {
    const transcripts = source()
    await ingestVideo({ uid: 'alice', ref }, deps([transcripts]))

    const bob = await ingestVideo({ uid: 'bob', ref }, deps([transcripts]))
    expect(bob.fromCache).toBe(true)
    expect(transcripts.fetch).toHaveBeenCalledTimes(1)

    // Each of them still has their own history row.
    expect((await db.doc(paths.historyEntry('bob', VIDEO_ID)).get()).exists).toBe(true)
  })

  it('never writes a creator-authorised transcript to the shared collection', async () => {
    const transcripts = source('creator_oauth')

    const result = await ingestVideo({ uid: 'alice', ref }, deps([transcripts]))
    expect(result.status).toBe('ready')
    expect(result.transcript?.cues).toHaveLength(12)

    // Usable in this session, absent from shared knowledge.
    expect((await videoRef().get()).exists).toBe(false)
  })

  it('writes a history row even when the ingest degrades', async () => {
    const failing: TranscriptSource = {
      id: 'gemini_url',
      canHandle: () => true,
      async fetch() {
        return { ok: false, reason: 'no_transcript' }
      },
    }

    const result = await ingestVideo({ uid: 'alice', ref }, deps([failing]))
    expect(result.status).toBe('degraded')

    const row = await db.doc(paths.historyEntry('alice', VIDEO_ID)).get()
    expect(row.get('status')).toBe('degraded')
    expect((await videoRef().get()).exists).toBe(false)
  })
})
