'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
 *
 * The panel follows the player by default and stops the moment the reader
 * scrolls. Following is what a transcript is *for* while a video plays; taking
 * the scrollbar back off someone who is reading ahead is the fastest way to
 * make a good feature intolerable, so the override is permanent until they ask
 * for it back.
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
  const [following, setFollowing] = useState(true)
  const seekable = precisionOf(transcript.timing) !== 'unlocated'

  const list = useRef<HTMLOListElement>(null)
  const activeLine = useRef<HTMLLIElement>(null)
  const search = useRef<HTMLInputElement>(null)
  /** Set while we scroll the list ourselves, so the handler ignores its own work. */
  const programmatic = useRef(false)

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

  const visible = matched ? transcript.cues.filter((c) => matched.has(c.i)) : transcript.cues

  const scrollToActive = useCallback((behavior: ScrollBehavior) => {
    const line = activeLine.current
    if (!line) return
    programmatic.current = true
    line.scrollIntoView({ block: 'center', behavior })
    // Long enough for a smooth scroll to finish emitting events, short enough
    // that a real scroll straight afterwards is still noticed.
    setTimeout(() => {
      programmatic.current = false
    }, 400)
  }, [])

  // Follow the player. Searching suspends it: the reader is looking at a
  // filtered list and moving it under them would be nonsense.
  useEffect(() => {
    if (!following || matched) return
    scrollToActive('smooth')
  }, [activeIndex, following, matched, scrollToActive])

  const onScroll = useCallback(() => {
    if (programmatic.current) return
    setFollowing(false)
  }, [])

  // `/` focuses the search the way it does in every reader; Escape clears it.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (event.key === '/' && !typing) {
        event.preventDefault()
        search.current?.focus()
      }
      if (event.key === 'Escape' && target === search.current) setQuery('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <input
          ref={search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the transcript"
          type="search"
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm
                     transition-colors duration-[var(--dur-fast)]
                     placeholder:text-muted hover:border-line-strong
                     focus:border-accent focus:outline-none"
          aria-label="Search the transcript"
        />
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
          <span aria-live="polite">
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

      <div className="relative min-h-0 flex-1">
        <ol
          ref={list}
          onScroll={onScroll}
          className="vs-scroll h-full overflow-y-auto p-1.5"
        >
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
                <Highlighted text={cue.text} term={matched ? query.trim() : ''} />
              </>
            )
            return (
              <li key={cue.i} ref={active ? activeLine : undefined}>
                {seekable ? (
                  <button
                    type="button"
                    onClick={() => onSeek(cue.startMs)}
                    aria-current={active ? 'true' : undefined}
                    className={`w-full rounded px-2 py-1.5 text-left text-sm leading-relaxed
                                transition-colors duration-[var(--dur-instant)] hover:bg-accent-soft
                                ${active ? 'bg-accent-soft' : ''}`}
                  >
                    {body}
                  </button>
                ) : (
                  <p
                    className={`px-2 py-1.5 text-sm leading-relaxed ${active ? 'bg-accent-soft' : ''}`}
                  >
                    {body}
                  </p>
                )}
              </li>
            )
          })}
        </ol>

        {/* Only offered when it would do something: there is a line to go to,
            and the reader has scrolled away from it. */}
        {!following && !matched && activeIndex >= 0 && (
          <button
            type="button"
            onClick={() => {
              setFollowing(true)
              scrollToActive('smooth')
            }}
            className="vs-enter absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border
                       border-line bg-surface-raised px-3 py-1.5 text-xs font-medium shadow-lifted
                       transition-colors duration-[var(--dur-instant)] hover:border-accent"
          >
            Follow the player
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The searched phrase, marked inside the line.
 *
 * Only the literal phrase, and only where a cue contains the whole of it. A
 * phrase that spans two cues still lists both lines — `findMentions` matched it
 * across the boundary — but neither gets a highlight, because highlighting half
 * a phrase suggests the other half is somewhere else on the line.
 */
function Highlighted({ text, term }: { text: string; term: string }) {
  if (term.length < 2) return <span>{text}</span>

  const lower = text.toLowerCase()
  const needle = term.toLowerCase()
  const parts: Array<{ text: string; hit: boolean }> = []

  let cursor = 0
  for (;;) {
    const at = lower.indexOf(needle, cursor)
    if (at === -1) break
    if (at > cursor) parts.push({ text: text.slice(cursor, at), hit: false })
    parts.push({ text: text.slice(at, at + term.length), hit: true })
    cursor = at + term.length
  }
  if (parts.length === 0) return <span>{text}</span>
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false })

  return (
    <span>
      {parts.map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-sm bg-approx-soft px-0.5 text-ink">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  )
}
