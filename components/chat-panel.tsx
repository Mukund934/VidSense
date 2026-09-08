'use client'

import { useState, type FormEvent } from 'react'
import type { Answer } from '@/answer/contract'
import { ReceiptCard } from '@/components/receipt'

export interface Turn {
  readonly question: string
  readonly answer: Answer | null
  readonly error?: string
}

/**
 * The chat, which is not a chatbot.
 *
 * Every answer is a list of claims, each carrying its own evidence and lane.
 * There is no free prose, because prose is where an unsupported sentence hides;
 * if a statement is worth showing it is worth citing, and if it cannot be cited
 * it belongs in the INFERENCE lane where the reader can see what it is.
 */
export function ChatPanel({
  turns,
  pending,
  onAsk,
  onSeek,
  disabled,
  disabledReason,
}: {
  turns: readonly Turn[]
  pending: boolean
  onAsk: (question: string) => void
  onSeek: (ms: number) => void
  disabled?: boolean
  disabledReason?: string
}) {
  const [value, setValue] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    const q = value.trim()
    if (!q || pending || disabled) return
    onAsk(q)
    setValue('')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="vs-scroll flex-1 space-y-5 overflow-y-auto p-3">
        {turns.length === 0 && !pending && (
          <div className="px-2 py-8 text-sm text-muted">
            <p className="font-medium text-ink">Ask about this video.</p>
            <ul className="mt-3 space-y-1.5">
              <li>· What is the main argument?</li>
              <li>· Where is X first explained?</li>
              <li>· What does it say about Y?</li>
            </ul>
            <p className="mt-4 text-xs">
              Answers cite the transcript. If the video does not cover something, VidSense says so
              rather than filling the gap.
            </p>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className="space-y-2.5">
            <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm font-medium">{turn.question}</p>

            {turn.error && (
              <p className="rounded-lg border border-approx/40 bg-approx-soft px-3 py-2 text-sm">
                {turn.error}
              </p>
            )}

            {turn.answer?.status === 'not_in_video' && (
              <div className="rounded-lg border border-line bg-surface-raised px-3 py-3">
                <p className="text-sm font-medium">Not covered in this video</p>
                <p className="mt-1 text-sm text-muted">{turn.answer.message}</p>
              </div>
            )}

            {turn.answer?.status === 'unreadable' && (
              <p className="rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-muted">
                {turn.answer.message}
              </p>
            )}

            {turn.answer?.status === 'answered' &&
              turn.answer.claims.map((claim, j) => (
                <ReceiptCard
                  key={j}
                  text={claim.text}
                  lane={claim.lane}
                  receipt={claim.receipt}
                  verification={claim.verification}
                  onSeek={onSeek}
                />
              ))}

            {turn.answer && turn.answer.rejected.length > 0 && (
              <p className="px-1 text-xs text-muted">
                {turn.answer.rejected.length}{' '}
                {turn.answer.rejected.length === 1 ? 'claim was' : 'claims were'} dropped for citing
                evidence that is not in this transcript.
              </p>
            )}
          </div>
        ))}

        {pending && (
          <p className="px-2 text-sm text-muted" aria-live="polite">
            Reading the transcript…
          </p>
        )}
      </div>

      <form onSubmit={submit} className="border-t border-line p-3">
        {disabled ? (
          <p className="text-sm text-muted">{disabledReason ?? 'Questions are unavailable.'}</p>
        ) : (
          <div className="flex gap-2">
            <label htmlFor="question" className="sr-only">
              Ask about this video
            </label>
            <input
              id="question"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Ask about this video"
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm
                         placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={pending || value.trim().length === 0}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white
                         enabled:hover:brightness-110 disabled:opacity-45"
            >
              Ask
            </button>
          </div>
        )}
      </form>
    </div>
  )
}
