import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type IngestDeps,
  type IngestProgress,
  ingestVideo,
  inFlightCount,
} from '@/ingest/orchestrator'
import type { HistoryStore, MetadataResult, MetadataSource, StoredVideo, VideoStore } from '@/ingest/ports'
import type { FetchResult, TranscriptSource, VideoInput } from '@/ingest/source'
import { buildTranscript } from '@/domain/transcript'
import { parseYouTubeUrl } from '@/ingest/url'
import { RETENTION_MS } from '@/data/schema'

const ref = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')!
const NOW = 1_760_000_000_000
const UID = 'alice'

const META = {
  title: 'Computer Networks',
  channelId: 'c1',
  channelTitle: 'Prof X',
  publishedAt: '2026-01-01',
  durationSec: 7200,
  thumbnailUrl: 'https://i.ytimg.com/x.jpg',
}

function memoryVideoStore() {
  const map = new Map<string, StoredVideo>()
  const store: VideoStore & { map: Map<string, StoredVideo>; puts: number } = {
    map,
    puts: 0,
    async get(id) {
      return map.get(id) ?? null
    },
    async put(id, doc) {
      store.puts += 1
      map.set(id, doc)
    },
  }
  return store
}

function memoryHistory() {
  const calls: Array<{ uid: string; videoId: string; status?: string }> = []
  const store: HistoryStore & { calls: typeof calls } = {
    calls,
    async touch(uid, entry) {
      calls.push({ uid, videoId: entry.videoId, ...(entry.status ? { status: entry.status } : {}) })
    },
  }
  return store
}

function metadataSource(result: MetadataResult = { ok: true, metadata: META, availability: 'public' }) {
  const fetch = vi.fn<MetadataSource['fetch']>(async () => result)
  return { fetch } satisfies MetadataSource & { fetch: typeof fetch }
}

function transcriptSource(
  id: TranscriptSource['id'] = 'gemini_url',
  cueCount = 3,
  provenance: 'gemini_url' | 'user_supplied' | 'creator_oauth' = 'gemini_url',
) {
  const fetch = vi.fn(async (input: VideoInput): Promise<FetchResult> => ({
    ok: true,
    transcript: buildTranscript({
      videoId: input.ref.videoId,
      provenance,
      language: 'en',
      durationMs: 7_200_000,
      cues: Array.from({ length: cueCount }, (_, i) => ({
        startMs: i * 4000,
        endMs: (i + 1) * 4000,
        text: `segment ${i}`,
      })),
    }),
  }))
  return { id, canHandle: () => true, fetch } satisfies TranscriptSource & { fetch: typeof fetch }
}

function deps(over: Partial<IngestDeps> = {}): IngestDeps & {
  videos: ReturnType<typeof memoryVideoStore>
  history: ReturnType<typeof memoryHistory>
  progress: IngestProgress[]
} {
  const progress: IngestProgress[] = []
  const videos = memoryVideoStore()
  const history = memoryHistory()
  return {
    videos,
    history,
    metadata: metadataSource(),
    sources: [transcriptSource()],
    now: () => NOW,
    onProgress: (p) => progress.push(p),
    progress,
    ...over,
  } as IngestDeps & {
    videos: ReturnType<typeof memoryVideoStore>
    history: ReturnType<typeof memoryHistory>
    progress: IngestProgress[]
  }
}

beforeEach(() => {
  expect(inFlightCount()).toBe(0)
})

describe('cold ingest', () => {
  it('fetches, stores and reports ready', async () => {
    const d = deps()
    const result = await ingestVideo({ uid: UID, ref }, d)

    expect(result.status).toBe('ready')
    expect(result.fromCache).toBe(false)
    expect(result.transcript?.cues).toHaveLength(3)
    expect(d.videos.map.get(ref.videoId)?.status).toBe('ready')
  })

  it('emits staged progress so the UI can reveal as it goes', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)
    expect(d.progress.map((p) => p.stage)).toEqual([
      'metadata',
      'transcript',
      'transcript',
      'storing',
      'ready',
    ])
  })

  it('records the user history entry', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)
    expect(d.history.calls).toEqual([{ uid: UID, videoId: ref.videoId, status: 'ready' }])
  })

  it('sets an expiry one retention window out', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)
    expect(d.videos.map.get(ref.videoId)?.expiresAt).toBe(NOW + RETENTION_MS)
  })

  it('stores the transcript as a compressed blob, not per-cue documents', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)
    const stored = d.videos.map.get(ref.videoId)!
    expect(stored.transcript?.codec).toBe('gzip+b64')
    expect(stored.transcript?.count).toBe(3)
    expect(d.videos.puts).toBe(1)
  })
})

