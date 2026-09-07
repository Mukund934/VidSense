import { describe, expect, it } from 'vitest'
import {
  type CueRange,
  coveredMs,
  cueAt,
  cueIndexAt,
  cueIndexAtOrBefore,
  cuesAfter,
  cuesBefore,
  cuesOverlapping,
  expandRange,
  mergeRanges,
} from '@/domain/interval'
import { buildTranscript } from '@/domain/transcript'

/** Contiguous cues, 4s each: [0,4000) [4000,8000) ... */
function contiguous(count = 6) {
  return buildTranscript({
    videoId: 'v',
    provenance: 'gemini_url',
    language: 'en',
    durationMs: count * 4000,
    cues: Array.from({ length: count }, (_, i) => ({
      startMs: i * 4000,
      endMs: (i + 1) * 4000,
      text: `segment ${i}`,
    })),
  })
}

/** A transcript with a deliberate hole between 4000 and 10000. */
function withGap() {
  return buildTranscript({
    videoId: 'v',
    provenance: 'gemini_url',
    language: 'en',
    durationMs: 20_000,
    cues: [
      { startMs: 0, endMs: 4000, text: 'before the silence' },
      { startMs: 10_000, endMs: 14_000, text: 'after the silence' },
    ],
  })
}

const empty = () =>
  buildTranscript({ videoId: 'v', provenance: 'gemini_url', language: 'en', durationMs: 0, cues: [] })

describe('cueIndexAtOrBefore', () => {
  it('returns null before the transcript starts', () => {
    const t = buildTranscript({
      videoId: 'v',
      provenance: 'gemini_url',
      language: 'en',
      durationMs: 8000,
      cues: [{ startMs: 1000, endMs: 5000, text: 'late start' }],
    })
    expect(cueIndexAtOrBefore(t, 500)).toBeNull()
  })

  it('returns null for an empty transcript', () => {
    expect(cueIndexAtOrBefore(empty(), 0)).toBeNull()
  })

  it('finds the cue containing the moment', () => {
    expect(cueIndexAtOrBefore(contiguous(), 9500)).toBe(2)
  })

  it('treats an exact start as belonging to that cue', () => {
    expect(cueIndexAtOrBefore(contiguous(), 8000)).toBe(2)
  })

  it('holds at the last cue past the end of the transcript', () => {
    expect(cueIndexAtOrBefore(contiguous(), 999_999)).toBe(5)
  })

  it('returns the preceding cue inside a gap', () => {
    expect(cueIndexAtOrBefore(withGap(), 7000)).toBe(0)
  })
})

describe('cueIndexAt', () => {
  it('finds the covering cue', () => {
    expect(cueIndexAt(contiguous(), 9500)).toBe(2)
  })

  it('is half-open, so a boundary belongs to the later cue only', () => {
    expect(cueIndexAt(contiguous(), 8000)).toBe(2)
    expect(cueIndexAt(contiguous(), 7999)).toBe(1)
  })

  it('returns null inside a gap rather than guessing', () => {
    expect(cueIndexAt(withGap(), 7000)).toBeNull()
  })

  it('returns null past the end', () => {
    expect(cueIndexAt(contiguous(), 999_999)).toBeNull()
  })

  it('returns null before the start', () => {
    expect(cueIndexAt(withGap(), -1)).toBeNull()
  })
})

describe('cueAt', () => {
  it('returns the cue itself', () => {
    expect(cueAt(contiguous(), 4100)?.text).toBe('segment 1')
  })

  it('returns null in a gap', () => {
    expect(cueAt(withGap(), 6000)).toBeNull()
  })
})

describe('cuesOverlapping', () => {
  it('returns every cue the window touches', () => {
    const hits = cuesOverlapping(contiguous(), 6000, 14_000)
    expect(hits.map((c) => c.i)).toEqual([1, 2, 3])
  })

  it('includes a cue the window only clips', () => {
    const hits = cuesOverlapping(contiguous(), 3999, 4001)
    expect(hits.map((c) => c.i)).toEqual([0, 1])
  })

  it('excludes a cue that merely abuts the window', () => {
    const hits = cuesOverlapping(contiguous(), 4000, 8000)
    expect(hits.map((c) => c.i)).toEqual([1])
  })

  it('returns nothing for an empty window', () => {
    expect(cuesOverlapping(contiguous(), 5000, 5000)).toEqual([])
  })

  it('returns nothing for an inverted window', () => {
    expect(cuesOverlapping(contiguous(), 9000, 1000)).toEqual([])
  })
})

describe('cuesBefore', () => {
  it('returns the cues preceding the moment, in order', () => {
    const hits = cuesBefore(contiguous(), 13_000, 2)
    expect(hits.map((c) => c.i)).toEqual([1, 2])
  })

  it('excludes the cue the moment falls inside', () => {
    expect(cuesBefore(contiguous(), 9500, 1).map((c) => c.i)).toEqual([1])
  })

  it('clamps at the start of the transcript', () => {
    expect(cuesBefore(contiguous(), 5000, 10).map((c) => c.i)).toEqual([0])
  })

  it('returns nothing before the transcript starts', () => {
    expect(cuesBefore(withGap(), -5, 3)).toEqual([])
  })

  it('returns nothing for a non-positive count', () => {
    expect(cuesBefore(contiguous(), 13_000, 0)).toEqual([])
  })
})

