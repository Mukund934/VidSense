import { Skeleton } from '@/components/ui'

/**
 * Shown while the capability list and today's allowance are read.
 *
 * The allowance comes from Firestore, so this page waits on storage the same
 * way the history does. Three rows and three meters, in the shapes they will
 * arrive in.
 */
export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="mt-8" aria-label="Loading settings">
        <Skeleton className="h-4 w-40" />
        <ul className="mt-4 space-y-4 rounded-xl border border-line bg-surface-raised px-4 py-4">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3 w-1/2" />
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <Skeleton className="h-4 w-36" />
        <ul className="mt-4 space-y-5 rounded-xl border border-line bg-surface-raised px-4 py-5">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="mt-2 h-1.5 w-full" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
