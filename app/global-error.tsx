'use client'

import { useEffect } from 'react'
import './globals.css'

/**
 * The root layout itself failed.
 *
 * This replaces the whole document, so it has to supply its own `<html>` and
 * `<body>` — and it cannot rely on anything the layout provides. It carries no
 * imports beyond the stylesheet for the same reason: whatever broke may be one
 * of them, and an error page that throws is worse than none.
 *
 * Almost unreachable in practice, which is exactly why it is written to survive
 * the case where nothing else did.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[vidsense] the root layout failed', error)
  }, [error])

  return (
    <html lang="en">
      <body className="grid min-h-dvh place-items-center px-4 text-center">
        <div>
          <h1 className="text-lg font-semibold">VidSense could not start</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
            The application failed before it could render anything. Your stored data is not
            affected.
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-6 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Try again
          </button>
          {error.digest && (
            <p className="mt-8 font-mono text-[11px] text-muted">Reference {error.digest}</p>
          )}
        </div>
      </body>
    </html>
  )
}
