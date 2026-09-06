import { describe, expect, it, vi } from 'vitest'
import {
  GeminiUrlSource,
  type HttpFn,
  classifyStatus,
  normaliseCues,
} from '@/ingest/sources/gemini-url'
import type { VideoInput } from '@/ingest/source'
import { parseYouTubeUrl } from '@/ingest/url'

const ref = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')!
const input = (over: Partial<VideoInput> = {}): VideoInput => ({ ref, ...over })

/** Wrap model output in the envelope the API actually returns. */
function envelope(modelText: string): string {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text: modelText }] } }] })
}

function http(status: number, text: string): HttpFn {
  return async () => ({ status, ok: status >= 200 && status < 300, text })
}

const GOOD = envelope(
  JSON.stringify([
    { t: 0, text: 'Welcome back everyone.' },
    { t: 4, text: 'Today we cover TCP.' },
    { t: 9, text: 'It uses a three-way handshake.' },
  ]),
)

describe('GeminiUrlSource — canHandle', () => {
  it('declines without an API key rather than failing a call', () => {
    expect(new GeminiUrlSource({ apiKey: undefined }).canHandle(input())).toBe(false)
  })

  it('accepts a public video when configured', () => {
    expect(new GeminiUrlSource({ apiKey: 'k' }).canHandle(input({ availability: 'public' }))).toBe(true)
  })

  // Documented constraint: the URL path takes public videos only.
  it.each(['private', 'members_only', 'unlisted', 'region_blocked'] as const)(
    'declines a %s video',
    (availability) => {
      expect(new GeminiUrlSource({ apiKey: 'k' }).canHandle(input({ availability }))).toBe(false)
    },
  )
})

describe('GeminiUrlSource — success', () => {
  it('parses cues into a transcript with gemini_url provenance', async () => {
    const source = new GeminiUrlSource({ apiKey: 'k', http: http(200, GOOD) })
    const result = await source.fetch(input({ durationSec: 15, language: 'en' }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.transcript.provenance).toBe('gemini_url')
      expect(result.transcript.cues).toHaveLength(3)
      expect(result.transcript.cues[0]).toMatchObject({ i: 0, startMs: 0, text: 'Welcome back everyone.' })
      expect(result.transcript.cues[1]!.startMs).toBe(4_000)
    }
  })

  it('sends the canonical url, not whatever the user pasted', async () => {
    const spy = vi.fn<HttpFn>(async () => ({ status: 200, ok: true, text: GOOD }))
    const messy = parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?si=junk&t=90')!
    await new GeminiUrlSource({ apiKey: 'k', http: spy }).fetch({ ref: messy })

    const body = String(spy.mock.calls[0]?.[1].body)
    expect(body).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(body).not.toContain('si=junk')
  })

  it('never puts the api key in the request body', async () => {
    const spy = vi.fn<HttpFn>(async () => ({ status: 200, ok: true, text: GOOD }))
    await new GeminiUrlSource({ apiKey: 'SECRET', http: spy }).fetch(input())
    expect(String(spy.mock.calls[0]?.[1].body)).not.toContain('SECRET')
  })
})

// The chain's behaviour depends on this classification: "about us" advances to the
// next source, "about the video" stops the chain.
describe('classifyStatus', () => {
  it.each([
    [401, 'API key not valid', 'not_configured'],
    [403, 'permission denied', 'not_configured'],
    [429, 'quota exceeded', 'rate_limited'],
    [500, 'internal', 'upstream_error'],
    [503, 'unavailable', 'upstream_error'],
    [400, 'video is unavailable', 'video_unavailable'],
    [400, 'the video is private', 'video_unavailable'],
    [400, 'input token count exceeds the maximum', 'too_long'],
    [400, 'request payload too large', 'too_long'],
    [400, 'malformed request', 'upstream_error'],
  ] as const)('maps HTTP %i "%s" to %s', (status, body, expected) => {
    expect(classifyStatus(status, body).reason).toBe(expected)
  })
})

describe('GeminiUrlSource — failure handling', () => {
  it.each([
    ['a rejected key', 401, 'API key not valid', 'not_configured'],
    ['rate limiting', 429, 'quota', 'rate_limited'],
    ['a server error', 503, 'unavailable', 'upstream_error'],
  ] as const)('reports %s correctly', async (_label, status, body, expected) => {
    const result = await new GeminiUrlSource({ apiKey: 'k', http: http(status, body) }).fetch(input())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe(expected)
  })

  it('does not throw when the transport fails', async () => {
    const source = new GeminiUrlSource({
      apiKey: 'k',
      http: async () => {
        throw new Error('ECONNRESET')
      },
    })
    const result = await source.fetch(input())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('upstream_error')
      expect(result.detail).toContain('ECONNRESET')
    }
  })

  it.each([
    ['non-JSON envelope', 'not json at all', 'upstream_error'],
    ['model prose instead of an array', envelope('Sure! Here is the transcript:'), 'no_transcript'],
    ['an empty array', envelope('[]'), 'no_transcript'],
    ['an array of unusable entries', envelope('[{"t":"x","text":""}]'), 'no_transcript'],
  ] as const)('handles %s', async (_label, body, expected) => {
    const result = await new GeminiUrlSource({ apiKey: 'k', http: http(200, body) }).fetch(input())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe(expected)
  })

  it('reports a missing key without calling out', async () => {
    const spy = vi.fn<HttpFn>()
    const result = await new GeminiUrlSource({ apiKey: undefined, http: spy }).fetch(input())
    expect(spy).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })
})

describe('normaliseCues', () => {
  it('orders cues the model returned out of sequence', () => {
    const cues = normaliseCues([{ t: 9, text: 'third' }, { t: 0, text: 'first' }], 15_000)
    expect(cues.map((c) => c.text)).toEqual(['first', 'third'])
  })

  it('derives each end time from the following start', () => {
    const cues = normaliseCues([{ t: 0, text: 'a' }, { t: 4, text: 'b' }], 10_000)
    expect(cues[0]).toEqual({ startMs: 0, endMs: 4_000, text: 'a' })
  })

  it('ends the final cue at the known duration', () => {
    const cues = normaliseCues([{ t: 0, text: 'a' }], 12_000)
    expect(cues[0]!.endMs).toBe(12_000)
  })

  it('falls back to a nominal tail when duration is unknown', () => {
    const cues = normaliseCues([{ t: 10, text: 'a' }], 0)
    expect(cues[0]!.endMs).toBeGreaterThan(cues[0]!.startMs)
  })

  it.each([
    ['negative times', [{ t: -5, text: 'x' }]],
    ['non-numeric times', [{ t: 'abc', text: 'x' }]],
    ['empty text', [{ t: 1, text: '   ' }]],
    ['missing text', [{ t: 1 }]],
    ['not an array', { t: 1, text: 'x' }],
  ])('discards %s', (_label, raw) => {
    expect(normaliseCues(raw, 10_000)).toEqual([])
  })

  it('never produces an end before its start', () => {
    const cues = normaliseCues([{ t: 10, text: 'a' }, { t: 10, text: 'b' }], 20_000)
    for (const c of cues) expect(c.endMs).toBeGreaterThanOrEqual(c.startMs)
  })
})
