'use client'

import { useState } from 'react'
import { Button, Notice } from '@/components/ui'

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
      <Notice tone="good" assertive>
        Deleted. {count > 0 ? `${count} records removed.` : 'There was nothing stored.'}
      </Notice>
    )
  }

  return (
    <div>
      {/* The panel stays up while the delete runs. Swapping back to a disabled
          "Delete my data" mid-flight would read as though the confirmation had
          been dismissed and nothing was happening. */}
      {state === 'confirming' || state === 'working' ? (
        <Notice tone="warn" title="This cannot be undone." assertive>
          <p>
            Your history, conversations, notes and bookmarks will be deleted. Transcripts that
            VidSense caches for everyone are not yours alone and stay — they contain nothing about
            you.
          </p>
          <div className="mt-3 flex gap-2">
            {/* The destructive option is not the primary one. It is reachable in
                one click and does not look like the button you meant to press. */}
            <Button
              variant="danger"
              loading={state === 'working'}
              loadingLabel="Deleting"
              onClick={() => void run()}
            >
              Delete everything
            </Button>
            <Button disabled={state === 'working'} onClick={() => setState('idle')}>
              Keep it
            </Button>
          </div>
        </Notice>
      ) : (
        <Button onClick={() => setState('confirming')} className="hover:border-approx">
          Delete my data
        </Button>
      )}

      {state === 'failed' && (
        <p role="alert" className="vs-enter mt-2 text-sm text-approx">
          That did not work. Nothing was deleted — try again.
        </p>
      )}
    </div>
  )
}
