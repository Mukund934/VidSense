'use client'

import { formatTimestamp, type Receipt } from '@/domain/transcript'
import { precisionOf } from '@/domain/timing'
import { LaneBadge, PrecisionBadge } from '@/components/precision'

/**
 * A claim and the evidence behind it.
 *
 * The rule this component enforces: **an unlocated receipt gets no jump
 * control.** The quote is still shown, because the words are real evidence —
 * but a button that seeks to a time we cannot vouch for would convert that
 * evidence into a false citation, which is worse than offering nothing.
 */
export function ReceiptCard({
  text,
  lane,
  receipt,
  onSeek,
}: {
  text: string
  lane: string
  receipt: Receipt | null
  onSeek?: (ms: number) => void
}) {
  const seekable = receipt !== null && precisionOf(receipt.timing) !== 'unlocated'

  return (
    <article className="rounded-lg border border-line bg-surface-raised p-3.5">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <LaneBadge lane={lane} />
        {receipt && <PrecisionBadge timing={receipt.timing} />}
      </div>

      <p className="text-[15px] leading-relaxed">{text}</p>

      {receipt && (
        <div className="mt-3 border-l-2 border-line pl-3">
          <blockquote className="text-sm italic leading-relaxed text-muted">
            “{receipt.quote}”
          </blockquote>
          <div className="mt-2">
            {seekable && onSeek ? (
              <button
                type="button"
                onClick={() => onSeek(receipt.startMs)}
                className="rounded font-mono text-xs text-accent underline underline-offset-2 hover:brightness-125"
              >
                {formatTimestamp(receipt.startMs)} — jump to it
              </button>
            ) : (
              <span className="font-mono text-xs text-muted">
                {formatTimestamp(receipt.startMs)} — no reliable jump for this quote
              </span>
            )}
          </div>
        </div>
      )}

      {!receipt && lane !== 'VIDEO' && (
        <p className="mt-2 text-xs text-muted">Not grounded in the video.</p>
      )}
    </article>
  )
}
