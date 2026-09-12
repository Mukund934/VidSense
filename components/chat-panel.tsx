'use client'

import { useState, type FormEvent } from 'react'
import type { Answer } from '@/answer/contract'
import { ReceiptCard } from '@/components/receipt'
import { Button, Thinking } from '@/components/ui'

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

const SUGGESTIONS = [
  'What is the main argument?',
  'Where is it first explained?',
  'What does it say about the cost?',
]

export function ChatPanel({
  turns,
  pending,
  onAsk,
  onSeek,
  videoId,
  title,
  disabled,
  disabledReason,
}: {
  turns: readonly Turn[]
  pending: boolean
  onAsk: (question: string) => void
  onSeek: (ms: number) => void
  videoId?: string
  title?: string
  disabled?: boolean
  disabledReason?: string
}) {
  const [value, setValue] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    ask(value)
  }

  function ask(question: string) {
    const q = question.trim()
    if (!q || pending || disabled) return
    onAsk(q)
    setValue('')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="vs-scroll flex-1 space-y-5 overflow-y-auto p-3">
        {turns.length === 0 && !pending && (
          <div className="vs-enter px-2 py-8 text-sm text-muted">
            <p className="font-medium text-ink">Ask about this video.</p>
            {/* Clickable rather than illustrative: the first question is the
                hardest one to type, and these are the shapes that work. */}
            <ul className="mt-3 flex flex-col items-start gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => ask(suggestion)}
                    className="rounded-md px-2 py-1 text-left transition-colors duration-[var(--dur-instant)]
                               enabled:hover:bg-accent-soft enabled:hover:text-ink disabled:opacity-60"
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-4 px-2 text-xs">
              Answers cite the transcript. If the video does not cover something, VidSense says so
              rather than filling the gap.
            </p>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className="space-y-2.5">
            <p className="vs-enter rounded-lg bg-accent-soft px-3 py-2 text-sm font-medium">
              {turn.question}
            </p>

            {turn.error && (
              <p
                role="alert"
                className="vs-enter rounded-lg border border-approx/40 bg-approx-soft px-3 py-2 text-sm"
              >
                {turn.error}
              </p>
            )}

            {turn.answer?.status === 'not_in_video' && (
              <div className="vs-enter rounded-lg border border-line bg-surface-raised px-3 py-3">
                <p className="text-sm font-medium">Not covered in this video</p>
                <p className="mt-1 text-sm text-muted">{turn.answer.message}</p>
              </div>
            )}

            {turn.answer?.status === 'unreadable' && (
              <p className="vs-enter rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-muted">
                {turn.answer.message}
              </p>
            )}

            {turn.answer?.status === 'answered' && (
              <div className="vs-stagger space-y-2.5">
                {turn.answer.claims.map((claim, j) => (
                  <ReceiptCard
                    key={j}
                    text={claim.text}
                    lane={claim.lane}
                    receipt={claim.receipt}
                    verification={claim.verification}
                    {...(videoId ? { videoId } : {})}
                    {...(title ? { title } : {})}
                    onSeek={onSeek}
                  />
                ))}
              </div>
            )}

            {turn.answer && turn.answer.rejected.length > 0 && (
              <p className="px-1 text-xs text-muted">
                {turn.answer.rejected.length}{' '}
                {turn.answer.rejected.length === 1 ? 'claim was' : 'claims were'} dropped for citing
                evidence that is not in this transcript.
              </p>
            )}
          </div>
        ))}

        {pending && <Thinking />}
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
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm
                         transition-colors duration-[var(--dur-fast)]
                         placeholder:text-muted hover:border-line-strong
                         focus:border-accent focus:outline-none"
            />
            <Button
              type="submit"
              variant="primary"
              loading={pending}
              disabled={value.trim().length === 0}
            >
              Ask
            </Button>
          </div>
        )}
      </form>
    </div>
  )
}
