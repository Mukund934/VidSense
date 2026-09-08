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
  verification,
  onSeek,
}: {
  text: string
  lane: string
  receipt: Receipt | null
  verification?: { entailment: string } | undefined
  onSeek?: (ms: number) => void
}) {
  const seekable = receipt !== null && precisionOf(receipt.timing) !== 'unlocated'

  return (
    <article className="rounded-lg border border-line bg-surface-raised p-3.5">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <LaneBadge lane={lane} />
        {receipt && <PrecisionBadge timing={receipt.timing} />}
        {verification?.entailment === 'supported' && (
          <span
            className="inline-flex shrink-0 items-center rounded-full border border-exact/40 bg-exact-soft px-2 py-0.5 text-[11px] font-medium text-exact"
            title="A second pass checked this quote against the claim and found it supports it."
          >
            checked
          </span>
        )}
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

      {verification?.entailment === 'not_supported' && (
        // The claim keeps its words and loses its evidence. Saying why is the
        // point: a silently receipt-less claim looks like one nobody checked.
        <p className="mt-3 rounded border border-approx/40 bg-approx-soft px-2.5 py-2 text-xs">
          The passage this cited does not support the statement, so the citation was removed.
          The statement itself may still be true — it is not evidenced here.
        </p>
      )}

      {!receipt && lane !== 'VIDEO' && (
        <p className="mt-2 text-xs text-muted">Not grounded in the video.</p>
      )}
    </article>
  )
}
