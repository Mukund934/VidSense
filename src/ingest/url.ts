/**
 * YouTube URL parsing.
 *
 * The product's entire entry point is "paste a URL", so this has to accept every
 * shape a person might actually paste — including the ones with tracking junk,
 * a playlist attached, or a timestamp the user meant to keep — and reject
 * anything that is not a YouTube video without guessing.
 */

/** YouTube video IDs are 11 characters of URL-safe base64. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
])

/** Path prefixes that carry the video id as the next segment. */
const PATH_FORMS = ['shorts', 'embed', 'live', 'v', 'e']

export interface VideoRef {
  readonly videoId: string
  /** Start offset the user pasted, if any (`&t=90s`, `&t=1h2m3s`, `?start=90`). */
  readonly startMs?: number
  /** Playlist the link was in. Retained for context; never used to ingest a playlist. */
  readonly listId?: string
  /** Normalised watch URL — what we store and link back to. */
  readonly canonicalUrl: string
}

/**
 * Parse `t` / `start` values: bare seconds (`90`), suffixed seconds (`90s`), or
 * a compound duration (`1h2m3s`, `2m30s`). Returns null when unparseable, since
 * a wrong start offset is worse than none.
 */
export function parseTimeParam(value: string | null | undefined): number | null {
  if (!value) return null
  const raw = value.trim().toLowerCase()
  if (!raw) return null

  if (/^\d+$/.test(raw)) return Number(raw) * 1000

  const compound = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw)
  if (compound && (compound[1] ?? compound[2] ?? compound[3])) {
    const h = Number(compound[1] ?? 0)
    const m = Number(compound[2] ?? 0)
    const s = Number(compound[3] ?? 0)
    return (h * 3600 + m * 60 + s) * 1000
  }
  return null
}

function canonical(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

function build(videoId: string, startMs: number | null, listId: string | null): VideoRef {
  return {
    videoId,
    canonicalUrl: canonical(videoId),
    ...(startMs === null ? {} : { startMs }),
    ...(listId === null ? {} : { listId }),
  }
}

/**
 * Extract a video reference from anything a user might paste. Returns null rather
 * than throwing: an unparseable input is a normal UI state, not an exception.
 */
export function parseYouTubeUrl(input: string): VideoRef | null {
  const trimmed = input?.trim()
  if (!trimmed) return null

  // A bare video id, which people paste surprisingly often.
  if (VIDEO_ID.test(trimmed)) return build(trimmed, null, null)

  let url: URL
  try {
    // Tolerate a missing scheme: "youtube.com/watch?v=..." is a normal paste.
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase()
  if (!HOSTS.has(host)) return null

  const startMs = parseTimeParam(url.searchParams.get('t') ?? url.searchParams.get('start'))
  const listId = url.searchParams.get('list')
  const segments = url.pathname.split('/').filter(Boolean)

  // youtu.be/<id>
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = segments[0]
    return id && VIDEO_ID.test(id) ? build(id, startMs, listId) : null
  }

  // /watch?v=<id>
  if (segments[0] === 'watch') {
    const id = url.searchParams.get('v')
    return id && VIDEO_ID.test(id) ? build(id, startMs, listId) : null
  }

  // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>, /e/<id>
  if (segments[0] && PATH_FORMS.includes(segments[0])) {
    const id = segments[1]
    return id && VIDEO_ID.test(id) ? build(id, startMs, listId) : null
  }

  return null
}

/** True when the input names a specific video we could ingest. */
export function isVideoUrl(input: string): boolean {
  return parseYouTubeUrl(input) !== null
}
