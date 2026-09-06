import { describe, expect, it, vi } from 'vitest'
import { MAX_DURATION_SEC, acquireTranscript } from '@/ingest/chain'
import { DEGRADED_MESSAGE, type FetchResult, type TranscriptSource, type VideoInput } from '@/ingest/source'
import { UserSuppliedSource } from '@/ingest/sources/user-supplied'
import { buildTranscript } from '@/domain/transcript'
import { parseYouTubeUrl } from '@/ingest/url'

const ref = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')!
const input = (over: Partial<VideoInput> = {}): VideoInput => ({ ref, ...over })

function fakeSource(
  id: TranscriptSource['id'],
  behaviour: () => Promise<FetchResult> | FetchResult,
  handles = true,
): TranscriptSource {
  return {
    id,
    canHandle: () => handles,
    fetch: async () => behaviour(),
  }
}

const okResult = (cueCount = 2): FetchResult => ({
  ok: true,
  transcript: buildTranscript({
    videoId: ref.videoId,
    provenance: 'gemini_url',
    language: 'en',
    durationMs: 10_000,
    cues: Array.from({ length: cueCount }, (_, i) => ({
      startMs: i * 1000,
      endMs: (i + 1) * 1000,
      text: `cue ${i}`,
    })),
  }),
})

describe('acquireTranscript — success paths', () => {
  it('returns the first source that succeeds', async () => {
    const out = await acquireTranscript(
      [fakeSource('gemini_url', () => okResult()), fakeSource('user_supplied', () => okResult())],
      input(),
    )
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') expect(out.source).toBe('gemini_url')
  })

  it('falls through to a later source and records the earlier failure', async () => {
    const out = await acquireTranscript(
      [
        fakeSource('gemini_url', () => ({ ok: false, reason: 'not_configured' })),
        fakeSource('user_supplied', () => okResult()),
      ],
      input(),
    )
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') {
      expect(out.source).toBe('user_supplied')
      expect(out.attempts).toEqual([{ source: 'gemini_url', reason: 'not_configured' }])
    }
  })

  it('skips sources that cannot handle the input without calling them', async () => {
    const fetch = vi.fn()
    const out = await acquireTranscript(
      [
        { id: 'gemini_url', canHandle: () => false, fetch },
        fakeSource('user_supplied', () => okResult()),
      ],
      input(),
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(out.kind).toBe('ok')
  })

  it('reports progress for each attempted source', async () => {
    const onAttempt = vi.fn()
    await acquireTranscript(
      [
        fakeSource('gemini_url', () => ({ ok: false, reason: 'rate_limited' })),
        fakeSource('user_supplied', () => okResult()),
      ],
      input(),
      { onAttempt },
    )
    expect(onAttempt.mock.calls.flat()).toEqual(['gemini_url', 'user_supplied'])
  })
})

