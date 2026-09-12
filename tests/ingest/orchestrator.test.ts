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

describe('storage outages never cost the user their transcript', () => {
  const exploding: HistoryStore = {
    async touch() {
      throw new Error('firestore unavailable')
    },
  }

  it('still returns a fresh ingest when history cannot be written', async () => {
    const result = await ingestVideo({ uid: UID, ref }, deps({ history: exploding }))
    expect(result.status).toBe('ready')
    expect(result.transcript?.cues.length).toBeGreaterThan(0)
  })

  it('still serves a cache hit when history cannot be written', async () => {
    const d = deps()
    await ingestVideo({ uid: UID, ref }, d)
    const second = await ingestVideo({ uid: UID, ref }, { ...d, history: exploding })
    expect(second.fromCache).toBe(true)
  })

  it('still reports a degraded outcome when history cannot be written', async () => {
    const failing: TranscriptSource = {
      id: 'gemini_url',
      canHandle: () => true,
      async fetch() {
        return { ok: false, reason: 'no_transcript' }
      },
    }
    const result = await ingestVideo(
      { uid: UID, ref },
      deps({ history: exploding, sources: [failing] }),
    )
    expect(result.status).toBe('degraded')
  })
})

describe('onProviderAttempt', () => {
  /**
   * The signal a budget settles on.
   *
   * The ingest route reserves the worst case a video could be, because its
   * length is unknown until metadata arrives. This callback is what lets it
   * swap that reservation for the real duration at the earliest honest moment —
   * so the rule it has to keep is narrow and absolute: it fires when, and only
   * when, a request is about to leave the machine.
   */
  const attempts = () => {
    const seen: Array<{ sourceId: string; durationSec: number }> = []
    return { seen, onProviderAttempt: (a: { sourceId: string; durationSec: number }) => seen.push(a) }
  }

  it('fires with the real duration once a source is about to be called', async () => {
    const { seen, onProviderAttempt } = attempts()
    await ingestVideo({ uid: UID, ref }, deps({ onProviderAttempt }))

    expect(seen).toEqual([{ sourceId: 'gemini_url', durationSec: META.durationSec }])
  })

  it('fires before the source has answered, not after', async () => {
    // The entire point is to release the reservation while the provider is
    // still working. Firing on completion would buy nothing.
    const { seen, onProviderAttempt } = attempts()
    const slow = transcriptSource()
    let duringFetch: number | null = null
    slow.fetch.mockImplementation(async (input: VideoInput) => {
      duringFetch = seen.length
      return {
        ok: true,
        transcript: buildTranscript({
          videoId: input.ref.videoId,
          provenance: 'gemini_url',
          language: 'en',
          durationMs: 7_200_000,
          cues: [{ startMs: 0, endMs: 4000, text: 'a' }],
        }),
      }
    })

    await ingestVideo({ uid: UID, ref }, deps({ sources: [slow], onProviderAttempt }))
    expect(duringFetch).toBe(1)
  })

  it('stays silent on a cache hit, which reaches no source at all', async () => {
    const { seen, onProviderAttempt } = attempts()
    const d = deps({ onProviderAttempt })
    await ingestVideo({ uid: UID, ref }, d)
    seen.length = 0

    await ingestVideo({ uid: UID, ref }, deps({ videos: d.videos, onProviderAttempt }))
    expect(seen).toEqual([])
  })

  it('stays silent when the video is too long to send', async () => {
    // Refused after metadata but before any source. Charging for this would
    // bill the deployment two and a half hours for a call never made.
    const { seen, onProviderAttempt } = attempts()
    const long = metadataSource({
      ok: true,
      metadata: { ...META, durationSec: 60 * 60 * 24 },
      availability: 'public',
    })

    const result = await ingestVideo({ uid: UID, ref }, deps({ metadata: long, onProviderAttempt }))
    expect(result.status).toBe('degraded')
    expect(seen).toEqual([])
  })

  it('stays silent when metadata itself failed', async () => {
    const { seen, onProviderAttempt } = attempts()
    const broken = metadataSource({ ok: false, reason: 'not_found' })

    await ingestVideo({ uid: UID, ref }, deps({ metadata: broken, onProviderAttempt }))
    expect(seen).toEqual([])
  })

  it('stays silent for a source that declined the input', async () => {
    // `canHandle` false is how a missing API key presents. Nothing was sent, so
    // nothing may be charged.
    const { seen, onProviderAttempt } = attempts()
    const declining = { ...transcriptSource(), canHandle: () => false }

    await ingestVideo({ uid: UID, ref }, deps({ sources: [declining], onProviderAttempt }))
    expect(seen).toEqual([])
  })

  it('names the source, so a local parse is not billed as provider video', async () => {
    const { seen, onProviderAttempt } = attempts()
    const pasted = transcriptSource('user_supplied', 3, 'user_supplied')

    await ingestVideo(
      { uid: UID, ref, suppliedTranscript: 'x' },
      deps({ sources: [pasted], onProviderAttempt }),
    )
    expect(seen.map((a) => a.sourceId)).toEqual(['user_supplied'])
  })

  it('fires for each source actually tried, so the first can be charged', async () => {
    const { seen, onProviderAttempt } = attempts()
    const failing = transcriptSource()
    failing.fetch.mockResolvedValue({ ok: false, reason: 'no_transcript' })
    const pasted = transcriptSource('user_supplied', 3, 'user_supplied')

    await ingestVideo(
      { uid: UID, ref, suppliedTranscript: 'x' },
      deps({ sources: [failing, pasted], onProviderAttempt }),
    )
    // Gemini was called and failed; the paste then answered. The route charges
    // the first, because that is the one that spent something.
    expect(seen.map((a) => a.sourceId)).toEqual(['gemini_url', 'user_supplied'])
  })
})
