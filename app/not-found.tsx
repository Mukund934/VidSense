import Link from 'next/link'
import { AnalyzeForm } from '@/components/analyze-form'

/**
 * Nothing lives at this address.
 *
 * Reached most often from `/v/{id}` with a malformed id, which is why the paste
 * field is here rather than a bare apology: the user was trying to open a video
 * and the fastest route back is the one they were already on.
 */
export default function NotFound() {
  return (
    <div className="vs-enter mx-auto max-w-xl px-4 py-24 sm:px-6">
      <p className="font-mono text-xs tracking-wide text-muted">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">There is nothing here</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        That address does not match a page, or the video id in it is not one YouTube could use.
        Paste a link and VidSense will open it.
      </p>

      <div className="mt-6">
        <AnalyzeForm />
      </div>

      <p className="mt-8 text-sm text-muted">
        Or go to{' '}
        <Link href="/history" className="text-accent underline underline-offset-2">
          your videos
        </Link>
        .
      </p>
    </div>
  )
}