// The largest lever on unit economics: a warm video must not call a provider.
describe('cache', () => {
  it('serves a stored video without touching metadata or transcript sources', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)

    const meta = metadataSource()
    const src = transcriptSource()
    const warm = { ...d, metadata: meta, sources: [src], progress: [] as IngestProgress[] }
    warm.onProgress = (p: IngestProgress) => warm.progress.push(p)

    const result = await ingestVideo({ uid: 'bob', ref }, warm)

    expect(result.fromCache).toBe(true)
    expect(result.status).toBe('ready')
    expect(result.transcript?.cues).toHaveLength(3)
    expect(meta.fetch).not.toHaveBeenCalled()
    expect(src.fetch).not.toHaveBeenCalled()
    expect(warm.progress.map((p) => p.stage)).toEqual(['cached', 'ready'])
  })

  it('still records history for the second user', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)
    await ingestVideo({ uid: 'bob', ref }, d)
    expect(d.history.calls.map((c) => c.uid)).toEqual([UID, 'bob'])
  })

  it('re-ingests once the retention window has passed', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)

    const src = transcriptSource()
    const expired = { ...d, sources: [src], now: () => NOW + RETENTION_MS + 1 }
    const result = await ingestVideo({ uid: UID, ref }, expired)

    expect(result.fromCache).toBe(false)
    expect(src.fetch).toHaveBeenCalledOnce()
  })

  it('bypasses the cache when forced', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)
    const src = transcriptSource()
    const result = await ingestVideo({ uid: UID, ref, force: true }, { ...d, sources: [src] })
    expect(result.fromCache).toBe(false)
    expect(src.fetch).toHaveBeenCalledOnce()
  })

  it('ignores a cached entry that has no usable transcript', async () => {
    const d = deps()
    d.videos.map.set(ref.videoId, {
      metadata: META,
      provenance: 'gemini_url',
      ingestedAt: NOW,
      refreshedAt: NOW,
      expiresAt: NOW + RETENTION_MS,
      schemaVersion: 1,
      status: 'ready',
    })
    const result = await ingestVideo({ uid: UID, ref }, d)
    expect(result.fromCache).toBe(false)
  })
})

// Two users pasting the same URL must not both pay for it.
describe('single-flight', () => {
  it('joins a concurrent ingest instead of duplicating the work', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))

    const src = transcriptSource()
    const slow: TranscriptSource = {
      id: 'gemini_url',
      canHandle: () => true,
      fetch: async (input) => {
        await gate
        return src.fetch(input)
      },
    }

    const d = deps({ sources: [slow] })
    const first = ingestVideo({ uid: UID, ref }, d)
    const second = ingestVideo({ uid: 'bob', ref }, d)

    release()
    const [a, b] = await Promise.all([first, second])

    expect(src.fetch).toHaveBeenCalledOnce()
    expect(a.status).toBe('ready')
    expect(b.status).toBe('ready')
    expect(d.videos.puts).toBe(1)
    expect(d.history.calls.map((c) => c.uid).sort()).toEqual([UID, 'bob'])
  })

  it('clears the in-flight entry once settled', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)
    expect(inFlightCount()).toBe(0)
  })

  it('clears the in-flight entry even when the ingest degrades', async () => {
    const d = deps({ metadata: metadataSource({ ok: false, reason: 'not_found' }) })
    await ingestVideo({ uid: UID, ref }, d)
    expect(inFlightCount()).toBe(0)
  })

  it('does not share an ingest that carries a user-supplied transcript', async () => {
    const d = deps()
    const supplied = ingestVideo(
      { uid: UID, ref, suppliedTranscript: '[0:01] a\n[0:05] b' },
      { ...d, sources: [transcriptSource('user_supplied', 2, 'user_supplied')] },
    )
    expect(inFlightCount()).toBe(0)
    await supplied
  })
})

