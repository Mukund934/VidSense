import { describe, expect, it } from 'vitest'
import { rescaleToDuration } from '@/ingest/sources/gemini-url'

const cues = (times: number[]) =>
  times.map((t, i) => ({ startMs: t * 1000, endMs: (times[i + 1] ?? t + 4) * 1000, text: `c${i}` }))

describe('rescaleToDuration', () => {
  it('anchors an overshooting transcript to the real duration', () => {
    // Measured behaviour: the model runs ~1.5x past the end of the video.
    const out = rescaleToDuration(cues([0, 100, 200, 300]), 200_000)
    expect(out.timing.source).toBe('model_rescaled')
    expect(Math.max(...out.cues.map((c) => c.endMs))).toBe(200_000)
  })

  it('preserves relative order and spacing', () => {
    const out = rescaleToDuration(cues([0, 100, 200, 300]), 200_000)
    const starts = out.cues.map((c) => c.startMs)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it('leaves a transcript that already fits alone', () => {
    // Scaling a transcript that never overshot would invent an error to correct.
    const input = cues([0, 10, 20])
    const out = rescaleToDuration(input, 600_000)
    expect(out.cues).toEqual(input)
    expect(out.timing.source).toBe('model_raw')
  })

  it('does not rescale when the duration is unknown', () => {
    const out = rescaleToDuration(cues([0, 100]), 0)
    expect(out.timing.source).toBe('model_raw')
  })

  it('handles an empty transcript', () => {
    expect(rescaleToDuration([], 1000).cues).toEqual([])
  })

  it('does not mutate its input', () => {
    const input = cues([0, 100, 200])
    rescaleToDuration(input, 50_000)
    expect(input[0]!.startMs).toBe(0)
    expect(input[2]!.startMs).toBe(200_000)
  })
})
