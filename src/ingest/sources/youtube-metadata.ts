/**
 * Video metadata from the YouTube Data API.
 *
 * One `videos.list` call costs 1 quota unit against a 10,000/day default, so this
 * is the cheapest call in the system and the one that decides whether the
 * expensive calls happen at all: it detects livestreams, private and removed
 * videos before any provider is paid.
 *
 * `search.list` is deliberately never used — it costs 100 units, which would make
 * a routine product loop consume the daily quota in 100 requests.
 */

import type { VideoMetadata } from '@/data/schema'
import type { MetadataResult, MetadataSource } from '@/ingest/ports'

export interface HttpResponse {
  status: number
  ok: boolean
  text: string
}

export type HttpFn = (url: string) => Promise<HttpResponse>

export interface YouTubeConfig {
  readonly apiKey: string | undefined
  readonly http?: HttpFn
  readonly baseUrl?: string
}

const DEFAULT_BASE = 'https://www.googleapis.com/youtube/v3'
const PARTS = 'snippet,contentDetails,status,liveStreamingDetails'

const defaultHttp: HttpFn = async (url) => {
  const res = await fetch(url)
  return { status: res.status, ok: res.ok, text: await res.text() }
}

/** Parse an ISO 8601 duration (`PT2H15M30S`) into seconds. */
export function parseIsoDuration(value: unknown): number {
  if (typeof value !== 'string') return 0
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value.trim())
  if (!m) return 0
  const d = Number(m[1] ?? 0)
  const h = Number(m[2] ?? 0)
  const min = Number(m[3] ?? 0)
  const s = Number(m[4] ?? 0)
  return ((d * 24 + h) * 60 + min) * 60 + s
}

/** Pick the largest available thumbnail. */
function bestThumbnail(thumbs: unknown): string | undefined {
  if (!thumbs || typeof thumbs !== 'object') return undefined
  const record = thumbs as Record<string, { url?: string } | undefined>
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = record[size]?.url
    if (typeof url === 'string') return url
  }
  return undefined
}

interface ApiItem {
  snippet?: {
    title?: string
    channelId?: string
    channelTitle?: string
    publishedAt?: string
    thumbnails?: unknown
    liveBroadcastContent?: string
  }
  contentDetails?: { duration?: string; regionRestriction?: { blocked?: string[] } }
  status?: { privacyStatus?: string; uploadStatus?: string }
  liveStreamingDetails?: { actualEndTime?: string }
}

/**
 * Decide whether this video can be ingested at all.
 *
 * A finished livestream is a normal video — only one still live or not yet
 * started is refused, so `liveStreamingDetails.actualEndTime` matters.
 */
export function classifyItem(item: ApiItem): MetadataResult {
  const snippet = item.snippet ?? {}
  const live = snippet.liveBroadcastContent

  if (live === 'upcoming') return { ok: false, reason: 'upcoming' }
  if (live === 'live' && !item.liveStreamingDetails?.actualEndTime) {
    return { ok: false, reason: 'live' }
  }

  const privacy = item.status?.privacyStatus
  if (privacy === 'private') return { ok: false, reason: 'unavailable', detail: 'private' }

  const upload = item.status?.uploadStatus
  if (upload === 'rejected' || upload === 'deleted' || upload === 'failed') {
    return { ok: false, reason: 'unavailable', detail: `uploadStatus=${upload}` }
  }

  const metadata: VideoMetadata = {
    title: snippet.title ?? '',
    channelId: snippet.channelId ?? '',
    channelTitle: snippet.channelTitle ?? '',
    publishedAt: snippet.publishedAt ?? '',
    durationSec: parseIsoDuration(item.contentDetails?.duration),
    ...(bestThumbnail(snippet.thumbnails) ? { thumbnailUrl: bestThumbnail(snippet.thumbnails)! } : {}),
  }

  return { ok: true, metadata, availability: privacy === 'unlisted' ? 'unlisted' : 'public' }
}

export class YouTubeMetadataSource implements MetadataSource {
  constructor(private readonly config: YouTubeConfig) {}

  async fetch(videoId: string): Promise<MetadataResult> {
    const { apiKey } = this.config
    if (!apiKey) return { ok: false, reason: 'error', detail: 'no YouTube API key' }

    const base = this.config.baseUrl ?? DEFAULT_BASE
    const http = this.config.http ?? defaultHttp
    const url = `${base}/videos?part=${PARTS}&id=${encodeURIComponent(videoId)}&key=${apiKey}`

    let res: HttpResponse
    try {
      res = await http(url)
    } catch (err) {
      return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) }
    }

    if (res.status === 403) {
      // Quota exhaustion and a bad key both land here; the distinction matters
      // operationally, so surface the body rather than flattening it.
      return { ok: false, reason: 'error', detail: `HTTP 403: ${res.text.slice(0, 200)}` }
    }
    if (!res.ok) return { ok: false, reason: 'error', detail: `HTTP ${res.status}` }

    let payload: { items?: ApiItem[] }
    try {
      payload = JSON.parse(res.text) as { items?: ApiItem[] }
    } catch {
      return { ok: false, reason: 'error', detail: 'response was not JSON' }
    }

    const item = payload.items?.[0]
    // An empty items array is how the API reports a video that is private,
    // deleted, or never existed. They are indistinguishable from here.
    if (!item) return { ok: false, reason: 'not_found' }

    return classifyItem(item)
  }
}
