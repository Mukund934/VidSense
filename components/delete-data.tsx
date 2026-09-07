'use client'

import { useState } from 'react'

type State = 'idle' | 'confirming' | 'working' | 'done' | 'failed'

/**
 * Delete my data.
 *
 * Two steps, because this is irreversible and a single click next to ordinary
 * settings controls is too easy to hit by accident. The confirmation says what
 * will go and what will not, rather than asking "are you sure?" about an
 * unspecified amount of destruction.
 */
export function DeleteData() {
  const [state, setState] = useState<State>('idle')
  const [count, setCount] = useState(0)

  async function run() {
    setState('working')
    try {
      const res = await fetch('/api/account', { method: 'DELETE' })
      if (!res.ok) throw new Error('failed')
      const body = (await res.json()) as { deleted?: number }
      setCount(body.deleted ?? 0)
      setState('done')
    } catch {
      setState('failed')
    }
  }

  if (state === 'done') {
    return (
      <p className="rounded-lg border border-exact/40 bg-exact-soft px-4 py-3 text-sm">
        Deleted. {count > 0 ? `${count} records removed.` : 'There was nothing stored.'}
      </p>
    )
  }

  return (
    <div>
      {state === 'confirming' ? (
        <div className="rounded-lg border border-approx/40 bg-approx-soft px-4 py-3">
          <p className="text-sm font-medium">This cannot be undone.</p>
          <p className="mt-1 text-sm">
            Your history, conversations, notes and bookmarks will be deleted. Transcripts that
            VidSense caches for everyone are not yours alone and stay — they contain nothing about
            you.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void run()}
              className="rounded-md bg-approx px-4 py-2 text-sm font-medium text-white hover:brightness-110"
            >
              Delete everything
            </button>
            <button
              type="button"
              onClick={() => setState('idle')}
              className="rounded-md border border-line px-4 py-2 text-sm font-medium"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={state === 'working'}
          onClick={() => setState('confirming')}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:border-approx disabled:opacity-50"
        >
          {state === 'working' ? 'Deleting…' : 'Delete my data'}
        </button>
      )}

      {state === 'failed' && (
        <p className="mt-2 text-sm text-approx">
          That did not work. Nothing was deleted — try again.
        </p>
      )}
    </div>
  )
}
