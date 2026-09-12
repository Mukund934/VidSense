'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { formatTimestamp } from '@/domain/transcript'
import type { Annotation } from '@/data/annotations'
import { Button, EmptyState, Notice, SkeletonLines } from '@/components/ui'

/** Long enough for `vs-collapse` to finish; see `--dur-fast` in globals.css. */
const LEAVE_MS = 190

/**
 * The user's own marks on this video.
 *
 * These are the only timestamps in the product that are exact. A receipt's time
 * is derived from a model-written transcript and carries a tolerance; a mark's
 * time is the player's own position at the moment the button was pressed. So
 * this panel offers a plain jump with no precision caveat, and it is the one
 * place that is not overclaiming by doing so.
 */
export function MarksPanel({
  videoId,
  currentMs,
  onSeek,
}: {
  videoId: string
  currentMs: number
  onSeek: (ms: number) => void
}) {
  const [marks, setMarks] = useState<Annotation[]>([])
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])

  // A mark deleted just before the panel unmounts would otherwise set state
  // on a component that is gone.
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  useEffect(() => {
    let cancelled = false

    fetch(`/api/annotations?videoId=${encodeURIComponent(videoId)}`)
      .then(async (res) => {
        const body = (await res.json()) as { annotations?: Annotation[]; unavailable?: boolean }
        if (cancelled) return
        setMarks(body.annotations ?? [])
        setUnavailable(Boolean(body.unavailable))
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [videoId])

  const save = useCallback(
    async (kind: 'note' | 'bookmark', text: string) => {
      setSaving(true)
      setError(null)
      try {
        const res = await fetch('/api/annotations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, videoId, tMs: Math.round(currentMs), text }),
        })
        const body = (await res.json()) as { annotation?: Annotation; detail?: string }
        if (!res.ok || !body.annotation) {
          setError(body.detail ?? 'That mark could not be saved.')
          return
        }
        const saved = body.annotation
        setMarks((all) => [...all, saved].sort((a, b) => a.tMs - b.tMs))
        setDraft('')
      } catch {
        setError('That mark could not be saved.')
      } finally {
        setSaving(false)
      }
    },
    [currentMs, videoId],
  )

  /**
   * Delete, with the row collapsing rather than vanishing.
   *
   * The id is held in `leaving` while the animation runs, so the row stays
   * mounted and the list closes over the gap instead of the marks below it
   * jumping up under the cursor. The request goes out immediately — the
   * animation is for the reader, not a confirmation window.
   */
  const remove = useCallback(async (mark: Annotation) => {
    setLeaving((ids) => new Set(ids).add(mark.id))
    const request = fetch(
      `/api/annotations?id=${encodeURIComponent(mark.id)}&kind=${mark.kind}`,
      { method: 'DELETE' },
    ).catch(() => undefined)

    timers.current.push(
      setTimeout(() => {
        setMarks((all) => all.filter((m) => m.id !== mark.id))
        setLeaving((ids) => {
          const next = new Set(ids)
          next.delete(mark.id)
          return next
        })
      }, LEAVE_MS),
    )

    await request
  }, [])

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || saving) return
    void save('note', text)
  }

  if (unavailable) {
    return (
      <div className="p-4">
        <Notice tone="warn" title="Marks are unavailable">
          Saving notes and bookmarks needs storage, which this server has not been given. Everything
          else on this page still works.
        </Notice>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        <form onSubmit={onSubmit} className="flex gap-2">
          <label htmlFor="note-text" className="sr-only">
            Write a note at the current moment
          </label>
          <input
            id="note-text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Note at ${formatTimestamp(currentMs)}`}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm
                       transition-colors duration-[var(--dur-fast)]
                       placeholder:text-muted hover:border-line-strong
                       focus:border-accent focus:outline-none"
          />
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={draft.trim().length === 0}
          >
            Save
          </Button>
          <Button
            disabled={saving}
            onClick={() => void save('bookmark', draft.trim())}
            title="Mark this moment without writing anything"
          >
            Bookmark
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-approx">
            {error}
          </p>
        )}
      </div>

      {loading && (
        <div className="space-y-2.5 p-3" aria-label="Loading your marks">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-lg border border-line p-2.5">
              <SkeletonLines count={2} />
            </div>
          ))}
        </div>
      )}

      {!loading && marks.length === 0 && (
        <div className="p-4">
          <EmptyState title="Nothing marked yet">
            Bookmark a moment, or write a note against it. Unlike a citation, these land on the
            exact second — they come from the player, not the transcript.
          </EmptyState>
        </div>
      )}

      <ul className="vs-scroll flex-1 space-y-1.5 overflow-y-auto p-3">
        {marks.map((mark) => (
          <li
            key={`${mark.kind}-${mark.id}`}
            className={`group flex items-start gap-2 rounded-lg border border-line bg-surface-raised
                        p-2.5 transition-colors duration-[var(--dur-fast)] hover:border-line-strong
                        ${leaving.has(mark.id) ? 'vs-leaving' : 'vs-enter'}`}
          >
            <button
              type="button"
              onClick={() => onSeek(mark.tMs)}
              className="shrink-0 rounded font-mono text-xs text-accent tabular-nums underline
                         underline-offset-2 transition-colors duration-[var(--dur-instant)]
                         hover:text-accent-hover"
              aria-label={`Jump to ${formatTimestamp(mark.tMs)}`}
            >
              {formatTimestamp(mark.tMs)}
            </button>

            <p className="min-w-0 flex-1 break-words text-sm leading-relaxed">
              {mark.text || <span className="text-muted">Bookmarked moment</span>}
            </p>

            <button
              type="button"
              onClick={() => void remove(mark)}
              aria-label={`Delete mark at ${formatTimestamp(mark.tMs)}`}
              /* Always reachable by keyboard and on touch; it merely recedes
                 for a mouse until the row is approached. A control that is only
                 in the DOM on hover is one a screen reader cannot find. */
              className="shrink-0 rounded px-1 text-xs text-muted opacity-0 transition-opacity
                         duration-[var(--dur-fast)] hover:text-approx focus-visible:opacity-100
                         group-hover:opacity-100 max-sm:opacity-100"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
