'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { parseYouTubeUrl } from '@/ingest/url'

/**
 * The product's entire entry point.
 *
 * Validation happens here rather than after a round trip: a typo should be
 * corrected in the field the user is already looking at, not on a page they
 * had to wait for.
 */
export function AnalyzeForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const ref = parseYouTubeUrl(value)
    if (!ref) {
      setError('That does not look like a YouTube video link. Paste a watch, share or Shorts URL.')
      return
    }
    setError(null)
    setPending(true)
    router.push(`/v/${ref.videoId}`)
  }

  return (
    <form onSubmit={onSubmit} className="w-full">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="video-url" className="sr-only">
          YouTube video link
        </label>
        <input
          id="video-url"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- it is the only field on the page
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          placeholder="Paste a YouTube link"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'video-url-error' : undefined}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface-raised px-4 py-3 text-base
                     placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending || value.trim().length === 0}
          className="rounded-lg bg-accent px-5 py-3 font-medium text-white transition
                     enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {pending ? 'Opening…' : 'Understand it'}
        </button>
      </div>

      {error && (
        <p id="video-url-error" role="alert" className="mt-2 text-sm text-approx">
          {error}
        </p>
      )}
    </form>
  )
}
