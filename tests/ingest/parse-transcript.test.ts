import { describe, expect, it } from 'vitest'
import { detectFormat, parseTranscriptText } from '@/ingest/parse-transcript'

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Welcome back everyone.

00:00:04.000 --> 00:00:09.500
Today we cover <b>TCP</b>.

00:00:09.500 --> 00:00:15.000
It uses a three-way handshake.
`

const SRT = `1
00:00:01,000 --> 00:00:04,000
Welcome back everyone.

2
00:00:04,000 --> 00:00:09,500
Today we cover TCP.

3
00:00:09,500 --> 00:00:15,000
It uses a three-way handshake.
`

const PLAIN = `[00:01] Welcome back everyone.
[00:04] Today we cover TCP.
[00:09] It uses a three-way handshake.
`

describe('detectFormat', () => {
  it.each([
    ['vtt', VTT],
    ['srt', SRT],
    ['timestamped_text', PLAIN],
  ])('detects %s', (expected, input) => {
    expect(detectFormat(input)).toBe(expected)
  })

  it('returns unknown for prose with no timings', () => {
    expect(detectFormat('Just some notes I wrote down about networking.')).toBe('unknown')
  })
})

describe('parseTranscriptText — WebVTT', () => {
  it('extracts cues with timings and text', () => {
    const { format, cues } = parseTranscriptText(VTT)
    expect(format).toBe('vtt')
    expect(cues).toHaveLength(3)
    expect(cues[0]).toEqual({ startMs: 1_000, endMs: 4_000, text: 'Welcome back everyone.' })
  })

  it('strips inline markup', () => {
    expect(parseTranscriptText(VTT).cues[1]!.text).toBe('Today we cover TCP.')
  })

  it('ignores cue settings after the end time', () => {
    const withSettings = `WEBVTT

00:00:01.000 --> 00:00:04.000 align:start position:10%
Hello there.
`
    expect(parseTranscriptText(withSettings).cues[0]).toEqual({
      startMs: 1_000,
      endMs: 4_000,
      text: 'Hello there.',
    })
  })

  it('joins multi-line cue text', () => {
    const multi = `WEBVTT

00:00:01.000 --> 00:00:04.000
first line
second line
`
    expect(parseTranscriptText(multi).cues[0]!.text).toBe('first line second line')
  })

  it('handles a cue identifier line before the timing', () => {
    const withId = `WEBVTT

intro
00:00:01.000 --> 00:00:04.000
Hello.
`
    expect(parseTranscriptText(withId).cues).toHaveLength(1)
  })
})

describe('parseTranscriptText — SRT', () => {
  it('parses comma-separated milliseconds and drops sequence numbers', () => {
    const { format, cues } = parseTranscriptText(SRT)
    expect(format).toBe('srt')
    expect(cues).toHaveLength(3)
    expect(cues[2]).toEqual({
      startMs: 9_500,
      endMs: 15_000,
      text: 'It uses a three-way handshake.',
    })
  })

  it('tolerates CRLF line endings', () => {
    const { cues } = parseTranscriptText(SRT.replace(/\n/g, '\r\n'))
    expect(cues).toHaveLength(3)
  })
})

describe('parseTranscriptText — timestamped plain text', () => {
  it('derives each end time from the next start', () => {
    const { cues } = parseTranscriptText(PLAIN)
    expect(cues).toHaveLength(3)
    expect(cues[0]).toEqual({ startMs: 1_000, endMs: 4_000, text: 'Welcome back everyone.' })
  })

  it('gives the final cue a nominal duration', () => {
    const { cues } = parseTranscriptText(PLAIN)
    const last = cues[2]!
    expect(last.endMs).toBeGreaterThan(last.startMs)
  })

  it.each([
    ['bracketed', '[1:05] one\n[1:10] two'],
    ['parenthesised', '(1:05) one\n(1:10) two'],
    ['bare', '1:05 one\n1:10 two'],
    ['dashed', '1:05 - one\n1:10 - two'],
    ['with hours', '1:01:05 one\n1:01:10 two'],
  ])('accepts %s timestamps', (_label, input) => {
    expect(parseTranscriptText(input).cues).toHaveLength(2)
  })

  it('skips lines with no timestamp', () => {
    const { cues } = parseTranscriptText('some heading\n[0:05] real cue\nmore prose\n[0:10] another')
    expect(cues.map((c) => c.text)).toEqual(['real cue', 'another'])
  })
})

describe('parseTranscriptText — robustness', () => {
  it.each([['empty', ''], ['whitespace', '   \n  '], ['prose', 'no timings at all here']])(
    'returns no cues for %s rather than throwing',
    (_label, input) => {
      expect(parseTranscriptText(input).cues).toEqual([])
    },
  )

  it('orders cues by start time even when the input is shuffled', () => {
    const shuffled = `WEBVTT

00:00:09.000 --> 00:00:12.000
third

00:00:01.000 --> 00:00:04.000
first
`
    expect(parseTranscriptText(shuffled).cues.map((c) => c.text)).toEqual(['first', 'third'])
  })

  it('rejects impossible clock values instead of coercing them', () => {
    const bad = `WEBVTT

00:99:99.000 --> 00:99:99.000
nope
`
    expect(parseTranscriptText(bad).cues).toEqual([])
  })

  it('never produces an end time before its start', () => {
    const inverted = `WEBVTT

00:00:10.000 --> 00:00:05.000
backwards
`
    const cue = parseTranscriptText(inverted).cues[0]!
    expect(cue.endMs).toBeGreaterThanOrEqual(cue.startMs)
  })
})
