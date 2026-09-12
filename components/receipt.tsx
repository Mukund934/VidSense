'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { formatTimestamp, type Receipt } from '@/domain/transcript'
import { precisionOf } from '@/domain/timing'
import { receiptCitation } from '@/export/citation'
import { LaneBadge, PrecisionBadge } from '@/components/precision'

/**
 * A claim and the evidence behind it.
 *
 * The rule this component enforces: **an unlocated receipt gets no jump
 * control.** The quote is still shown, because the words are real evidence —
 * but a button that seeks to a time we cannot vouch for would convert that
 * evidence into a false citation, which is worse than offering nothing.
 *
 * The copy control is the same rule pointed outward. A receipt that leaves the
 * product carries its quote, its attribution and a link back; when the timing
 * cannot support a moment, the pasted line says so rather than naming one.
 */

type CopyState = 'idle' | 'copied' | 'failed'

export function ReceiptCard({
  text,
  lane,
  receipt,
  verification,
  videoId,
  title,
  onSeek,
}: {
  text: string
  lane: string
  receipt: Receipt | null
  verification?: { entailment: string } | undefined
  /** Both are needed to build a citation; without them the copy control hides. */
  videoId?: string
  title?: string
  onSeek?: (ms: number) => void
}) {
  const seekable = receipt !== null && precisionOf(receipt.timing) !== 'unlocated'
  const [copied, setCopied] = useState<CopyState>('idle')
  const revert = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(revert.current), [])

  const copy = useCallback(async () => {
    if (!receipt || !videoId) return
    const line = receiptCitation({ videoId, title: title ?? '', receipt, claim: text })
    try {
      await navigator.clipboard.writeText(line)
      setCopied('copied')
    } catch {
      // A browser can refuse this — an insecure origin, or a permission the user
      // declined. Saying so beats a button that silently does nothing.
      setCopied('failed')
    }
    clearTimeout(revert.current)
    revert.current = setTimeout(() => setCopied('idle'), 2400)
  }, [receipt, videoId, title, text])

  return (
    <article
      className="vs-enter rounded-lg border border-line bg-surface-raised p-3.5 shadow-raised
                 transition-shadow duration-[var(--dur-fast)] hover:shadow-lifted"
    >
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

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {seekable && onSeek ? (
              <button
                type="button"
                onClick={() => onSeek(receipt.startMs)}
                className="group inline-flex items-center gap-1.5 rounded font-mono text-xs text-accent
                           transition-colors duration-[var(--dur-instant)] hover:text-accent-hover"
              >
                <span className="underline underline-offset-2">
                  {formatTimestamp(receipt.startMs)}
                </span>
                {/* Only the arrow is decorative. Marking the words `aria-hidden`
                    too would leave a screen reader with a button called "0:00". */}
                <span className="inline-flex items-center gap-1">
                  jump to it
                  <span
                    aria-hidden
                    className="transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)]
                               group-hover:translate-x-0.5"
                  >
                    →
                  </span>
                </span>
              </button>
            ) : (
              <span className="font-mono text-xs text-muted">
                {formatTimestamp(receipt.startMs)} — no reliable jump for this quote
              </span>
            )}

            {videoId && (
              <button
                type="button"
                onClick={() => void copy()}
                aria-live="polite"
                className={`rounded text-xs transition-colors duration-[var(--dur-instant)] ${
                  copied === 'copied'
                    ? 'text-exact'
                    : copied === 'failed'
                      ? 'text-approx'
                      : 'text-muted hover:text-ink'
                }`}
              >
                {copied === 'copied'
                  ? 'Copied with its link'
                  : copied === 'failed'
                    ? 'Could not copy'
                    : 'Copy with link'}
              </button>
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
