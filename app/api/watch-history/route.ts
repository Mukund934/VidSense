import { NextRequest } from 'next/server'

import { MAX_ENTRIES, type WatchEntry } from '@/ingest/takeout'
import { watchHistoryStore } from '@/lib/server/deps'
import { currentUid } from '@/lib/server/session'

export const runtime = 'nodejs'

/** Accept only what the parser is supposed to have kept, and nothing else. */
function clean(raw: unknown): WatchEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const entries: WatchEntry[] = []

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const videoId = typeof e.videoId === 'string' ? e.videoId : ''
    const watchedAt = Number(e.watchedAt)
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue
    if (!Number.isFinite(watchedAt) || watchedAt < 0) continue
    if (seen.has(videoId)) continue

    seen.add(videoId)
    entries.push({ videoId, watchedAt })
    if (entries.length >= MAX_ENTRIES) break
  }

  return entries
}

export async function GET(): Promise<Response> {
  const store = watchHistoryStore()
  if (!store) return Response.json({ history: null, unavailable: true })

  const uid = await currentUid()
  try {
    return Response.json({ history: await store.load(uid) })
  } catch {
    return Response.json({ history: null, unavailable: true })
  }
}

/**
 * Store an import.
 *
 * The body carries only video ids and timestamps: the file itself is parsed in
 * the browser and never uploaded, so the titles, searches and ad records it
 * contains do not reach this server at all. Anything that arrives here which is
 * not one of those two fields is discarded rather than trusted.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: { entries?: unknown; sourceTotal?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'Send a JSON body.' }, { status: 400 })
  }

  const entries = clean(body.entries)
  if (entries.length === 0) {
    return Response.json({ error: 'no_entries', detail: 'That import held no watched videos.' }, { status: 400 })
  }

  const store = watchHistoryStore()
  if (!store) {
    return Response.json(
      { error: 'unavailable', detail: 'Importing needs storage, which this server has not been given.' },
      { status: 503 },
    )
  }

  const sourceTotal = Number.isFinite(Number(body.sourceTotal))
    ? Math.max(entries.length, Math.round(Number(body.sourceTotal)))
    : entries.length

  const uid = await currentUid()
  try {
    await store.save(uid, entries, sourceTotal)
  } catch {
    return Response.json({ error: 'unavailable', detail: 'That import could not be saved.' }, { status: 503 })
  }

  return Response.json({ imported: entries.length }, { status: 201 })
}

export async function DELETE(): Promise<Response> {
  const store = watchHistoryStore()
  if (!store) return Response.json({ ok: true })

  const uid = await currentUid()
  try {
    await store.clear(uid)
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
  return Response.json({ ok: true })
}
