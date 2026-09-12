import { timingSafeEqual } from 'node:crypto'

import { FirestoreRetentionStore, SWEEP_LIMIT, sweepExpired } from '@/data/retention'
import { firestore } from '@/lib/server/deps'
import { describeError, log } from '@/lib/server/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Delete the video knowledge whose retention window has closed.
 *
 * `expiresAt` has always been honoured on read; this is what makes it true on
 * disk. See `src/data/retention.ts` for why it is application code rather than
 * a Firestore TTL policy.
 *
 * Called on a schedule — `vercel.json` runs it daily — and reachable by hand
 * with the same header, so an operator can drain a backlog without waiting for
 * midnight. `GET` because that is what a cron scheduler sends; it is a mutation
 * behind an authorisation header rather than a read, which is why nothing links
 * to it and `robots.txt` disallows the whole of `/api`.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    // Refuse rather than run. An unauthenticated endpoint that deletes data is
    // worse than a retention sweep that has not been configured yet, and a
    // 503 here is loud enough to be noticed on the first scheduled run.
    return Response.json(
      { error: 'not_configured', detail: 'CRON_SECRET is not set on this deployment.' },
      { status: 503 },
    )
  }

  if (!authorised(request.headers.get('authorization'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const db = firestore()
  if (!db) {
    return Response.json({ error: 'no_storage', detail: 'Firestore is not configured.' }, { status: 503 })
  }

  const started = Date.now()
  try {
    const report = await sweepExpired(new FirestoreRetentionStore(db), started, SWEEP_LIMIT)
    log.info('retention.sweep', { ...report, ms: Date.now() - started })
    return Response.json(report)
  } catch (err) {
    log.error('retention.sweep_failed', { detail: describeError(err) })
    return Response.json({ error: 'sweep_failed' }, { status: 500 })
  }
}

/**
 * Compare in constant time.
 *
 * A `===` on a secret leaks its prefix through timing, and this endpoint is
 * reachable by anyone who can guess the path. The length check comes first
 * because `timingSafeEqual` throws on a mismatch, which would leak the length
 * through an exception instead.
 */
function authorised(header: string | null, secret: string): boolean {
  const offered = header?.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(offered)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}
