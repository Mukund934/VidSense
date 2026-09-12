/**
 * The cap, at the edge where it actually protects something.
 *
 * The store and the arithmetic are tested elsewhere. What is only reachable
 * here is whether the routes *use* them — and in particular the settlement
 * rules, which are the part a refactor is most likely to quietly drop:
 *
 *   - a cache hit costs the user nothing, because it cost the provider nothing
 *   - a failed ingest costs the user nothing, for the same reason
 *   - a question that could not be answered is not charged for
 *
 * Get those wrong and the cap still "works" while punishing people for the
 * cheapest things the system does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildTranscript, type TimedTranscript } from '@/domain/transcript'
import { timingFor } from '@/domain/timing'

const metadata = {
  title: 'A Talk',
  channelId: 'c',
  channelTitle: 'Speaker',
  publishedAt: '2026-01-01',
  durationSec: 600,
}

function transcript(): TimedTranscript {
  return buildTranscript({
    videoId: 'vid12345678',
    provenance: 'gemini_url',
    language: 'en',
    durationMs: 8_000,
    cues: [
      { startMs: 0, endMs: 4_000, text: 'first' },
      { startMs: 4_000, endMs: 8_000, text: 'second' },
    ],
    timing: timingFor('caption_track'),
  })
}

const uid = vi.fn(async () => 'alice')
vi.mock('@/lib/server/session', () => ({
  currentUid: () => uid(),
  isSignedIn: async () => true,
}))

const ingestImpl = vi.fn()
vi.mock('@/ingest/orchestrator', () => ({ ingestVideo: (...a: unknown[]) => ingestImpl(...a) }))

const loadVideo = vi.fn()
vi.mock('@/lib/server/video', () => ({ loadVideo: (id: string) => loadVideo(id) }))

const askImpl = vi.fn()
vi.mock('@/answer/ask', () => ({ ask: (...a: unknown[]) => askImpl(...a) }))

class FakeModelUnavailable extends Error {}

vi.mock('@/lib/server/deps', () => ({
  // `null` puts the quota on its in-memory ledger, which is the same code path
  // a deployment without Firestore credentials runs on.
  firestore: () => null,
  capabilities: () => ({ gemini: true, youtube: true, firestore: false }),
  videoStore: () => ({ async get() { return null }, async put() {} }),
  historyStore: () => ({ async touch() {} }),
  metadataSource: () => ({ async fetch() { return { ok: false, reason: 'error' as const } } }),
  transcriptSources: () => [],
  completion: () => async () => '[]',
  ModelUnavailableError: FakeModelUnavailable,
  verificationEnabled: () => false,
  verifier: () => async () => ({ entailment: 'supported' as const }),
}))

vi.mock('@/lib/server/cache', () => ({ remember: () => undefined, recall: () => null }))

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function ingest(body: unknown): Promise<Response> {
  const { POST } = await import('@/app/api/ingest/route')
  return POST(post('http://localhost/api/ingest', body) as never)
}

async function ask(body: unknown): Promise<Response> {
  const { POST } = await import('@/app/api/ask/route')
  return POST(post('http://localhost/api/ask', body) as never)
}

/** Drain the NDJSON stream, so the route's settlement work has finished. */
async function drain(res: Response): Promise<void> {
  await res.text()
}

const WATCH = 'https://www.youtube.com/watch?v=vid12345678'

const original = { ...process.env }

beforeEach(async () => {
  vi.resetModules()
  const { resetQuota } = await import('@/lib/server/quota')
  resetQuota()

  uid.mockReset()
  uid.mockResolvedValue('alice')
  ingestImpl.mockReset()
  loadVideo.mockReset()
  askImpl.mockReset()

  // Small numbers so the boundary is reached in a few calls rather than fifty.
  process.env.INGESTS_PER_DAY = '2'
  process.env.ASKS_PER_DAY = '2'
  process.env.INGESTS_PER_MINUTE = '99'
  process.env.ASKS_PER_MINUTE = '99'
})

afterEach(() => {
  process.env = { ...original }
})

