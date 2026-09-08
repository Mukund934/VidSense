/**
 * Google Takeout watch-history import.
 *
 * YouTube's API cannot give us a watch history — the `HL` playlist has returned
 * empty since 2016 — and the Data Portability API is EU, Switzerland and UK
 * only (D6), which excludes the owner's own market. Takeout is the path that
 * works everywhere, for everyone, with no OAuth and no compliance audit.
 *
 * ## What this deliberately throws away
 *
 * A `watch-history.json` is one of the most revealing files a person owns. It
 * holds every title they have watched, every search they have run, and every ad
 * they were shown, going back years. **VidSense keeps two fields per entry: a
 * video id and a timestamp.** Titles, channels, search queries and ad records
 * are dropped here and never leave the parser.
 *
 * That is also why the parser is pure and runs in the browser. The architecture
 * said "parsed server-side"; parsing on the client is strictly stronger for the
 * same goal, because the raw file then never leaves the device at all and only
 * the two retained fields are ever transmitted.
 *
 * ## What counts as "watched"
 *
 * A watch entry is one whose `titleUrl` parses as a YouTube video URL under the
 * same hardened parser the paste box uses. That single rule excludes searches
 * (they point at `/results`), channel visits, and anything on a host we do not
 * recognise, without needing to enumerate them. Ads are excluded separately:
 * being shown something is not watching it.
 */

import { parseYouTubeUrl } from '@/ingest/url'

export interface WatchEntry {
  readonly videoId: string
  /** Epoch milliseconds. */
  readonly watchedAt: number
}

export interface TakeoutStats {
  /** Entries in the file, of every kind. */
  readonly total: number
  /** Entries that named a real video. */
  readonly videos: number
  /** Entries dropped because they were searches or other non-video activity. */
  readonly notVideos: number
  /** Entries dropped because they were advertising. */
  readonly ads: number
  /** Repeat views collapsed into one entry each. */
  readonly duplicates: number
  /** Entries actually kept, after the cap. */
  readonly kept: number
}

export type TakeoutError = 'not_json' | 'html_export' | 'not_an_array' | 'no_watches'

export const TAKEOUT_MESSAGE: Record<TakeoutError, string> = {
  not_json: 'That file is not valid JSON. Pick watch-history.json from your Takeout archive.',
  html_export:
    'That is the HTML version of your history. Re-export from Takeout choosing JSON, which is a ' +
    'setting on the YouTube section.',
  not_an_array: 'That JSON is not a Takeout history file. Look for watch-history.json.',
  no_watches:
    'No watched videos were found in that file. It may be a search history rather than a watch history.',
}

export type TakeoutResult =
  | { readonly ok: true; readonly entries: WatchEntry[]; readonly stats: TakeoutStats }
  | { readonly ok: false; readonly reason: TakeoutError }

/**
 * How many watches to keep.
 *
 * Firestore's free tier allows 20,000 writes a day in total, across every user,
 * so one document per watched video would spend a year of history in a single
 * import. The list is stored as one compressed blob instead — the same decision
 * as transcripts, for the same arithmetic — and capped so it stays well inside
 * a document.
 */
export const MAX_ENTRIES = 5_000

interface TakeoutRecord {
  header?: unknown
  title?: unknown
  titleUrl?: unknown
  time?: unknown
  details?: unknown
  products?: unknown
}

/** Google marks advertising with a `details` entry naming Google Ads. */
function isAd(record: TakeoutRecord): boolean {
  if (!Array.isArray(record.details)) return false
  return record.details.some(
    (d) => typeof (d as { name?: unknown })?.name === 'string' &&
      /google ads/i.test((d as { name: string }).name),
  )
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function parseTakeout(text: string, limit = MAX_ENTRIES): TakeoutResult {
  const trimmed = text.trimStart()

  // Takeout offers HTML or JSON, and the HTML one is the default in some
  // flows. Saying which mistake was made is more useful than "invalid file".
  if (trimmed.startsWith('<')) return { ok: false, reason: 'html_export' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'not_json' }
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'not_an_array' }

  let videos = 0
  let notVideos = 0
  let ads = 0

  // Most recent watch wins for a repeated video, so the list reads like a
  // library rather than a log.
  const latest = new Map<string, number>()

  for (const item of parsed) {
    if (!item || typeof item !== 'object') {
      notVideos += 1
      continue
    }
    const record = item as TakeoutRecord

    if (isAd(record)) {
      ads += 1
      continue
    }

    // The same hardened parser the paste box uses. Searches point at
    // `/results`, channel visits at `/channel`, and neither survives it.
    const ref = typeof record.titleUrl === 'string' ? parseYouTubeUrl(record.titleUrl) : null
    const watchedAt = parseTime(record.time)
    if (!ref || watchedAt === null) {
      notVideos += 1
      continue
    }

    videos += 1
    const seen = latest.get(ref.videoId)
    if (seen === undefined || watchedAt > seen) latest.set(ref.videoId, watchedAt)
  }

  if (latest.size === 0) return { ok: false, reason: 'no_watches' }

  const entries = [...latest.entries()]
    .map(([videoId, watchedAt]) => ({ videoId, watchedAt }))
    .sort((a, b) => b.watchedAt - a.watchedAt)
    .slice(0, Math.max(0, limit))

  return {
    ok: true,
    entries,
    stats: {
      total: parsed.length,
      videos,
      notVideos,
      ads,
      duplicates: videos - latest.size,
      kept: entries.length,
    },
  }
}
