import Link from 'next/link'
import { watchHistoryStore } from '@/lib/server/deps'
import { currentUid } from '@/lib/server/session'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 200

/**
 * Browse an imported watch history.
 *
 * VidSense holds a video id and a time watched, and nothing else — so this list
 * shows exactly that. Titles would mean fetching metadata for thousands of
 * videos, which is quota nobody agreed to spend; the title arrives when you
 * open one.
 */
export default async function WatchedPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  const { page } = await searchParams
  const store = watchHistoryStore()
  const history = store ? await store.load(await currentUid()).catch(() => null) : null

  const entries = history?.entries ?? []
  const pageNumber = Math.max(1, Number(page) || 1)
  const start = (pageNumber - 1) * PAGE_SIZE
  const shown = entries.slice(start, start + PAGE_SIZE)
  const hasMore = start + PAGE_SIZE < entries.length

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <Link href="/history" className="text-sm text-accent underline underline-offset-2">
        ← Your videos
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Watched on YouTube</h1>

      {entries.length === 0 ? (
        <div className="mt-8 rounded-xl border border-line bg-surface-raised px-6 py-10 text-center">
          <p className="font-medium">Nothing imported yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            Import a Takeout archive from your videos page and your history will appear here.
          </p>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">
            {entries.length.toLocaleString()} videos, most recent first. VidSense stored only the
            video and when you watched it — open one to analyse it.
          </p>

          <ol className="mt-6 space-y-1.5">
            {shown.map((entry) => (
              <li key={entry.videoId}>
                <Link
                  href={`/v/${entry.videoId}`}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface-raised p-2.5 hover:border-accent"
                >
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                    {new Date(entry.watchedAt).toISOString().slice(0, 10)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{entry.videoId}</span>
                  <span className="shrink-0 text-xs text-accent">Analyse</span>
                </Link>
              </li>
            ))}
          </ol>

          <nav className="mt-6 flex justify-between text-sm">
            {pageNumber > 1 ? (
              <Link href={`/history/watched?page=${pageNumber - 1}`} className="text-accent underline underline-offset-2">
                ← Newer
              </Link>
            ) : (
              <span />
            )}
            {hasMore && (
              <Link href={`/history/watched?page=${pageNumber + 1}`} className="text-accent underline underline-offset-2">
                Older →
              </Link>
            )}
          </nav>
        </>
      )}
    </div>
  )
}
