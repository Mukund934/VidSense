'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { Button } from '@/components/ui'

/**
 * A route that threw.
 *
 * The message is deliberately not the error's. A thrown string can carry a
 * stack, a path or a fragment of a prompt, and in production Next replaces it
 * with a generic one anyway — so displaying it would show the developer a
 * detail and the user a lie. The digest is shown instead: it is the one thing
 * that ties what a user saw to what the server logged.
 *
 * Reset before reload, because a render fault is usually transient and losing
 * the page's state to fix it is a worse trade than trying again.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // The one place a client-side fault becomes visible at all. Without this it
    // exists only in a browser nobody is watching.
    console.error('[vidsense] render failed', error)
  }, [error])

  return (
    <div className="vs-enter mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-lg font-semibold">Something went wrong here</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        This page could not be rendered. Nothing you have saved is affected — history, notes and
        bookmarks are stored server-side and are untouched by this.
      </p>

      <div className="mt-6 flex justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Button onClick={() => window.location.reload()}>Reload the page</Button>
      </div>

      <p className="mt-6 text-sm">
        <Link href="/" className="text-accent underline underline-offset-2">
          Back to the start
        </Link>
      </p>

      {error.digest && (
        <p className="mt-8 font-mono text-[11px] text-muted">Reference {error.digest}</p>
      )}
    </div>
  )
}