// Trying a second provider on a removed video wastes quota and produces a worse
// error than the accurate one. Terminal failures must stop the chain.
describe('acquireTranscript — terminal failures short-circuit', () => {
  it.each([
    ['private', 'video_unavailable'],
    ['removed', 'video_unavailable'],
    ['members_only', 'video_unavailable'],
    ['region_blocked', 'video_unavailable'],
    ['age_restricted', 'video_unavailable'],
    ['live_now', 'live_content'],
    ['upcoming', 'live_content'],
  ] as const)('refuses %s before calling any source', async (availability, expected) => {
    const fetch = vi.fn()
    const out = await acquireTranscript(
      [{ id: 'gemini_url', canHandle: () => true, fetch }],
      input({ availability }),
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(out.kind).toBe('degraded')
    if (out.kind === 'degraded') expect(out.reason).toBe(expected)
  })

  it('refuses an over-long video before spending anything', async () => {
    const fetch = vi.fn()
    const out = await acquireTranscript(
      [{ id: 'gemini_url', canHandle: () => true, fetch }],
      input({ durationSec: MAX_DURATION_SEC + 1 }),
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(out.kind === 'degraded' && out.reason).toBe('too_long')
  })

  it('stops the chain when a source reports a terminal reason', async () => {
    const second = vi.fn()
    const out = await acquireTranscript(
      [
        fakeSource('gemini_url', () => ({ ok: false, reason: 'video_unavailable' })),
        { id: 'user_supplied', canHandle: () => true, fetch: second },
      ],
      input(),
    )
    expect(second).not.toHaveBeenCalled()
    expect(out.kind === 'degraded' && out.reason).toBe('video_unavailable')
  })
})

describe('acquireTranscript — failure handling', () => {
  it('survives a source that throws and continues to the next', async () => {
    const out = await acquireTranscript(
      [
        fakeSource('gemini_url', () => {
          throw new Error('socket hang up')
        }),
        fakeSource('user_supplied', () => okResult()),
      ],
      input(),
    )
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') {
      expect(out.attempts[0]).toMatchObject({ source: 'gemini_url', reason: 'upstream_error' })
      expect(out.attempts[0]?.detail).toContain('socket hang up')
    }
  })

  it('treats an empty transcript as no transcript, not as success', async () => {
    const out = await acquireTranscript([fakeSource('gemini_url', () => okResult(0))], input())
    expect(out.kind).toBe('degraded')
    if (out.kind === 'degraded') expect(out.reason).toBe('no_transcript_available')
  })

  it('distinguishes "nothing available" from "everything broke"', async () => {
    const empty = await acquireTranscript(
      [
        fakeSource('gemini_url', () => ({ ok: false, reason: 'no_transcript' })),
        fakeSource('user_supplied', () => ({ ok: false, reason: 'no_transcript' })),
      ],
      input(),
    )
    expect(empty.kind === 'degraded' && empty.reason).toBe('no_transcript_available')

    const broken = await acquireTranscript(
      [
        fakeSource('gemini_url', () => ({ ok: false, reason: 'upstream_error' })),
        fakeSource('user_supplied', () => ({ ok: false, reason: 'rate_limited' })),
      ],
      input(),
    )
    expect(broken.kind === 'degraded' && broken.reason).toBe('all_sources_failed')
  })

  it('degrades rather than throwing when there are no sources at all', async () => {
    const out = await acquireTranscript([], input())
    expect(out.kind).toBe('degraded')
  })

  it('always carries user-facing copy on a degraded outcome', async () => {
    const out = await acquireTranscript([], input())
    if (out.kind === 'degraded') {
      expect(out.message).toBe(DEGRADED_MESSAGE[out.reason])
      expect(out.message.length).toBeGreaterThan(20)
    }
  })
})

// The floor beneath the chain: if every provider route closes, a user who has the
// text can still use the product.
describe('the chain with the real UserSuppliedSource', () => {
  const sources = [
    fakeSource('gemini_url', () => ({ ok: false, reason: 'not_configured' })),
    new UserSuppliedSource(),
  ]

  it('recovers from a dead provider using a pasted transcript', async () => {
    const out = await acquireTranscript(
      sources,
      input({ suppliedTranscript: '[0:01] first line\n[0:05] second line\n[0:09] third line' }),
    )
    expect(out.kind).toBe('ok')
    if (out.kind === 'ok') {
      expect(out.source).toBe('user_supplied')
      expect(out.transcript.provenance).toBe('user_supplied')
      expect(out.transcript.cues).toHaveLength(3)
    }
  })

  it('degrades honestly when the paste is not a transcript', async () => {
    const out = await acquireTranscript(
      sources,
      input({ suppliedTranscript: 'just some notes I typed' }),
    )
    expect(out.kind).toBe('degraded')
    if (out.kind === 'degraded') expect(out.reason).toBe('no_transcript_available')
  })

  it('is skipped entirely when nothing was supplied', async () => {
    const out = await acquireTranscript(sources, input())
    expect(out.kind).toBe('degraded')
    if (out.kind === 'degraded') {
      expect(out.attempts).toContainEqual({ source: 'user_supplied', reason: 'unsupported_input' })
    }
  })
})