describe('POST /api/ingest', () => {
  const ready = (fromCache: boolean) => ({
    videoId: 'vid12345678',
    status: 'ready' as const,
    fromCache,
    metadata,
    transcript: transcript(),
    attempts: [],
  })

  /**
   * An orchestrator that behaves like the real one where the budget is
   * concerned: it announces the provider call before making it.
   *
   * That announcement is the whole settlement contract now, so a stub that
   * skipped it would leave these tests passing against a route that charges
   * nobody for anything. The `fromCache` path deliberately does not announce —
   * a cache hit never reaches a source.
   */
  const orchestrator =
    (result: ReturnType<typeof ready>, sourceId: 'gemini_url' | 'user_supplied' = 'gemini_url') =>
    async (_req: unknown, deps: { onProviderAttempt?: (a: unknown) => void }) => {
      if (!result.fromCache) {
        deps.onProviderAttempt?.({ sourceId, durationSec: result.metadata.durationSec })
      }
      return result
    }

  it('refuses once the daily budget is gone', async () => {
    ingestImpl.mockImplementation(orchestrator(ready(false)))

    await drain(await ingest({ url: WATCH }))
    await drain(await ingest({ url: WATCH }))
    const third = await ingest({ url: WATCH })

    expect(third.status).toBe(429)
    expect(ingestImpl).toHaveBeenCalledTimes(2)
  })

  it('says what ran out and when it comes back', async () => {
    ingestImpl.mockImplementation(orchestrator(ready(false)))
    await drain(await ingest({ url: WATCH }))
    await drain(await ingest({ url: WATCH }))

    const res = await ingest({ url: WATCH })
    const body = (await res.json()) as { error: string; detail: string; retryAfterSec: number }

    expect(body.error).toBe('rate_limited')
    expect(body.detail).toContain('2 videos')
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSec))
  })

  it('does not charge for a cache hit', async () => {
    // The shared cache is the cheapest thing the system does. Charging a user
    // for re-opening a video already in it would be charging them for nothing.
    ingestImpl.mockImplementation(orchestrator(ready(true)))

    for (let i = 0; i < 5; i += 1) await drain(await ingest({ url: WATCH }))

    expect(ingestImpl).toHaveBeenCalledTimes(5)
  })

  it('does not charge for an ingest that threw', async () => {
    ingestImpl.mockRejectedValue(new Error('provider exploded'))

    await drain(await ingest({ url: WATCH }))
    await drain(await ingest({ url: WATCH }))
    await drain(await ingest({ url: WATCH }))

    // A run of failures must not quietly eat the day's budget.
    expect(ingestImpl).toHaveBeenCalledTimes(3)
  })

  it('charges for a real ingest, and records the seconds it cost', async () => {
    ingestImpl.mockImplementation(orchestrator(ready(false)))
    await drain(await ingest({ url: WATCH }))

    const { usageToday } = await import('@/lib/server/quota')
    const usage = await usageToday('alice')

    expect(usage.ingest).toBe(1)
    expect(usage.videoSeconds).toBe(metadata.durationSec)
  })

  it('counts a pasted transcript as an ingest but charges it no video hours', async () => {
    // It is still a video analysed, so the count stands. Nothing was sent to
    // the provider, so the hours must not be — the seconds budget exists to
    // track what Google watched, and Google watched nothing here.
    ingestImpl.mockImplementation(orchestrator(ready(false), 'user_supplied'))
    await drain(await ingest({ url: WATCH, transcript: 'some pasted text' }))

    const { usageToday } = await import('@/lib/server/quota')
    const usage = await usageToday('alice')

    expect(usage.ingest).toBe(1)
    expect(usage.videoSeconds).toBe(0)
  })

  it('charges nothing when no source was ever reached', async () => {
    // A deleted video, or one too long to send: refused after metadata and
    // before any request leaves. The real orchestrator announces no attempt, so
    // the whole claim goes back — count and reserved seconds alike.
    ingestImpl.mockImplementation(async () => ({
      videoId: 'vid12345678',
      status: 'degraded' as const,
      fromCache: false,
      metadata,
      degraded: { reason: 'too_long' as const, message: 'too long' },
      attempts: [],
    }))

    for (let i = 0; i < 4; i += 1) await drain(await ingest({ url: WATCH }))

    // Four attempts against a budget of two, and none of them charged.
    expect(ingestImpl).toHaveBeenCalledTimes(4)
    const { usageToday } = await import('@/lib/server/quota')
    expect((await usageToday('alice')).ingest).toBe(0)
  })

  it('keeps one user out of the budget belonging to another', async () => {
    ingestImpl.mockImplementation(orchestrator(ready(false)))

    uid.mockResolvedValue('alice')
    await drain(await ingest({ url: WATCH }))
    await drain(await ingest({ url: WATCH }))
    expect((await ingest({ url: WATCH })).status).toBe(429)

    uid.mockResolvedValue('bob')
    expect((await ingest({ url: WATCH })).status).toBe(200)
  })

  it('refuses a burst before the daily budget is anywhere near spent', async () => {
    process.env.INGESTS_PER_DAY = '100'
    process.env.INGESTS_PER_MINUTE = '1'
    ingestImpl.mockImplementation(orchestrator(ready(false)))

    await drain(await ingest({ url: WATCH }))
    const second = await ingest({ url: WATCH })
    const body = (await second.json()) as { detail: string }

    expect(second.status).toBe(429)
    // A burst refusal comes back in seconds, not tomorrow.
    expect(body.detail).toContain('seconds')
  })

  it('refuses before anything is fetched', async () => {
    process.env.INGESTS_PER_MINUTE = '0'
    ingestImpl.mockImplementation(orchestrator(ready(false)))

    expect((await ingest({ url: WATCH })).status).toBe(429)
    // "Before" is the load-bearing word: a check that runs after the provider
    // has been called has already spent the thing it was protecting.
    expect(ingestImpl).not.toHaveBeenCalled()
  })

  it('does not spend anything on a link it cannot parse', async () => {
    expect((await ingest({ url: 'https://example.com/nope' })).status).toBe(400)

    const { usageToday } = await import('@/lib/server/quota')
    expect((await usageToday('alice')).ingest).toBe(0)
  })
})

