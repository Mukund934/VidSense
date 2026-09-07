'use client'

import { useEffect, useState } from 'react'
import type { CommentThread } from '@/ingest/sources/youtube-comments'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; threads: CommentThread[]; truncated: boolean }
  | { kind: 'empty'; reason: string }

const REASON_COPY: Record<string, string> = {
  disabled: 'The creator has turned comments off for this video.',
  not_found: 'This video has no comments we can reach.',
  quota_exceeded: "VidSense has used its daily YouTube allowance. Comments will be back tomorrow.",
  not_configured: 'Comments need a YouTube API key, which this server does not have.',
  upstream_error: 'Comments could not be loaded just now.',
}

/**
 * What viewers said — kept in its own lane, never mixed into what the video said.
 */
export function ViewersPanel({ videoId }: { videoId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })

    fetch(`/api/comments?videoId=${encodeURIComponent(videoId)}`)
      .then(async (res) => {
        const body = (await res.json()) as {
          threads?: CommentThread[]
          truncated?: boolean
          reason?: string
        }
        if (cancelled) return
        if (body.threads) {
          setState({ kind: 'ready', threads: body.threads, truncated: Boolean(body.truncated) })
        } else {
          setState({ kind: 'empty', reason: body.reason ?? 'upstream_error' })
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'empty', reason: 'upstream_error' })
      })

    return () => {
      cancelled = true
    }
  }, [videoId])

  if (state.kind === 'loading') {
    return <p className="p-6 text-sm text-muted">Loading what viewers said…</p>
  }

  if (state.kind === 'empty') {
    return (
      <div className="p-6">
        <p className="text-sm font-medium">No viewer comments</p>
        <p className="mt-1 text-sm text-muted">{REASON_COPY[state.reason] ?? REASON_COPY.upstream_error}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <p className="border-b border-line px-3 py-2 text-xs text-muted">
        A relevance-ranked sample of {state.threads.length}. This is what{' '}
        <strong className="font-medium text-ink">viewers</strong> said — not what the video says.
      </p>
      <ul className="vs-scroll flex-1 space-y-2 overflow-y-auto p-3">
        {state.threads.map((thread) => (
          <li key={thread.id} className="rounded-lg border border-line bg-surface-raised p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium">{thread.author || 'A viewer'}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {thread.likeCount.toLocaleString()} likes
              </span>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
              {thread.text}
            </p>
            {thread.replyCount > 0 && (
              <p className="mt-1.5 text-xs text-muted">
                {thread.replyCount} {thread.replyCount === 1 ? 'reply' : 'replies'}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
