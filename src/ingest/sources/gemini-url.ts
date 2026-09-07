/**
 * Gemini YouTube-URL transcript source.
 *
 * The primary supply route, and the product's single largest dependency: a
 * preview feature owned by a competitor. Two consequences are designed in here.
 *
 * First, this adapter is replaceable — nothing above `TranscriptSource` knows it
 * exists. Second, it takes its HTTP function by injection, so the whole failure
 * surface is testable without a key, a network, or a quota unit.
 *
 * We never ask the model for timestamps we then trust blindly: cues are ordered
 * and validated here, and `resolveReceipt` resolves evidence by cue index later.
 */

import { buildTranscript } from '@/domain/transcript'
import type { FetchResult, TranscriptSource, VideoInput } from '@/ingest/source'

export interface HttpResponse {
  status: number
  ok: boolean
  text: string
}

export type HttpFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<HttpResponse>

export interface GeminiConfig {
  readonly apiKey: string | undefined
  readonly model?: string
  readonly http?: HttpFn
  readonly baseUrl?: string
}

/**
 * Verified against the live model list on 2026-09-07. The previous default,
 * `gemini-2.5-flash`, returns HTTP 404 — "no longer available to new users" —
 * so it was not a fallback, it was an outage.
 *
 * Flash-Lite is the cheapest tier that accepts a YouTube URL, which §25.1 also
 * picked for transcript build. Injectable, because this line has a shelf life.
 */
const DEFAULT_MODEL = 'gemini-3.5-flash-lite'
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta'

const PROMPT =
  'Transcribe this video completely. Return ONLY a JSON array of objects with keys ' +
  '"t" (start time in whole seconds, integer) and "text" (the words spoken in that segment). ' +
  'Segment at natural sentence boundaries. Do not summarise, do not translate, do not add commentary.'

interface RawCue {
  t: unknown
  text: unknown
}

const defaultHttp: HttpFn = async (url, init) => {
  const res = await fetch(url, init)
  return { status: res.status, ok: res.ok, text: await res.text() }
}

/**
 * Map a provider response to a chain-level reason.
 *
 * The distinction that matters: `not_configured` and `rate_limited` are about us,
 * so the chain should try the next source; `video_unavailable` is about the video,
 * so the chain should stop. Collapsing these into one error loses that.
 */
export function classifyStatus(status: number, body: string): FetchResult & { ok: false } {
  const lower = body.toLowerCase()

  if (status === 401 || status === 403) {
    const keyProblem = lower.includes('api key') || lower.includes('unauthenticated') || lower.includes('permission')
    return {
      ok: false,
      reason: keyProblem ? 'not_configured' : 'video_unavailable',
      detail: `HTTP ${status}: ${body.slice(0, 200)}`,
    }
  }
  if (status === 429) return { ok: false, reason: 'rate_limited', detail: `HTTP ${status}` }
  if (status >= 500) return { ok: false, reason: 'upstream_error', detail: `HTTP ${status}` }

  if (status === 400) {
    // A 400 here is usually the video, not the request: unavailable, private, or
    // too long for the model's window.
    if (lower.includes('too large') || lower.includes('exceeds') || lower.includes('token')) {
      return { ok: false, reason: 'too_long', detail: body.slice(0, 200) }
    }
    if (lower.includes('unavailable') || lower.includes('private') || lower.includes('not found')) {
      return { ok: false, reason: 'video_unavailable', detail: body.slice(0, 200) }
    }
    return { ok: false, reason: 'upstream_error', detail: `HTTP 400: ${body.slice(0, 200)}` }
  }

  return { ok: false, reason: 'upstream_error', detail: `HTTP ${status}: ${body.slice(0, 200)}` }
}

/** Coerce the model's array into ordered, non-overlapping cues. */
export function normaliseCues(
  raw: unknown,
  durationMs: number,
): Array<{ startMs: number; endMs: number; text: string }> {
  if (!Array.isArray(raw)) return []

  const parsed = (raw as RawCue[])
    .map((c) => ({
      startMs: Math.round(Number(c?.t) * 1000),
      text: typeof c?.text === 'string' ? c.text.replace(/\s+/g, ' ').trim() : '',
    }))
    .filter((c) => Number.isFinite(c.startMs) && c.startMs >= 0 && c.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs)

  const TAIL_MS = 5_000
  return parsed.map((cur, i) => {
    const next = parsed[i + 1]
    const fallbackEnd = durationMs > cur.startMs ? durationMs : cur.startMs + TAIL_MS
    return {
      startMs: cur.startMs,
      endMs: next ? Math.max(next.startMs, cur.startMs) : fallbackEnd,
      text: cur.text,
    }
  })
}

export class GeminiUrlSource implements TranscriptSource {
  readonly id = 'gemini_url' as const

  constructor(private readonly config: GeminiConfig) {}

  canHandle(input: VideoInput): boolean {
    // Documented constraint: the YouTube-URL path accepts public videos only.
    const priv = input.availability !== undefined && input.availability !== 'public'
    return Boolean(this.config.apiKey) && !priv
  }

  async fetch(input: VideoInput): Promise<FetchResult> {
    const { apiKey } = this.config
    if (!apiKey) return { ok: false, reason: 'not_configured', detail: 'no Gemini API key' }

    const model = this.config.model ?? DEFAULT_MODEL
    const base = this.config.baseUrl ?? DEFAULT_BASE
    const http = this.config.http ?? defaultHttp

    let res: HttpResponse
    try {
      res = await http(`${base}/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { fileData: { fileUri: input.ref.canonicalUrl } },
                { text: PROMPT },
              ],
            },
          ],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 },
        }),
      })
    } catch (err) {
      return {
        ok: false,
        reason: 'upstream_error',
        detail: err instanceof Error ? err.message : String(err),
      }
    }

    if (!res.ok) return classifyStatus(res.status, res.text)

    let payload: unknown
    try {
      payload = JSON.parse(res.text)
    } catch {
      return { ok: false, reason: 'upstream_error', detail: 'response was not JSON' }
    }

    const inner = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
      ?.candidates?.[0]?.content?.parts?.[0]?.text

    if (typeof inner !== 'string') {
      return { ok: false, reason: 'no_transcript', detail: 'no text part in response' }
    }

    let rawCues: unknown
    try {
      rawCues = JSON.parse(inner)
    } catch {
      return { ok: false, reason: 'no_transcript', detail: 'model output was not a JSON array' }
    }

    const durationMs = input.durationSec !== undefined ? input.durationSec * 1000 : 0
    const cues = normaliseCues(rawCues, durationMs)

    if (cues.length === 0) return { ok: false, reason: 'no_transcript', detail: 'no usable cues' }

    return {
      ok: true,
      transcript: buildTranscript({
        videoId: input.ref.videoId,
        provenance: 'gemini_url',
        language: input.language ?? 'unknown',
        durationMs: durationMs || cues[cues.length - 1]!.endMs,
        cues,
      }),
    }
  }
}
