import { Skeleton } from '@/components/ui'

/**
 * Shown while the history is read from Firestore.
 *
 * This page is one of two that awaits storage before it can render anything,
 * so without this the browser sits on the previous page and the click appears
 * to have done nothing. The shapes match the rows that are coming, so the
 * layout does not jump when they arrive.
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Your videos</h1>
      <p className="mt-1 text-sm text-muted">
        Everything you have analysed. Reopening is instant — the work is already done.
      </p>

      <ul className="mt-8 space-y-2" aria-label="Loading your videos">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="rounded-lg border border-line bg-surface-raised p-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="mt-2 h-3 w-1/3" />
          </li>
        ))}
      </ul>
    </div>
  )
}
