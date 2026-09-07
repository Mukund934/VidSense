import { describe, expect, it } from 'vitest'
import {
  MAX_VERBATIM_WORDS,
  buildEvidencePack,
  type PackEntry,
  type PackVideo,
} from '@/export/evidence-pack'
import { buildTranscript, resolveReceipt } from '@/domain/transcript'
import { timingFor } from '@/domain/timing'

const VIDEO: PackVideo = {
  videoId: 'vid12345678',
  title: 'Computer Networks',
  channelTitle: 'Prof X',
  durationSec: 600,
}

function receiptFrom(texts: string[], timing = timingFor('caption_track'), cue = 0) {
  const t = buildTranscript({
    videoId: VIDEO.videoId,
    provenance: 'gemini_url',
    language: 'en',
    durationMs: texts.length * 4000,
    cues: texts.map((text, i) => ({ startMs: i * 4000, endMs: (i + 1) * 4000, text })),
    timing,
  })
  return resolveReceipt(t, cue, cue)
}

const entry = (heading: string, texts: string[], timing?: ReturnType<typeof timingFor>): PackEntry => ({
  heading,
  receipt: receiptFrom(texts, timing),
})

const pack = (entries: PackEntry[], notes?: Array<{ tMs: number; text: string }>) =>
  buildEvidencePack({
    video: VIDEO,
    entries,
    ...(notes ? { notes } : {}),
    generatedAt: Date.UTC(2026, 8, 7),
  })

describe('buildEvidencePack', () => {
  it('leads with the video and a link back to it', () => {
    const md = pack([]).markdown
    expect(md).toContain('# Computer Networks')
    expect(md).toContain('**Prof X**')
    expect(md).toContain('https://www.youtube.com/watch?v=vid12345678')
  })

  it('says plainly when there is nothing to export', () => {
    expect(pack([]).markdown).toContain('_No evidence was collected')
  })

  it('renders a claim with its quote and a jump link', () => {
    const md = pack([entry('How does TCP start?', ['it uses a three way handshake'])]).markdown
    expect(md).toContain('## How does TCP start?')
    expect(md).toContain('> it uses a three way handshake')
    expect(md).toContain('watch?v=vid12345678&t=0s')
  })

  it('states the precision beside every timestamp', () => {
    expect(pack([entry('q', ['words'])]).markdown).toContain('*exact moment*')
    expect(pack([entry('q', ['words'], timingFor('model_rescaled'))]).markdown)
      .toContain('*within about 17s*')
  })

  it('includes notes when there are any', () => {
    const md = pack([], [{ tMs: 65_000, text: 'revisit this' }]).markdown
    expect(md).toContain('## Your notes')
    expect(md).toContain('**1:05** — revisit this')
  })

  it('closes with what the pack is and is not', () => {
    const md = pack([entry('q', ['words'])]).markdown
    expect(md).toContain('never downloads or stores video or audio')
    expect(md).toContain('is not a transcript')
  })
})

describe('the jump link is withheld when it cannot be trusted', () => {
  it('omits the link for an unlocated receipt but keeps the quote', () => {
    const md = pack([entry('q', ['the words still matter'], timingFor('model_raw'))]).markdown
    expect(md).toContain('> the words still matter')
    expect(md).toContain('*timing not established*')
    expect(md).not.toContain('&t=')
  })

  it('keeps the link for an approximate receipt', () => {
    const md = pack([entry('q', ['words'], timingFor('model_rescaled'))]).markdown
    expect(md).toContain('&t=0s')
  })
})

describe('the verbatim ceiling', () => {
  const long = (words: number) => Array.from({ length: words }, (_, i) => `w${i}`).join(' ')

  it('lets an ordinary pack through untouched', () => {
    const result = pack([entry('q', ['a short quote'])])
    expect(result.truncatedEntries).toBe(0)
    expect(result.verbatimWords).toBe(3)
  })

  it('never exceeds the cap however much evidence is collected', () => {
    const entries = Array.from({ length: 30 }, (_, i) => entry(`claim ${i}`, [long(100)]))
    const result = pack(entries)
    expect(result.verbatimWords).toBeLessThanOrEqual(MAX_VERBATIM_WORDS)
  })

  it('marks a quote it had to cut', () => {
    const result = pack([entry('q', [long(MAX_VERBATIM_WORDS + 50)])])
    expect(result.truncatedEntries).toBe(1)
    expect(result.markdown).toContain('[…]')
  })

  it('spends the budget in order, so the first evidence survives intact', () => {
    const result = pack([entry('first', ['a b c']), entry('second', [long(MAX_VERBATIM_WORDS)])])
    expect(result.markdown).toContain('> a b c')
    expect(result.truncatedEntries).toBe(1)
  })

  it('omits later quotes entirely once the budget is gone, and says why', () => {
    const entries = [entry('big', [long(MAX_VERBATIM_WORDS)]), entry('after', ['more words here'])]
    const result = pack(entries)
    expect(result.markdown).toContain('reached its quotation limit')
    expect(result.markdown).not.toContain('> more words here')
  })

  it('still shows the timestamp for an entry whose quote was omitted', () => {
    const entries = [entry('big', [long(MAX_VERBATIM_WORDS)]), entry('after', ['more words'])]
    // The reader can still go and listen, which is the point.
    expect(pack(entries).markdown).toContain('## after')
  })
})
