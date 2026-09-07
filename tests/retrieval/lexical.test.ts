import { describe, expect, it } from 'vitest'
import {
  findMentions,
  firstMention,
  flatten,
  mentionReceipts,
  timeSpentOn,
} from '@/retrieval/lexical'
import { buildTranscript } from '@/domain/transcript'

function transcriptOf(texts: string[], cueMs = 4000) {
  return buildTranscript({
    videoId: 'v',
    provenance: 'gemini_url',
    language: 'en',
    durationMs: texts.length * cueMs,
    cues: texts.map((text, i) => ({ startMs: i * cueMs, endMs: (i + 1) * cueMs, text })),
  })
}

/** The case the whole module exists for: a phrase split across a cue boundary. */
const SPLIT = transcriptOf([
  'we will now discuss the transformer',
  'architecture and why it works so well',
  'later we return to the transformer architecture once more',
])

const empty = transcriptOf([])

describe('flatten', () => {
  it('joins cues into one searchable string', () => {
    expect(flatten(transcriptOf(['one two', 'three'])).text).toBe('one two three')
  })

  it('records where each cue lands', () => {
    const flat = flatten(transcriptOf(['one two', 'three']))
    expect(flat.starts).toEqual([0, 8])
    expect(flat.ends).toEqual([7, 13])
  })

  it('folds case and diacritics', () => {
    expect(flatten(transcriptOf(['Café OWNER'])).text).toBe('cafe owner')
  })

  it('handles an empty transcript', () => {
    expect(flatten(empty).text).toBe('')
  })
})

describe('findMentions', () => {
  it('finds a single word', () => {
    expect(findMentions(transcriptOf(['the cat sat']), 'cat')).toEqual([
      { cueStart: 0, cueEnd: 0 },
    ])
  })

  it('matches regardless of case', () => {
    expect(findMentions(transcriptOf(['The CAT sat']), 'cat')).toHaveLength(1)
  })

  it('matches through diacritics', () => {
    expect(findMentions(transcriptOf(['we met at a café']), 'cafe')).toHaveLength(1)
    expect(findMentions(transcriptOf(['we met at a cafe']), 'café')).toHaveLength(1)
  })

  it('respects word boundaries by default', () => {
    expect(findMentions(transcriptOf(['browse the category list']), 'cat')).toEqual([])
  })

  it('matches inside words when whole-word is off', () => {
    expect(findMentions(transcriptOf(['browse the category list']), 'cat', { wholeWord: false }))
      .toHaveLength(1)
  })

  it('finds a phrase that straddles two cues', () => {
    expect(findMentions(SPLIT, 'transformer architecture')).toEqual([
      { cueStart: 0, cueEnd: 1 },
      { cueStart: 2, cueEnd: 2 },
    ])
  })

  it('returns matches in transcript order', () => {
    const t = transcriptOf(['alpha here', 'nothing', 'alpha again', 'alpha last'])
    expect(findMentions(t, 'alpha').map((m) => m.cueStart)).toEqual([0, 2, 3])
  })

  it('honours a limit', () => {
    const t = transcriptOf(['alpha', 'alpha', 'alpha'])
    expect(findMentions(t, 'alpha', { limit: 2 })).toHaveLength(2)
  })

  it('collapses whitespace in the query', () => {
    expect(findMentions(SPLIT, '  transformer    architecture  ')).toHaveLength(2)
  })

  it('treats regex metacharacters literally', () => {
    const t = transcriptOf(['the value is a.b today'])
    expect(findMentions(t, 'a.b')).toHaveLength(1)
    // If `.` were live, this would match "a.b".
    expect(findMentions(transcriptOf(['the value is axb today']), 'a.b')).toEqual([])
  })

  it('finds nothing that is not there', () => {
    expect(findMentions(SPLIT, 'kubernetes')).toEqual([])
  })

  it('refuses an empty query', () => {
    expect(findMentions(SPLIT, '')).toEqual([])
    expect(findMentions(SPLIT, '   ')).toEqual([])
  })

  it('refuses a query with no word characters, rather than matching punctuation', () => {
    expect(findMentions(transcriptOf(['well, yes, indeed']), ',')).toEqual([])
    expect(findMentions(transcriptOf(['well... yes']), '...')).toEqual([])
  })

  it('handles an empty transcript', () => {
    expect(findMentions(empty, 'anything')).toEqual([])
  })
})

describe('firstMention', () => {
  it('answers "where was this first explained"', () => {
    const t = transcriptOf(['intro', 'we define entropy here', 'entropy again'])
    expect(firstMention(t, 'entropy')).toEqual({ cueStart: 1, cueEnd: 1 })
  })

  it('is null when the video never mentions it', () => {
    expect(firstMention(SPLIT, 'kubernetes')).toBeNull()
  })
})

describe('mentionReceipts', () => {
  it('resolves each mention to a timestamped receipt', () => {
    const receipts = mentionReceipts(SPLIT, 'transformer architecture')
    expect(receipts[0]).toMatchObject({ cueStart: 0, cueEnd: 1, startMs: 0, endMs: 8000 })
    expect(receipts[1]).toMatchObject({ cueStart: 2, cueEnd: 2, startMs: 8000, endMs: 12_000 })
  })

  it('quotes the original text, not the folded search text', () => {
    const receipts = mentionReceipts(transcriptOf(['We met at a Café today']), 'cafe')
    expect(receipts[0]?.quote).toBe('We met at a Café today')
  })

  it('spans both cues in the quote when a phrase straddles them', () => {
    expect(mentionReceipts(SPLIT, 'transformer architecture')[0]?.quote).toBe(
      'we will now discuss the transformer architecture and why it works so well',
    )
  })
})

describe('timeSpentOn', () => {
  it('sums the speech that mentions a topic', () => {
    const t = transcriptOf(['alpha', 'unrelated', 'alpha'])
    expect(timeSpentOn(t, 'alpha')).toBe(8000)
  })

  it('counts a run of consecutive mentions once, not once per cue', () => {
    const t = transcriptOf(['alpha', 'alpha', 'alpha'])
    // Three mentions across three contiguous 4s cues is 12s of speech, not 12s
    // counted three times.
    expect(timeSpentOn(t, 'alpha')).toBe(12_000)
  })

  it('is zero for a topic the video never covers', () => {
    expect(timeSpentOn(SPLIT, 'kubernetes')).toBe(0)
  })
})
