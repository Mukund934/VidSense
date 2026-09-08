'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { formatTimestamp } from '@/domain/transcript'
import type { Annotation } from '@/data/annotations'

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

  const remove = useCallback(async (mark: Annotation) => {
    setMarks((all) => all.filter((m) => m.id !== mark.id))
    await fetch(`/api/annotations?id=${encodeURIComponent(mark.id)}&kind=${mark.kind}`, {
      method: 'DELETE',
    }).catch(() => undefined)
  }, [])

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || saving) return
    void save('note', text)
  }

  if (unavailable) {
    return (
      <div className="p-6">
        <p className="text-sm font-medium">Marks are unavailable</p>
        <p className="mt-1 text-sm text-muted">
          Saving notes and bookmarks needs storage, which this server has not been given. Everything
          else on this page still works.
        </p>
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
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm
                       placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={saving || draft.trim().length === 0}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white
                       enabled:hover:brightness-110 disabled:opacity-45"
          >
            Save
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save('bookmark', draft.trim())}
            title="Mark this moment without writing anything"
            className="rounded-md border border-line px-3 py-2 text-sm font-medium
                       enabled:hover:border-accent disabled:opacity-45"
          >
            Bookmark
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-approx">
            {error}
          </p>
        )}
      </div>

      {loading && <p className="p-6 text-sm text-muted">Loading your marks…</p>}

      {!loading && marks.length === 0 && (
        <div className="p-6">
          <p className="text-sm font-medium">Nothing marked yet</p>
          <p className="mt-1 text-sm text-muted">
            Bookmark a moment, or write a note against it. Unlike a citation, these land on the exact
            second — they come from the player, not the transcript.
          </p>
        </div>
      )}

      <ul className="vs-scroll flex-1 space-y-1.5 overflow-y-auto p-3">
        {marks.map((mark) => (
          <li
            key={`${mark.kind}-${mark.id}`}
            className="group flex items-start gap-2 rounded-lg border border-line bg-surface-raised p-2.5"
          >
            <button
              type="button"
              onClick={() => onSeek(mark.tMs)}
              className="shrink-0 rounded font-mono text-xs text-accent tabular-nums underline underline-offset-2"
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
              className="shrink-0 rounded px-1 text-xs text-muted hover:text-approx"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
