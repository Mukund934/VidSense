'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { TAKEOUT_MESSAGE, parseTakeout, type TakeoutStats, type WatchEntry } from '@/ingest/takeout'

/**
 * Import a Google Takeout watch history.
 *
 * **The file is read and parsed here, in the browser, and never uploaded.** A
 * `watch-history.json` holds every title a person has watched, every search
 * they have run and every ad they were shown, going back years. Only the two
 * fields VidSense keeps — a video id and a timestamp — are sent anywhere, and
 * the UI says so before asking for the file rather than after.
 */

interface Imported {
  readonly entries: WatchEntry[]
  readonly importedAt: number
  readonly sourceTotal: number
}

type Status =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'saving'; stats: TakeoutStats }
  | { kind: 'done'; stats: TakeoutStats }
  | { kind: 'error'; message: string }

/** A file this large is not a watch history; refusing early beats an out-of-memory tab. */
const MAX_FILE_BYTES = 200 * 1024 * 1024

export function TakeoutImport() {
  const input = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [existing, setExisting] = useState<Imported | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/watch-history')
      .then(async (res) => {
        const body = (await res.json()) as { history?: Imported | null; unavailable?: boolean }
        if (cancelled) return
        setExisting(body.history ?? null)
        setUnavailable(Boolean(body.unavailable))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const onFile = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      setStatus({
        kind: 'error',
        message: 'That file is larger than VidSense can read in a browser tab.',
      })
      return
    }

    setStatus({ kind: 'reading' })
    let text: string
    try {
      text = await file.text()
    } catch {
      setStatus({ kind: 'error', message: 'That file could not be read.' })
      return
    }

    const parsed = parseTakeout(text)
    if (!parsed.ok) {
      setStatus({ kind: 'error', message: TAKEOUT_MESSAGE[parsed.reason] })
      return
    }

    setStatus({ kind: 'saving', stats: parsed.stats })
    try {
      const res = await fetch('/api/watch-history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Only ids and timestamps. The file stays on this machine.
        body: JSON.stringify({ entries: parsed.entries, sourceTotal: parsed.stats.total }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string }
        setStatus({ kind: 'error', message: body.detail ?? 'That import could not be saved.' })
        return
      }
      setStatus({ kind: 'done', stats: parsed.stats })
      setExisting({
        entries: parsed.entries,
        importedAt: Date.now(),
        sourceTotal: parsed.stats.total,
      })
    } catch {
      setStatus({ kind: 'error', message: 'That import could not be saved.' })
    }
  }, [])

  const forget = useCallback(async () => {
    await fetch('/api/watch-history', { method: 'DELETE' }).catch(() => undefined)
    setExisting(null)
    setStatus({ kind: 'idle' })
  }, [])

  if (unavailable) return null

  return (
    <section className="mt-10 rounded-xl border border-line bg-surface-raised p-5">
      <h2 className="font-medium">Bring your YouTube history</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        YouTube offers no API for your watch history, so the way in is{' '}
        <a
          href="https://takeout.google.com/"
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2"
        >
          Google Takeout
        </a>
        : select YouTube, choose <strong className="font-medium text-ink">history</strong> in JSON
        format, and pick <code className="font-mono text-xs">watch-history.json</code> from the
        archive.
      </p>

      <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">
        <strong className="font-medium text-ink">The file stays on this device.</strong> It is read
        and filtered in your browser; only video ids and the times you watched them are sent.
        Titles, searches and adverts never leave your machine.
      </p>

      {existing && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
          <p className="text-sm">
            <strong className="font-medium">{existing.entries.length.toLocaleString()}</strong>{' '}
            videos imported
            {existing.importedAt > 0 && (
              <> on {new Date(existing.importedAt).toISOString().slice(0, 10)}</>
            )}
          </p>
          <div className="flex gap-2">
            <Link
              href="/history/watched"
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:border-accent"
            >
              Browse
            </Link>
            <button
              type="button"
              onClick={() => void forget()}
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:border-approx"
            >
              Forget it
            </button>
          </div>
        </div>
      )}

      <div className="mt-4">
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onFile(file)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={status.kind === 'reading' || status.kind === 'saving'}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white
                     enabled:hover:brightness-110 disabled:opacity-45"
        >
          {status.kind === 'reading'
            ? 'Reading…'
            : status.kind === 'saving'
              ? 'Saving…'
              : existing
                ? 'Import a newer file'
                : 'Choose watch-history.json'}
        </button>
      </div>

      {status.kind === 'error' && (
        <p role="alert" className="mt-3 text-sm text-approx">
          {status.message}
        </p>
      )}

      {status.kind === 'done' && (
        <p className="mt-3 text-sm text-exact">
          Imported {status.stats.kept.toLocaleString()} videos from{' '}
          {status.stats.total.toLocaleString()} history entries
          {status.stats.duplicates > 0 && <>, collapsing {status.stats.duplicates.toLocaleString()} repeat views</>}
          {status.stats.ads > 0 && <> and skipping {status.stats.ads.toLocaleString()} adverts</>}.
        </p>
      )}
    </section>
  )
}
