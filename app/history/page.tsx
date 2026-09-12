import Link from 'next/link'
import { formatTimestamp } from '@/domain/transcript'
import { capabilities } from '@/lib/server/deps'
import { listHistory } from '@/lib/server/history'
import { currentUid } from '@/lib/server/session'
import { TakeoutImport } from '@/components/takeout-import'
import { EmptyState, Notice } from '@/components/ui'

export const dynamic = 'force-dynamic'

const STATUS_COPY: Record<string, string> = {
  degraded: 'Limited analysis',
  failed: 'Could not be read',
}

export default async function HistoryPage() {
  const uid = await currentUid()
  const entries = capabilities().firestore ? await listHistory(uid) : []

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Your videos</h1>
      <p className="mt-1 text-sm text-muted">
        Everything you have analysed. Reopening is instant — the work is already done.
      </p>

      {!capabilities().firestore && (
        <Notice tone="warn" className="mt-6">
          History needs Firestore, which this server has not been given. Analysis still works; it is
          just not remembered between restarts.
        </Notice>
      )}

      {capabilities().firestore && entries.length === 0 && (
        <div className="mt-10">
          <EmptyState
            title="Nothing here yet"
            action={
              <Link
                href="/"
                className="inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm
                           font-medium text-white shadow-raised transition-[background-color,box-shadow]
                           duration-[var(--dur-instant)] hover:bg-accent-hover hover:shadow-lifted"
              >
                Analyse a video
              </Link>
            }
          >
            Paste a YouTube link and it will show up here so you can come back to it.
          </EmptyState>
        </div>
      )}

      <ul className="vs-stagger mt-8 space-y-2">
        {entries.map((entry) => (
          <li key={entry.videoId}>
            <Link
              href={`/v/${entry.videoId}`}
              className="flex items-center gap-3 rounded-lg border border-line bg-surface-raised p-3
                         transition-[border-color,box-shadow] duration-[var(--dur-fast)]
                         hover:border-accent hover:shadow-lifted"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{entry.title ?? entry.videoId}</p>
                <p className="mt-0.5 truncate text-sm text-muted">
                  {entry.channelTitle}
                  {entry.durationSec ? ` · ${formatTimestamp(entry.durationSec * 1000)}` : ''}
                  {entry.openCount && entry.openCount > 1 ? ` · opened ${entry.openCount} times` : ''}
                </p>
              </div>
              {entry.status && STATUS_COPY[entry.status] && (
                <span className="shrink-0 rounded-full border border-approx/40 bg-approx-soft px-2 py-0.5 text-[11px] text-approx">
                  {STATUS_COPY[entry.status]}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>

      <TakeoutImport />
    </div>
  )
}