describe('degraded paths', () => {
  it.each([
    ['not_found', 'video_unavailable'],
    ['unavailable', 'video_unavailable'],
    ['live', 'live_content'],
    ['upcoming', 'live_content'],
  ] as const)('maps metadata failure %s to %s', async (reason, expected) => {
    const d = deps({ metadata: metadataSource({ ok: false, reason }) })
    const result = await ingestVideo({ uid: UID, ref }, d)

    expect(result.status).toBe('degraded')
    expect(result.degraded?.reason).toBe(expected)
    expect(result.degraded?.message.length).toBeGreaterThan(20)
    expect(d.videos.puts).toBe(0)
  })

  it('does not call transcript sources when metadata fails', async () => {
    const src = transcriptSource()
    const d = deps({ metadata: metadataSource({ ok: false, reason: 'not_found' }), sources: [src] })
    await ingestVideo({ uid: UID, ref }, d)
    expect(src.fetch).not.toHaveBeenCalled()
  })

  it('keeps metadata available when only the transcript fails', async () => {
    const d = deps({
      sources: [{ id: 'gemini_url', canHandle: () => true, fetch: async () => ({ ok: false, reason: 'no_transcript' }) }],
    })
    const result = await ingestVideo({ uid: UID, ref }, d)

    expect(result.status).toBe('degraded')
    expect(result.degraded?.reason).toBe('no_transcript_available')
    // The metadata-and-comments view still works — that is the designed screen.
    expect(result.metadata?.title).toBe('Computer Networks')
    expect(d.videos.puts).toBe(0)
  })

  it('records a degraded history entry so the video appears in history', async () => {
    const d = deps({ metadata: metadataSource({ ok: false, reason: 'not_found' }) })
    await ingestVideo({ uid: UID, ref }, d)
    expect(d.history.calls[0]).toMatchObject({ videoId: ref.videoId, status: 'degraded' })
  })

  it('survives a metadata source that throws', async () => {
    const d = deps({
      metadata: {
        fetch: async () => {
          throw new Error('network down')
        },
      },
    })
    const result = await ingestVideo({ uid: UID, ref }, d)
    expect(result.status).toBe('degraded')
  })

  it('still returns the transcript when the store write fails', async () => {
    const d = deps()
    d.videos.put = async () => {
      throw new Error('firestore unavailable')
    }
    const result = await ingestVideo({ uid: UID, ref }, d)
    expect(result.status).toBe('ready')
    expect(result.transcript?.cues).toHaveLength(3)
  })
})

// D48: a creator-authorised transcript is licensed to that creator. It must never
// reach the shared collection other users read from.
describe('provenance', () => {
  it('never writes a creator_oauth transcript to the shared cache', async () => {
    const d = deps({ sources: [transcriptSource('creator_oauth', 3, 'creator_oauth')] })
    const result = await ingestVideo({ uid: UID, ref }, d)

    expect(result.status).toBe('ready')
    expect(result.transcript?.provenance).toBe('creator_oauth')
    expect(d.videos.puts).toBe(0)
    expect(d.videos.map.size).toBe(0)
  })

  it('does not serve a creator_oauth entry from cache if one somehow exists', async () => {
    const d = deps()
    d.videos.map.set(ref.videoId, {
      metadata: META,
      provenance: 'creator_oauth',
      transcript: { codec: 'gzip+b64', count: 1, bytes: 10, blob: '' },
      ingestedAt: NOW,
      refreshedAt: NOW,
      expiresAt: NOW + RETENTION_MS,
      schemaVersion: 1,
      status: 'ready',
    })
    const result = await ingestVideo({ uid: 'bob', ref }, d)
    expect(result.fromCache).toBe(false)
  })

  it('does write a user_supplied transcript for the supplying user', async () => {
    const d = deps({ sources: [transcriptSource('user_supplied', 3, 'user_supplied')] })
    const result = await ingestVideo({ uid: UID, ref, suppliedTranscript: 'x' }, d)
    expect(result.status).toBe('ready')
    expect(d.videos.puts).toBe(1)
  })
})
