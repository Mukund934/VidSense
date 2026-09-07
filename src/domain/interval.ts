/**
 * Interval logic over a transcript.
 *
 * Every temporal question the product answers *without paying a model* lives
 * here — "what came before 14:32", "summarise 42:00 to 1:03:00", "how long did
 * he spend on X". `ARCHITECTURE.md` §5 prices all of these at zero, and this is
 * why: cues are sorted and contiguous by construction (`buildTranscript`), so
 * each one is a lookup and some arithmetic.
 *
 * Cue intervals are treated as **half-open**, `[startMs, endMs)`. Adjacent cues
 * therefore tile the timeline without a moment belonging to two of them, which
 * is what makes player-sync land on exactly one line.
 */

import type { Cue, TimedTranscript } from '@/domain/transcript'

/** A contiguous, inclusive span of cues. The unit every receipt is cut from. */
export interface CueRange {
  readonly cueStart: number
  readonly cueEnd: number
}

/**
 * Index of the last cue starting at or before `ms`, or null if `ms` precedes
 * the transcript.
 *
 * Binary search rather than a scan: this is the primitive the player calls on
 * every `timeupdate`, several times a second, for the whole length of a video.
 */
export function cueIndexAtOrBefore(transcript: TimedTranscript, ms: number): number | null {
  const { cues } = transcript
  let lo = 0
  let hi = cues.length - 1
  let found = -1

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const cue = cues[mid]
    if (!cue) break
    if (cue.startMs <= ms) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return found === -1 ? null : found
}

/**
 * Index of the cue covering `ms`, or null.
 *
 * Null is a real answer, not a failure: a moment can fall in a gap between cues
 * (silence, music, a pause the transcriber dropped) or past the last one.
 */
export function cueIndexAt(transcript: TimedTranscript, ms: number): number | null {
  const index = cueIndexAtOrBefore(transcript, ms)
  if (index === null) return null
  const cue = transcript.cues[index]
  return cue && cue.endMs > ms ? index : null
}

export function cueAt(transcript: TimedTranscript, ms: number): Cue | null {
  const index = cueIndexAt(transcript, ms)
  return index === null ? null : (transcript.cues[index] ?? null)
}

/**
 * Every cue overlapping `[startMs, endMs)` — the "summarise 42:00–1:03:00" path.
 *
 * A linear filter, deliberately. At ~1,500 cues it costs microseconds, and the
 * architecture's whole argument is that retrieval machinery is not worth its
 * complexity at one-video scale. A binary search here would be the same mistake
 * one layer down.
 */
export function cuesOverlapping(
  transcript: TimedTranscript,
  startMs: number,
  endMs: number,
): readonly Cue[] {
  if (endMs <= startMs) return []
  return transcript.cues.filter((cue) => cue.startMs < endMs && cue.endMs > startMs)
}

/** The `count` cues ending at or before `ms`, in transcript order. */
export function cuesBefore(
  transcript: TimedTranscript,
  ms: number,
  count: number,
): readonly Cue[] {
  if (count <= 0) return []
  const anchor = cueIndexAtOrBefore(transcript, ms)
  if (anchor === null) return []

  const cue = transcript.cues[anchor]
  if (!cue) return []

  // A cue still running at `ms` is the *current* line, not a preceding one — so
  // "what came before 14:32" must not hand back the sentence being spoken at
  // 14:32. A cue that already ended (the moment sits in a gap) genuinely is
  // before it, and is included.
  const end = cue.endMs > ms ? anchor : anchor + 1
  return transcript.cues.slice(Math.max(0, end - count), end)
}

/** The `count` cues starting at or after `ms`, in transcript order. */
export function cuesAfter(
  transcript: TimedTranscript,
  ms: number,
  count: number,
): readonly Cue[] {
  if (count <= 0) return []
  const anchor = cueIndexAtOrBefore(transcript, ms)
  const start = anchor === null ? 0 : anchor + 1
  return transcript.cues.slice(start, start + count)
}

/** Widen a range by whole cues on each side, clamped to the transcript. */
export function expandRange(
  transcript: TimedTranscript,
  range: CueRange,
  before: number,
  after: number,
): CueRange {
  const last = transcript.cues.length - 1
  return {
    cueStart: Math.max(0, range.cueStart - Math.max(0, before)),
    cueEnd: Math.min(last, range.cueEnd + Math.max(0, after)),
  }
}

/**
 * Collapse overlapping and adjacent ranges into the fewest that cover the same
 * cues. Adjacency counts: ranges 3–5 and 6–8 describe one continuous stretch of
 * speech, and reporting them separately would double-count the boundary.
 */
export function mergeRanges(ranges: readonly CueRange[]): CueRange[] {
  if (ranges.length === 0) return []

  const sorted = [...ranges].sort((a, b) => a.cueStart - b.cueStart || a.cueEnd - b.cueEnd)
  const merged: CueRange[] = []

  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.cueStart <= last.cueEnd + 1) {
      if (range.cueEnd > last.cueEnd) {
        merged[merged.length - 1] = { cueStart: last.cueStart, cueEnd: range.cueEnd }
      }
      continue
    }
    merged.push(range)
  }

  return merged
}

/**
 * Total milliseconds covered by a set of cue ranges — "how long did he spend on
 * X". Merged first, so two mentions in neighbouring cues count once.
 */
export function coveredMs(transcript: TimedTranscript, ranges: readonly CueRange[]): number {
  return mergeRanges(ranges).reduce((total, range) => {
    const first = transcript.cues[range.cueStart]
    const last = transcript.cues[range.cueEnd]
    if (!first || !last) return total
    return total + Math.max(0, last.endMs - first.startMs)
  }, 0)
}
