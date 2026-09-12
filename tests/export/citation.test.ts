import { describe, expect, it } from 'vitest'

import { MAX_QUOTE_WORDS, receiptCitation } from '@/export/citation'
import { buildTranscript, resolveReceipt } from '@/domain/transcript'
import { timingFor, type TimingSource } from '@/domain/timing'

const VIDEO_ID = 'vid12345678'

function receiptFrom(texts: string[], source: TimingSource = 'caption_track') {
  const transcript = buildTranscript({
    videoId: VIDEO_ID,
    provenance: 'gemini_url',
    language: 'en',
    durationMs: texts.length * 4000,
    cues: texts.map((text, i) => ({ startMs: i * 4000, endMs: (i + 1) * 4000, text })),
    timing: timingFor(source),
  })
  return resolveReceipt(transcript, 0, 0)
}

const cite = (texts: string[], source?: TimingSource, extra: { claim?: string } = {}) =>
  receiptCitation({
    videoId: VIDEO_ID,
    title: 'Computer Networks',
    receipt: receiptFrom(texts, source),
    ...extra,
  })

describe('receiptCitation', () => {
  it('carries the title, the time, the words and a way back', () => {
    const line = cite(['it uses a three way handshake'])
    expect(line).toContain('Computer Networks')
    expect(line).toContain('0:00')
    expect(line).toContain('“it uses a three way handshake”')
    expect(line).toContain('https://www.youtube.com/watch?v=vid12345678&t=0s')
  })

  it('is one line, so it survives being pasted anywhere', () => {
    expect(cite(['a claim about networks'])).not.toContain('\n')
  })

  describe('the timestamp never outruns the timing', () => {
    it('states the tolerance beside an estimate', () => {
      const line = cite(['a rescaled claim'], 'model_rescaled')
      expect(line).toMatch(/0:00 \(.*17.*\)/)
    })

    it('says exact without a parenthetical, because there is nothing to qualify', () => {
      expect(cite(['an exact claim'], 'caption_track')).toContain('— 0:00 —')
    })

    it.each<TimingSource>(['model_raw', 'user_supplied'])(
      'gives %s no time and no deep link at all',
      (source) => {
        const line = cite(['an unlocated claim'], source)
        expect(line).toContain('time not established')
        expect(line).not.toContain('&t=')
        expect(line).not.toMatch(/\d+:\d\d/)
        // The video is still findable; only the moment inside it is not.
        expect(line).toContain('https://www.youtube.com/watch?v=vid12345678')
      },
    )
  })

  describe('the quotation ceiling', () => {
    it('leaves an ordinary receipt untouched', () => {
      const line = cite(['short enough to survive intact'])
      expect(line).not.toContain('[…]')
    })

    it('cuts a long one and marks the cut', () => {
      const long = Array.from({ length: MAX_QUOTE_WORDS + 25 }, (_, i) => `word${i}`).join(' ')
      const line = cite([long])
      expect(line).toContain('[…]')
      expect(line).not.toContain(`word${MAX_QUOTE_WORDS + 10}`)
    })

    it('never pastes more than the ceiling, however many cues the receipt spans', () => {
      const line = cite([Array.from({ length: 400 }, () => 'lorem').join(' ')])
      const quote = /“([^”]*)”/.exec(line)?.[1] ?? ''
      expect(quote.replace(' […]', '').split(/\s+/).length).toBe(MAX_QUOTE_WORDS)
    })
  })

  describe('the claim', () => {
    it('is included when it says something the quote does not', () => {
      expect(cite(['a three way handshake'], 'caption_track', { claim: 'TCP opens with SYN' })).toContain(
        'TCP opens with SYN',
      )
    })

    it('is dropped when it merely repeats the quote', () => {
      const line = cite(['a three way handshake'], 'caption_track', {
        claim: 'a three way handshake',
      })
      expect(line.match(/a three way handshake/g)).toHaveLength(1)
    })
  })

  it('survives a video with no title', () => {
    const line = receiptCitation({
      videoId: VIDEO_ID,
      title: '   ',
      receipt: receiptFrom(['something was said']),
    })
    expect(line.startsWith('Untitled video —')).toBe(true)
  })
})