describe('POST /api/ask', () => {
  beforeEach(() => {
    loadVideo.mockResolvedValue({ metadata, transcript: transcript() })
    // A whole `Answer`, not a fragment: the route reads its status and both
    // of its lists on the way out, so a partial fake fails for the wrong reason.
    askImpl.mockResolvedValue({ status: 'answered', claims: [], rejected: [] })
  })

  it('refuses once the daily budget is gone', async () => {
    const body = { videoId: 'vid12345678', question: 'why?' }

    expect((await ask(body)).status).toBe(200)
    expect((await ask(body)).status).toBe(200)
    expect((await ask(body)).status).toBe(429)
    expect(askImpl).toHaveBeenCalledTimes(2)
  })

  it('does not charge for a question it could not answer', async () => {
    askImpl.mockRejectedValue(new FakeModelUnavailable('no key'))
    const body = { videoId: 'vid12345678', question: 'why?' }

    expect((await ask(body)).status).toBe(503)
    expect((await ask(body)).status).toBe(503)
    expect((await ask(body)).status).toBe(503)

    // Being unable to answer is not something to charge for.
    expect(askImpl).toHaveBeenCalledTimes(3)
  })

  it('does not charge for a video with no transcript', async () => {
    loadVideo.mockResolvedValue({ metadata, transcript: null })

    expect((await ask({ videoId: 'vid12345678', question: 'why?' })).status).toBe(409)

    const { usageToday } = await import('@/lib/server/quota')
    expect((await usageToday('alice')).ask).toBe(0)
  })

  it('does not charge for a malformed request', async () => {
    expect((await ask({ videoId: 'vid12345678' })).status).toBe(400)

    const { usageToday } = await import('@/lib/server/quota')
    expect((await usageToday('alice')).ask).toBe(0)
  })

  it('counts questions separately from videos', async () => {
    // Spending every question must not cost a video, or a long session would
    // lock someone out of the thing they came for.
    for (let i = 0; i < 2; i += 1) await ask({ videoId: 'vid12345678', question: 'why?' })

    const { usageToday } = await import('@/lib/server/quota')
    const usage = await usageToday('alice')
    expect(usage.ask).toBe(2)
    expect(usage.ingest).toBe(0)
  })
})
