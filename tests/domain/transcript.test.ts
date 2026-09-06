import { describe, expect, it } from 'vitest'
import {
  CueRangeError,
  buildTranscript,
  formatTimestamp,
  resolveReceipt,
  youtubeMomentUrl,
} from '@/domain/transcript'

const t = buildTranscript({
  videoId: 'abc123',
  provenance: 'gemini_url',
  language: 'en',
  durationMs: 60_000,
  cues: [
    { startMs: 0, endMs: 4_000, text: 'Welcome  back   everyone.' },
    { startMs: 4_000, endMs: 9_500, text: 'Today we cover TCP.' },
    { startMs: 9_500, endMs: 15_000, text: 'It uses a three-way handshake.' },
  ],
})

describe('buildTranscript', () => {
  it('assigns contiguous indices and normalises whitespace', () => {
    expect(t.cues.map((c) => c.i)).toEqual([0, 1, 2])
    expect(t.cues[0]!.text).toBe('Welcome back everyone.')
  })

  it('orders cues by start time regardless of input order', () => {
    const out = buildTranscript({
      videoId: 'v',
      provenance: 'user_supplied',
      language: 'en',
      durationMs: 10_000,
      cues: [
        { startMs: 5_000, endMs: 6_000, text: 'second' },
        { startMs: 0, endMs: 1_000, text: 'first' },
      ],
    })
    expect(out.cues.map((c) => c.text)).toEqual(['first', 'second'])
    expect(out.cues.map((c) => c.i)).toEqual([0, 1])
  })

  it('omits speaker rather than setting it undefined', () => {
    expect('speaker' in t.cues[0]!).toBe(false)
  })
})

describe('resolveReceipt', () => {
  it('resolves a single cue to its own time range', () => {
    const r = resolveReceipt(t, 1, 1)
    expect(r).toMatchObject({ startMs: 4_000, endMs: 9_500, quote: 'Today we cover TCP.' })
  })

  it('spans multiple cues and joins their text', () => {
    const r = resolveReceipt(t, 1, 2)
    expect(r.startMs).toBe(4_000)
    expect(r.endMs).toBe(15_000)
    expect(r.quote).toBe('Today we cover TCP. It uses a three-way handshake.')
  })

  // The invariant: an invented index must fail loudly, never resolve to a
  // plausible-but-wrong moment.
  it('throws on an index past the end', () => {
    expect(() => resolveReceipt(t, 0, 99)).toThrow(CueRangeError)
  })

  it('throws on a negative index', () => {
    expect(() => resolveReceipt(t, -1, 1)).toThrow(CueRangeError)
  })

  it('throws on an inverted range', () => {
    expect(() => resolveReceipt(t, 2, 1)).toThrow(CueRangeError)
  })

  it('throws on non-integer indices', () => {
    expect(() => resolveReceipt(t, 0.5, 1)).toThrow(CueRangeError)
  })
})

describe('formatTimestamp', () => {
  it.each([
    [0, '0:00'],
    [9_000, '0:09'],
    [872_000, '14:32'],
    [3_847_000, '1:04:07'],
    [-5_000, '0:00'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatTimestamp(ms)).toBe(expected)
  })
})

describe('youtubeMomentUrl', () => {
  it('builds a second-accurate deep link', () => {
    expect(youtubeMomentUrl('abc123', 872_400)).toBe(
      'https://www.youtube.com/watch?v=abc123&t=872s',
    )
  })

  it('encodes the video id', () => {
    expect(youtubeMomentUrl('a/b', 0)).toContain('v=a%2Fb')
  })
})
