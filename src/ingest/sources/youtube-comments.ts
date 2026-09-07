/**
 * Public comments from the YouTube Data API.
 *
 * These feed the VIEWERS SAY lane, which is kept structurally separate from
 * what the video says. Conflating the two is the failure mode of every "AI
 * summary of a video" — a commenter's correction is not the creator's claim,
 * and an answer that blends them is wrong in a way the reader cannot see.
 *
 * Three constraints are enforced here rather than trusted to a caller:
 *
 *   1. **A sample, not a corpus.** Three pages, 300 comments, ordered by
 *      relevance. The dossier settled on this size; fetching more buys
 *      diminishing insight and spends quota that the ingest path needs.
 *   2. **A quota ceiling.** Paginating a popular video can cost thousands of
 *      units, and one popular URL should not consume half the daily budget.
 *      The ceiling is checked before every call, not after.
 *   3. **Comments are untrusted text.** Author names and bodies are sanitised
 *      at the boundary, because a comment is the easiest place in the product
 *      for a stranger to put an instruction.
 */

import { sanitiseUntrusted } from '@/domain/untrusted'

export interface HttpResponse {
  status: number
  ok: boolean
  text: string
}

export type HttpFn = (url: string) => Promise<HttpResponse>

export interface CommentsConfig {
  readonly apiKey: string | undefined
  readonly http?: HttpFn
  readonly baseUrl?: string
  /** Hard ceiling on quota units this call may spend. Per D13. */
  readonly maxQuotaUnits?: number
}

export interface CommentThread {
  readonly id: string
  readonly author: string
  readonly text: string
  readonly likeCount: number
  readonly publishedAt: string
  readonly replyCount: number
}

export type CommentsFailure =
  | 'not_configured'
  | 'disabled'
  | 'not_found'
  | 'quota_exceeded'
  | 'upstream_error'

export type CommentsResult =
  | {
      readonly ok: true
      readonly threads: readonly CommentThread[]
      readonly pagesFetched: number
      readonly quotaUnits: number
      /** True when more comments exist than the sample took. */
      readonly truncated: boolean
    }
  | { readonly ok: false; readonly reason: CommentsFailure; readonly detail?: string }

const DEFAULT_BASE = 'https://www.googleapis.com/youtube/v3'
/** Settled at 3 pages x 100 = 300 comments. */
export const MAX_PAGES = 3
export const PAGE_SIZE = 100
/** `commentThreads.list` costs 1 unit per call. */
const UNITS_PER_CALL = 1
export const DEFAULT_QUOTA_CEILING = 250

const defaultHttp: HttpFn = async (url) => {
  const res = await fetch(url)
  return { status: res.status, ok: res.ok, text: await res.text() }
}

interface ApiThread {
  id?: string
  snippet?: {
    totalReplyCount?: number
    topLevelComment?: {
      snippet?: {
        authorDisplayName?: string
        textOriginal?: string
        textDisplay?: string
        likeCount?: number
        publishedAt?: string
      }
    }
  }
}

/**
 * Distinguish "this video has comments turned off" from "something broke".
 *
 * They look identical at the HTTP layer — both are 403 — and they are entirely
 * different product states. Disabled comments are a normal video with a normal
 * empty panel; a quota failure is an outage that should not be dressed up as one.
 */
export function classifyError(status: number, body: string): CommentsFailure {
  const lower = body.toLowerCase()
  if (status === 403) {
    if (lower.includes('disabled comments') || lower.includes('commentsdisabled')) return 'disabled'
    if (lower.includes('quota')) return 'quota_exceeded'
    return 'upstream_error'
  }
  if (status === 404) return 'not_found'
  return 'upstream_error'
}

/** Map one API thread to our shape, sanitising every field a stranger wrote. */
export function toThread(raw: ApiThread): CommentThread | null {
  const top = raw.snippet?.topLevelComment?.snippet
  if (!top) return null
  const body = top.textOriginal ?? top.textDisplay ?? ''
  if (!body.trim()) return null

  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    author: sanitiseUntrusted(top.authorDisplayName ?? '').slice(0, 200),
    text: sanitiseUntrusted(body),
    likeCount: typeof top.likeCount === 'number' ? top.likeCount : 0,
    publishedAt: typeof top.publishedAt === 'string' ? top.publishedAt : '',
    replyCount: typeof raw.snippet?.totalReplyCount === 'number' ? raw.snippet.totalReplyCount : 0,
  }
}

export class YouTubeCommentsSource {
  constructor(private readonly config: CommentsConfig) {}

  async fetch(videoId: string): Promise<CommentsResult> {
    const { apiKey } = this.config
    if (!apiKey) return { ok: false, reason: 'not_configured', detail: 'no YouTube API key' }

    const base = this.config.baseUrl ?? DEFAULT_BASE
    const http = this.config.http ?? defaultHttp
    const ceiling = this.config.maxQuotaUnits ?? DEFAULT_QUOTA_CEILING

    const threads: CommentThread[] = []
    let pageToken: string | undefined
    let pages = 0
    let units = 0
    let truncated = false

    while (pages < MAX_PAGES) {
      // Checked before the call, so the ceiling is a limit rather than a report.
      if (units + UNITS_PER_CALL > ceiling) {
        truncated = true
        break
      }

      const params = new URLSearchParams({
        part: 'snippet',
        videoId,
        maxResults: String(PAGE_SIZE),
        order: 'relevance',
        textFormat: 'plainText',
        key: apiKey,
      })
      if (pageToken) params.set('pageToken', pageToken)

      let res: HttpResponse
      try {
        res = await http(`${base}/commentThreads?${params.toString()}`)
      } catch (err) {
        // A page that fails after others succeeded still leaves a usable sample.
        if (threads.length > 0) return done(threads, pages, units, true)
        return {
          ok: false,
          reason: 'upstream_error',
          detail: err instanceof Error ? err.message : String(err),
        }
      }

      units += UNITS_PER_CALL
      pages += 1

      if (!res.ok) {
        const reason = classifyError(res.status, res.text)
        if (threads.length > 0 && reason !== 'disabled') return done(threads, pages, units, true)
        return { ok: false, reason, detail: `HTTP ${res.status}` }
      }

      let payload: { items?: ApiThread[]; nextPageToken?: string }
      try {
        payload = JSON.parse(res.text) as typeof payload
      } catch {
        if (threads.length > 0) return done(threads, pages, units, true)
        return { ok: false, reason: 'upstream_error', detail: 'response was not JSON' }
      }

      for (const item of payload.items ?? []) {
        const thread = toThread(item)
        if (thread) threads.push(thread)
      }

      pageToken = payload.nextPageToken
      if (!pageToken) return done(threads, pages, units, false)
    }

    return done(threads, pages, units, truncated || pageToken !== undefined)
  }
}

function done(
  threads: readonly CommentThread[],
  pagesFetched: number,
  quotaUnits: number,
  truncated: boolean,
): CommentsResult {
  return { ok: true, threads, pagesFetched, quotaUnits, truncated }
}
