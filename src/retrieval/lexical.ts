/**
 * Lexical retrieval over one transcript.
 *
 * This is what `ARCHITECTURE.md` §5 has instead of a vector store. "Where was X
 * first explained", "show every mention of X" and "how long did he spend on X"
 * are a regex over ~110k characters — free, exact, and instant. At one-video
 * scale an embedding model would cost money to answer these *worse*: it would
 * find passages that are merely similar, when the question asked for the ones
 * that literally say it.
 *
 * The problem worth solving carefully is that **a phrase does not respect cue
 * boundaries.** Cues run about a dozen words, so "transformer architecture" is
 * as likely to straddle two of them as to sit inside one. Searching cue by cue
 * would silently miss exactly the multi-word phrases people search for. So the
 * transcript is flattened once, searched as a single string, and each match is
 * mapped back to the cues it touches.
 *
 * Matching is diacritic- and case-insensitive. Folding changes string lengths,
 * so it is done **per cue** and the offsets are tracked in folded space — which
 * keeps the mapping exact without ever needing to fold the whole text as one.
 */

import type { CueRange } from '@/domain/interval'
import { coveredMs } from '@/domain/interval'
import { type Receipt, type TimedTranscript, resolveReceipt } from '@/domain/transcript'

/** Characters that count as part of a word, for whole-word matching. */
const WORD_CHAR = '\\p{L}\\p{N}_'

/** The transcript as one searchable string, plus where each cue sits in it. */
export interface FlatTranscript {
  readonly text: string
  /** `starts[i]` — offset where cue `i` begins. */
  readonly starts: readonly number[]
  /** `ends[i]` — offset just past cue `i`. */
  readonly ends: readonly number[]
}

export interface SearchOptions {
  /**
   * Require the query to sit on word boundaries. On by default: "cat" should
   * not report a mention inside "category", and a search that does is one
   * nobody trusts twice.
   */
  readonly wholeWord?: boolean
  /** Stop after this many matches. */
  readonly limit?: number
}

/** Case- and diacritic-insensitive, length-tracked per cue. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Flatten to one string, recording where each cue lands in it. */
export function flatten(transcript: TimedTranscript): FlatTranscript {
  const parts: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0

  for (const cue of transcript.cues) {
    const folded = fold(cue.text)
    starts.push(offset)
    ends.push(offset + folded.length)
    parts.push(folded)
    // One separator between cues, so an adjacent phrase still reads as adjacent.
    offset += folded.length + 1
  }

  return { text: parts.join(' '), starts, ends }
}

/** Index of the cue containing `offset`, clamped into range. */
function cueAtOffset(flat: FlatTranscript, offset: number): number {
  const { starts } = flat
  let lo = 0
  let hi = starts.length - 1
  let found = 0

  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((starts[mid] ?? 0) <= offset) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return found
}

function buildPattern(query: string, wholeWord: boolean): RegExp | null {
  const terms = fold(query).trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null

  // A query of pure punctuation has no word boundaries to sit on and would
  // match noise. Refusing it is more honest than returning every comma.
  if (!new RegExp(`[${WORD_CHAR}]`, 'u').test(terms.join(''))) return null

  // Whitespace in the query matches any run of it, so a phrase still matches
  // across the separator this module inserts between cues.
  const body = terms.map(escapeRegExp).join('\\s+')
  const pattern = wholeWord ? `(?<![${WORD_CHAR}])${body}(?![${WORD_CHAR}])` : body

  return new RegExp(pattern, 'gu')
}

/**
 * Every mention of `query`, in transcript order.
 *
 * Order is temporal for free: the scan runs left to right over a string built
 * in cue order, so the first result *is* the first mention.
 */
export function findMentions(
  transcript: TimedTranscript,
  query: string,
  options: SearchOptions = {},
): CueRange[] {
  const regex = buildPattern(query, options.wholeWord ?? true)
  if (!regex || transcript.cues.length === 0) return []

  const flat = flatten(transcript)
  const limit = options.limit ?? Infinity
  const found: CueRange[] = []

  for (const match of flat.text.matchAll(regex)) {
    if (found.length >= limit) break
    const start = match.index
    // A zero-length match cannot happen with a non-empty pattern, but guarding
    // it costs a line and an unguarded one would loop.
    const end = Math.max(start, start + match[0].length - 1)
    found.push({ cueStart: cueAtOffset(flat, start), cueEnd: cueAtOffset(flat, end) })
  }

  return found
}

/** The first mention, or null — "where was X first explained?" */
export function firstMention(
  transcript: TimedTranscript,
  query: string,
  options: SearchOptions = {},
): CueRange | null {
  return findMentions(transcript, query, { ...options, limit: 1 })[0] ?? null
}

/**
 * Mentions as resolved receipts.
 *
 * Routed through `resolveReceipt` rather than reading the cues directly, so
 * that every timestamp in the product — model-cited or locally found — is
 * produced by exactly one function.
 */
export function mentionReceipts(
  transcript: TimedTranscript,
  query: string,
  options: SearchOptions = {},
): Receipt[] {
  return findMentions(transcript, query, options).map((range) =>
    resolveReceipt(transcript, range.cueStart, range.cueEnd),
  )
}

/**
 * Milliseconds of speech that mention `query` — "how long did he spend on X?"
 *
 * Overlapping and adjacent mentions are merged before summing, so a topic
 * discussed across four consecutive cues counts once, not four times.
 */
export function timeSpentOn(
  transcript: TimedTranscript,
  query: string,
  options: SearchOptions = {},
): number {
  return coveredMs(transcript, findMentions(transcript, query, options))
}
