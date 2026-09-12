/**
 * Copy-with-link — one receipt, on the clipboard.
 *
 * The smallest takeaway VidSense produces, and the one people actually use.
 * Somebody watching a lecture wants to paste a claim into a message with proof
 * attached; the lawful version of that is a quotation, an attribution and a
 * link back to the source, which is exactly what this builds. Backlog §09 calls
 * it the substitute for clipping, and the reason it substitutes is that the
 * recipient ends up at YouTube rather than at a copy of YouTube's video.
 *
 * Two rules, both inherited rather than invented here:
 *
 *   1. **No timestamp on an unlocated receipt.** Same rule as `receiptSeekUrl`
 *      and the evidence pack. A pasted quote that names a time we cannot vouch
 *      for is a false citation that travels — worse than one that only misleads
 *      the person who made it.
 *   2. **A ceiling on the words.** Copying repeatedly must not add up to a
 *      transcript. `MAX_VERBATIM_WORDS` bounds a whole pack; this bounds one
 *      paste, so the loop is bounded at both ends.
 */

import { formatTimestamp, type Receipt, youtubeMomentUrl } from '@/domain/transcript'
import { precisionLabel, precisionOf } from '@/domain/timing'

/**
 * Words allowed in a single copied quote.
 *
 * A receipt spans one or two cues, so this is generous for the real case and
 * still refuses a paste that could stand in for the passage. Deliberately not
 * the 25 words O18 asks counsel about for India's section 52: that question is
 * open, and picking a number here would look like an answer.
 */
export const MAX_QUOTE_WORDS = 50

function clampWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length <= limit) return words.join(' ')
  return `${words.slice(0, limit).join(' ')} […]`
}

export interface CitationInput {
  readonly videoId: string
  readonly title: string
  readonly receipt: Receipt
  /** The claim the quote was cited for. Included when it is not the quote itself. */
  readonly claim?: string
}

/**
 * One line of plain text, ready to paste anywhere.
 *
 * Plain text rather than markdown or HTML on purpose: this lands in a chat
 * window, a document, a code comment and an email, and only one of those
 * renders a link. A bare URL works in all four.
 */
export function receiptCitation(input: CitationInput): string {
  const { videoId, title, receipt, claim } = input
  const located = precisionOf(receipt.timing) !== 'unlocated'

  const parts: string[] = [title.trim() || 'Untitled video']

  if (located) {
    const at = formatTimestamp(receipt.startMs)
    // The precision travels with the number, but only when there is something
    // to qualify. A reader who gets "14:32" alone cannot tell it is an estimate;
    // "14:32 (within about 17s)" does not let them mistake it for one. An exact
    // timestamp needs no parenthetical, and adding one would imply doubt that
    // the timing does not carry.
    parts.push(
      precisionOf(receipt.timing) === 'exact'
        ? at
        : `${at} (${precisionLabel(receipt.timing)})`,
    )
  } else {
    parts.push('time not established')
  }

  if (claim?.trim() && claim.trim() !== receipt.quote.trim()) parts.push(claim.trim())

  parts.push(`“${clampWords(receipt.quote, MAX_QUOTE_WORDS)}”`)
  parts.push(
    located
      ? youtubeMomentUrl(videoId, receipt.startMs)
      : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  )

  return parts.join(' — ')
}
