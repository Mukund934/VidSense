import { describe, expect, it } from 'vitest'
import {
  SEEK_TOLERANCE_MS,
  TOLERANCE_MS,
  UNLOCATED_ABOVE_MS,
  canSeekPrecisely,
  clipWindowTiming,
  precisionLabel,
  precisionOf,
  timingFor,
} from '@/domain/timing'
import { buildTranscript, receiptSeekUrl, resolveReceipt } from '@/domain/transcript'

const cue = (i: number) => ({ startMs: i * 4000, endMs: (i + 1) * 4000, text: `line ${i}` })

function transcriptWith(timing?: ReturnType<typeof timingFor>) {
  return buildTranscript({
    videoId: 'vid12345678',
    provenance: 'gemini_url',
    language: 'en',
    durationMs: 12_000,
    cues: [cue(0), cue(1), cue(2)],
    ...(timing ? { timing } : {}),
  })
}

describe('precisionOf', () => {
  it('calls a caption track exact', () => {
    expect(precisionOf(timingFor('caption_track'))).toBe('exact')
  })

  it('calls rescaled model output approximate, not exact', () => {
    // Measured at ~17s p95. Presenting that as an exact moment is the specific
    // failure this module exists to prevent.
    expect(precisionOf(timingFor('model_rescaled'))).toBe('approximate')
  })

  it('calls raw model output unlocated', () => {
    expect(precisionOf(timingFor('model_raw'))).toBe('unlocated')
  })

  it('calls unknown tolerance unlocated rather than exact', () => {
    // null means "not established", which must never render as precision.
    expect(timingFor('user_supplied').toleranceMs).toBeNull()
    expect(precisionOf(timingFor('user_supplied'))).toBe('unlocated')
  })

  it('is exact exactly at the seek bar and approximate just past it', () => {
    expect(precisionOf({ source: 'clip_window', toleranceMs: SEEK_TOLERANCE_MS })).toBe('exact')
    expect(precisionOf({ source: 'clip_window', toleranceMs: SEEK_TOLERANCE_MS + 1 })).toBe('approximate')
  })

  it('is approximate at the unlocated bar and unlocated just past it', () => {
    expect(precisionOf({ source: 'clip_window', toleranceMs: UNLOCATED_ABOVE_MS })).toBe('approximate')
    expect(precisionOf({ source: 'clip_window', toleranceMs: UNLOCATED_ABOVE_MS + 1 })).toBe('unlocated')
  })
})

describe('clipWindowTiming', () => {
  it('bounds the error at half the window', () => {
    expect(clipWindowTiming(30_000).toleranceMs).toBe(15_000)
  })

  it('reaches exact precision once the window is tight enough', () => {
    expect(precisionOf(clipWindowTiming(4_000))).toBe('exact')
  })

  it('never reports a negative tolerance', () => {
    expect(clipWindowTiming(-5).toleranceMs).toBe(0)
  })
})

describe('canSeekPrecisely', () => {
  it('permits a caption track', () => {
    expect(canSeekPrecisely(timingFor('caption_track'))).toBe(true)
  })

  it('refuses rescaled model output', () => {
    expect(canSeekPrecisely(timingFor('model_rescaled'))).toBe(false)
  })

  it('refuses unknown tolerance', () => {
    expect(canSeekPrecisely(timingFor('user_supplied'))).toBe(false)
  })
})

describe('precisionLabel', () => {
  it('says exact only when it is', () => {
    expect(precisionLabel(timingFor('caption_track'))).toBe('exact moment')
  })

  it('quantifies an approximate claim rather than hiding it', () => {
    expect(precisionLabel(timingFor('model_rescaled'))).toBe('within about 17s')
  })

  it('admits when timing was never established', () => {
    expect(precisionLabel(timingFor('user_supplied'))).toBe('timing not established')
  })
})

describe('receipts carry their precision', () => {
  it('defaults an unlabelled transcript to the least trustworthy source', () => {
    // A caller that never thought about timing must not be granted precision.
    expect(transcriptWith().timing.source).toBe('model_raw')
  })

  it('propagates transcript timing onto the receipt', () => {
    const t = transcriptWith(timingFor('caption_track'))
    const receipt = resolveReceipt(t, 0, 1)
    expect(receipt.timing.source).toBe('caption_track')
    expect(receipt.precision).toBe('exact')
  })

  it('marks a receipt from raw model output as unlocated', () => {
    expect(resolveReceipt(transcriptWith(), 0, 0).precision).toBe('unlocated')
  })
})

describe('receiptSeekUrl', () => {
  it('links to the second when the timing supports it', () => {
    const t = transcriptWith(timingFor('caption_track'))
    expect(receiptSeekUrl('vid12345678', resolveReceipt(t, 1, 1))).toBe(
      'https://www.youtube.com/watch?v=vid12345678&t=4s',
    )
  })

  it('still links for an approximate receipt', () => {
    const t = transcriptWith(timingFor('model_rescaled'))
    expect(receiptSeekUrl('vid12345678', resolveReceipt(t, 1, 1))).toContain('&t=4s')
  })

  it('refuses to link an unlocated receipt', () => {
    // The quote is still evidence. A link that lands in the wrong sentence is
    // not, and attaching one would turn evidence into a false claim.
    const t = transcriptWith(timingFor('model_raw'))
    expect(receiptSeekUrl('vid12345678', resolveReceipt(t, 1, 1))).toBeNull()
  })
})

describe('the tolerance table', () => {
  it('gives a caption track zero tolerance and the model a large one', () => {
    expect(TOLERANCE_MS.caption_track).toBe(0)
    expect(TOLERANCE_MS.model_raw).toBeGreaterThan(TOLERANCE_MS.model_rescaled!)
  })

  it('leaves clip windows to be filled in per ingest', () => {
    // Its bound is whatever window was actually used, so a constant would lie.
    expect(TOLERANCE_MS.clip_window).toBeNull()
  })
})