describe('cuesAfter', () => {
  it('returns the cues following the moment, in order', () => {
    expect(cuesAfter(contiguous(), 9500, 2).map((c) => c.i)).toEqual([3, 4])
  })

  it('starts from the beginning when the moment precedes the transcript', () => {
    expect(cuesAfter(withGap(), -5, 1).map((c) => c.i)).toEqual([0])
  })

  it('clamps at the end of the transcript', () => {
    expect(cuesAfter(contiguous(), 19_000, 10).map((c) => c.i)).toEqual([5])
  })
})

describe('expandRange', () => {
  it('widens by whole cues on both sides', () => {
    expect(expandRange(contiguous(), { cueStart: 2, cueEnd: 3 }, 1, 1)).toEqual({
      cueStart: 1,
      cueEnd: 4,
    })
  })

  it('clamps to the transcript', () => {
    expect(expandRange(contiguous(), { cueStart: 0, cueEnd: 5 }, 4, 4)).toEqual({
      cueStart: 0,
      cueEnd: 5,
    })
  })

  it('treats negative padding as none', () => {
    expect(expandRange(contiguous(), { cueStart: 2, cueEnd: 3 }, -5, -5)).toEqual({
      cueStart: 2,
      cueEnd: 3,
    })
  })
})

describe('mergeRanges', () => {
  const merge = (ranges: CueRange[]) => mergeRanges(ranges)

  it('returns nothing for no ranges', () => {
    expect(merge([])).toEqual([])
  })

  it('leaves disjoint ranges alone', () => {
    expect(merge([{ cueStart: 0, cueEnd: 1 }, { cueStart: 5, cueEnd: 6 }])).toEqual([
      { cueStart: 0, cueEnd: 1 },
      { cueStart: 5, cueEnd: 6 },
    ])
  })

  it('merges overlapping ranges', () => {
    expect(merge([{ cueStart: 0, cueEnd: 3 }, { cueStart: 2, cueEnd: 5 }])).toEqual([
      { cueStart: 0, cueEnd: 5 },
    ])
  })

  it('merges adjacent ranges, because they are one stretch of speech', () => {
    expect(merge([{ cueStart: 3, cueEnd: 5 }, { cueStart: 6, cueEnd: 8 }])).toEqual([
      { cueStart: 3, cueEnd: 8 },
    ])
  })

  it('absorbs a nested range', () => {
    expect(merge([{ cueStart: 0, cueEnd: 9 }, { cueStart: 3, cueEnd: 4 }])).toEqual([
      { cueStart: 0, cueEnd: 9 },
    ])
  })

  it('does not depend on input order', () => {
    expect(merge([{ cueStart: 6, cueEnd: 8 }, { cueStart: 0, cueEnd: 2 }, { cueStart: 3, cueEnd: 5 }])).toEqual([
      { cueStart: 0, cueEnd: 8 },
    ])
  })

  it('does not mutate its input', () => {
    const input = [{ cueStart: 5, cueEnd: 6 }, { cueStart: 0, cueEnd: 1 }]
    mergeRanges(input)
    expect(input[0]).toEqual({ cueStart: 5, cueEnd: 6 })
  })
})

describe('coveredMs', () => {
  it('measures a single range', () => {
    expect(coveredMs(contiguous(), [{ cueStart: 1, cueEnd: 2 }])).toBe(8000)
  })

  it('counts adjacent ranges once, not twice', () => {
    const separately = 4000 + 4000
    const merged = coveredMs(contiguous(), [
      { cueStart: 1, cueEnd: 1 },
      { cueStart: 2, cueEnd: 2 },
    ])
    expect(merged).toBe(separately)
    // and the merged span really is one continuous stretch
    expect(mergeRanges([{ cueStart: 1, cueEnd: 1 }, { cueStart: 2, cueEnd: 2 }])).toHaveLength(1)
  })

  it('does not double-count overlapping ranges', () => {
    expect(coveredMs(contiguous(), [
      { cueStart: 0, cueEnd: 3 },
      { cueStart: 1, cueEnd: 2 },
    ])).toBe(16_000)
  })

  it('sums disjoint ranges', () => {
    expect(coveredMs(contiguous(), [
      { cueStart: 0, cueEnd: 0 },
      { cueStart: 4, cueEnd: 4 },
    ])).toBe(8000)
  })

  it('is zero for no ranges', () => {
    expect(coveredMs(contiguous(), [])).toBe(0)
  })

  it('ignores a range that points outside the transcript', () => {
    expect(coveredMs(contiguous(), [{ cueStart: 40, cueEnd: 41 }])).toBe(0)
  })
})
