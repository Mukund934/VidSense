/**
 * Shared plumbing for the feasibility experiments.
 *
 * These experiments answer questions that no amount of reading settles. Each one
 * reports PASS / FAIL / INCONCLUSIVE and writes a dated record, because the point
 * is to replace an assumption in the architecture with a measurement.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'BLOCKED'

export interface ExperimentResult {
  id: string
  question: string
  verdict: Verdict
  /** The single sentence that changes the architecture. */
  finding: string
  evidence: Record<string, unknown>
  ranAt: string
}

/** Minimal .env.local reader — avoids a dependency for a script that runs a handful of times. */
export function loadEnv(root = process.cwd()): void {
  for (const name of ['.env.local', '.env']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (value && process.env[key] === undefined) process.env[key] = value
    }
  }
}

export function requireEnv(...names: string[]): string | null {
  for (const n of names) {
    const v = process.env[n]
    if (v && v.trim()) return v.trim()
  }
  return null
}

export interface HttpResult {
  status: number
  ok: boolean
  json: unknown
  text: string
  ms: number
}

export async function http(
  url: string,
  init?: RequestInit & { body?: string },
): Promise<HttpResult> {
  const started = Date.now()
  const res = await fetch(url, init)
  const text = await res.text()
  const ms = Date.now() - started
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON responses are reported via `text` */
  }
  return { status: res.status, ok: res.ok, json, text, ms }
}

/** Pull a nested value without asserting the response shape we hope for. */
export function pick(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

const RESULTS_DIR = join(process.cwd(), 'docs', 'research', 'experiments')

export function report(result: ExperimentResult): void {
  const mark = { PASS: '✓', FAIL: '✗', INCONCLUSIVE: '?', BLOCKED: '⊘' }[result.verdict]
  console.log(`\n${mark} [${result.id}] ${result.verdict}`)
  console.log(`  Q: ${result.question}`)
  console.log(`  → ${result.finding}`)
  for (const [k, v] of Object.entries(result.evidence)) {
    console.log(`    ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }

  mkdirSync(RESULTS_DIR, { recursive: true })
  const file = join(RESULTS_DIR, `${result.id}.json`)
  writeFileSync(file, JSON.stringify(result, null, 2), 'utf8')
  console.log(`    recorded: docs/research/experiments/${result.id}.json`)
}

export function blocked(id: string, question: string, what: string): ExperimentResult {
  return {
    id,
    question,
    verdict: 'BLOCKED',
    finding: `Cannot run: ${what}`,
    evidence: {},
    ranAt: new Date().toISOString(),
  }
}

/** A long, caption-bearing public video makes drift visible; override with EXPERIMENT_VIDEO_ID. */
export const DEFAULT_VIDEO_ID = process.env['EXPERIMENT_VIDEO_ID'] ?? 'dQw4w9WgXcQ'
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'
export const GEMINI_MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-3.5-flash-lite'

/**
 * The video's real duration, from the 1-unit `videos.list` call.
 *
 * This is what turns C1 from a self-consistency check into a drift measurement.
 * A transcript whose last cue sits past the end of the video is provably wrong,
 * and proving it needs no caption track of our own — just the duration, which
 * is the cheapest fact the YouTube API sells.
 *
 * Returns null when the key is absent or the call fails; the caller degrades to
 * self-consistency and says so rather than inventing a bound.
 */
export async function videoDurationSec(videoId: string): Promise<number | null> {
  const apiKey = requireEnv('YOUTUBE_API_KEY')
  if (!apiKey) return null

  const url =
    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${encodeURIComponent(videoId)}`
  try {
    const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey } })
    if (!res.ok) return null
    const body = (await res.json()) as {
      items?: Array<{ contentDetails?: { duration?: string } }>
    }
    const iso = body.items?.[0]?.contentDetails?.duration
    if (typeof iso !== 'string') return null

    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
    if (!m) return null
    const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0))
    return ((d! * 24 + h!) * 60 + min!) * 60 + s!
  } catch {
    return null
  }
}
