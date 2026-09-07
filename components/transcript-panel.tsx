'use client'

import { useMemo, useState } from 'react'
import { formatTimestamp, type TimedTranscript } from '@/domain/transcript'
import { precisionOf } from '@/domain/timing'
import { findMentions, timeSpentOn } from '@/retrieval/lexical'
import { PrecisionBadge } from '@/components/precision'

/**
 * The transcript, searchable and seekable.
 *
 * Search runs entirely in the browser over the transcript already loaded — no
 * request, no quota, no latency. It is also the one place a phrase spanning two
 * cues has to work, which is why `findMentions` flattens before matching.
 *
 * Clicking a line seeks the player, but only when the timing supports it. On an
 * unlocated transcript the lines stay readable and stop being buttons, because
 * a click that lands somewhere else is a worse answer than no click.
 */
export function TranscriptPanel({
  transcript,
  currentMs,
  onSeek,
}: {
  transcript: TimedTranscript
  currentMs: number
  onSeek: (ms: number) => void
}) {
  const [query, setQuery] = useState('')
  const seekable = precisionOf(transcript.timing) !== 'unlocated'

  const { matched, spentMs } = useMemo(() => {
    const q = query.trim()
    if (q.length < 2) return { matched: null, spentMs: 0 }
    const ranges = findMentions(transcript, q)
    const set = new Set<number>()
    for (const r of ranges) for (let i = r.cueStart; i <= r.cueEnd; i += 1) set.add(i)
    return { matched: set, spentMs: timeSpentOn(transcript, q) }
  }, [query, transcript])

  const activeIndex = transcript.cues.findIndex(
    (c) => c.startMs <= currentMs && c.endMs > currentMs,
  )

  const visible = matched
    ? transcript.cues.filter((c) => matched.has(c.i))
    : transcript.cues

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the transcript"
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm
                     placeholder:text-muted focus:border-accent focus:outline-none"
          aria-label="Search the transcript"
        />
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
          <span>
            {matched
              ? matched.size === 0
                ? 'No mentions'
                : `${matched.size} matching ${matched.size === 1 ? 'line' : 'lines'} · ${formatTimestamp(spentMs)} spent on it`
              : `${transcript.cues.length} lines`}
          </span>
          <PrecisionBadge timing={transcript.timing} />
        </div>
      </div>

      {!seekable && (
        <p className="border-b border-line bg-unlocated-soft px-3 py-2 text-xs text-muted">
          Timing for this transcript could not be established, so lines are not clickable. The words
          are still accurate.
        </p>
      )}

      <ol className="vs-scroll flex-1 overflow-y-auto p-1.5">
        {visible.length === 0 && (
          <li className="p-6 text-center text-sm text-muted">
            Nothing in this video matches “{query.trim()}”.
          </li>
        )}
        {visible.map((cue) => {
          const active = cue.i === activeIndex
          const body = (
            <>
              <span className="mr-2 font-mono text-[11px] text-muted tabular-nums">
                {formatTimestamp(cue.startMs)}
              </span>
              <span>{cue.text}</span>
            </>
          )
          return (
            <li key={cue.i}>
              {seekable ? (
                <button
                  type="button"
                  onClick={() => onSeek(cue.startMs)}
                  aria-current={active ? 'true' : undefined}
                  className={`w-full rounded px-2 py-1.5 text-left text-sm leading-relaxed transition-colors
                              hover:bg-accent-soft ${active ? 'bg-accent-soft' : ''}`}
                >
                  {body}
                </button>
              ) : (
                <p className={`px-2 py-1.5 text-sm leading-relaxed ${active ? 'bg-accent-soft' : ''}`}>
                  {body}
                </p>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
