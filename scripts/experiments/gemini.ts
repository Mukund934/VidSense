/**
 * Gemini YouTube-URL experiments.
 *
 * These decide the ingestion architecture. Until they run, every cost number and
 * every "jump to moment" claim in the plan rests on an assumption.
 */

import {
  DEFAULT_VIDEO_ID,
  GEMINI_BASE,
  GEMINI_MODEL,
  type ExperimentResult,
  blocked,
  http,
  pick,
  requireEnv,
} from './lib.js'

function key(): string | null {
  return requireEnv('GOOGLE_API_KEY', 'GEMINI_API_KEY')
}

function youtubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

/**
 * O5 — Is the YouTube-URL path token-billed at all?
 *
 * The docs say the feature "is available at no charge", which is ambiguous between
 * *no surcharge* and *no token charge*. The cost model assumes tokens ARE billed.
 * If they are not, every per-video cost in DECISIONS.md is overstated by 40-70%.
 */
export async function o5TokenBilling(videoId = DEFAULT_VIDEO_ID): Promise<ExperimentResult> {
  const apiKey = key()
  if (!apiKey) {
    return blocked('O5-token-billing', 'Is the Gemini YouTube-URL path token-billed?',
      'set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env.local')
  }

  const body = JSON.stringify({
    contents: [{ parts: [{ fileData: { fileUri: youtubeUrl(videoId) } }, { text: 'Reply with the single word: ok' }] }],
  })

  const count = await http(`${GEMINI_BASE}/models/${GEMINI_MODEL}:countTokens?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })

  const gen = await http(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })

  const counted = pick(count.json, 'totalTokens')
  const promptTokens = pick(gen.json, 'usageMetadata.promptTokenCount')
  const totalTokens = pick(gen.json, 'usageMetadata.totalTokenCount')

  if (!gen.ok) {
    return {
      id: 'O5-token-billing',
      question: 'Is the Gemini YouTube-URL path token-billed?',
      verdict: 'FAIL',
      finding: `generateContent rejected the YouTube URL (HTTP ${gen.status}). If this is a key-type error, the key may be a legacy Standard key — those are rejected from September 2026.`,
      evidence: { status: gen.status, body: gen.text.slice(0, 600), countTokensStatus: count.status },
      ranAt: new Date().toISOString(),
    }
  }

  const billed = typeof promptTokens === 'number' && promptTokens > 1_000

  return {
    id: 'O5-token-billing',
    question: 'Is the Gemini YouTube-URL path token-billed?',
    verdict: typeof promptTokens === 'number' ? 'PASS' : 'INCONCLUSIVE',
    finding: billed
      ? `Video tokens ARE counted (${String(promptTokens)} prompt tokens). The cost model's assumption holds — no change needed.`
      : `Prompt tokens are ${String(promptTokens)} — too low to include video content. Video may NOT be token-billed on this path; re-check the billing console before trusting it, then revise every per-video cost downward.`,
    evidence: {
      model: GEMINI_MODEL,
      videoId,
      countTokensTotal: counted,
      generatePromptTokens: promptTokens,
      generateTotalTokens: totalTokens,
      latencyMs: gen.ms,
      NOTE: 'Confirm against the billing console 24h later. usageMetadata counts tokens; it does not prove they are charged.',
    },
    ranAt: new Date().toISOString(),
  }
}

/**
 * Does clipping work on a YouTube URL input?
 *
 * Google's docs document start/end offsets and custom fps for "static" mode and do
 * not confirm them for URL inputs. This decides windowed vs single-call ingest.
 */
export async function clipSupport(videoId = DEFAULT_VIDEO_ID): Promise<ExperimentResult> {
  const apiKey = key()
  if (!apiKey) {
    return blocked('clip-support', 'Does start/end offset clipping work on a YouTube URL input?',
      'set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env.local')
  }

  const res = await http(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            fileData: { fileUri: youtubeUrl(videoId) },
            videoMetadata: { startOffset: '120s', endOffset: '180s' },
          },
          { text: 'In one sentence, what is said in this clip?' },
        ],
      }],
    }),
  })

  return {
    id: 'clip-support',
    question: 'Does start/end offset clipping work on a YouTube URL input?',
    verdict: res.ok ? 'PASS' : 'FAIL',
    finding: res.ok
      ? 'Clipping IS accepted on a URL input — windowed ingest is available, so long videos can be processed in bounded slices.'
      : `Clipping REJECTED on a URL input (HTTP ${res.status}). Ingest must send the whole video in one call; plan cost and latency for full-length processing.`,
    evidence: {
      status: res.status,
      promptTokens: pick(res.json, 'usageMetadata.promptTokenCount'),
      body: res.ok ? undefined : res.text.slice(0, 500),
      latencyMs: res.ms,
    },
    ranAt: new Date().toISOString(),
  }
}

/**
 * C1 — Timestamp drift.
 *
 * The gating experiment for the entire product. If the model's timestamps drift,
 * "jump to moment" is dead and receipts degrade to quote-only.
 *
 * This measures SELF-CONSISTENCY, which is a necessary condition, not a sufficient
 * one. Ground truth needs a caption track you own — see the note in the output.
 */
export async function c1Drift(videoId = DEFAULT_VIDEO_ID): Promise<ExperimentResult> {
  const apiKey = key()
  if (!apiKey) {
    return blocked('C1-timestamp-drift', 'Do Gemini timestamps on a YouTube URL land accurately?',
      'set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env.local')
  }

  const res = await http(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { fileData: { fileUri: youtubeUrl(videoId) } },
          {
            text:
              'Transcribe this video. Return ONLY a JSON array of objects with keys ' +
              '"t" (start time in seconds, integer) and "text" (the words spoken). ' +
              'Cover the whole video. No commentary, no markdown fence.',
          },
        ],
      }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  })

  if (!res.ok) {
    return {
      id: 'C1-timestamp-drift',
      question: 'Do Gemini timestamps on a YouTube URL land accurately?',
      verdict: 'FAIL',
      finding: `Transcription request failed (HTTP ${res.status}).`,
      evidence: { status: res.status, body: res.text.slice(0, 500) },
      ranAt: new Date().toISOString(),
    }
  }

  const raw = pick(res.json, 'candidates.0.content.parts.0.text')
  let cues: Array<{ t: number; text: string }> = []
  try {
    cues = JSON.parse(String(raw ?? '[]')) as Array<{ t: number; text: string }>
  } catch {
    return {
      id: 'C1-timestamp-drift',
      question: 'Do Gemini timestamps on a YouTube URL land accurately?',
      verdict: 'INCONCLUSIVE',
      finding: 'Response was not parseable JSON; tighten the schema before relying on this path.',
      evidence: { sample: String(raw ?? '').slice(0, 400) },
      ranAt: new Date().toISOString(),
    }
  }

  const times = cues.map((c) => Number(c.t)).filter((n) => Number.isFinite(n))
  const monotonic = times.every((t, i) => i === 0 || t >= times[i - 1]!)
  const gaps = times.slice(1).map((t, i) => t - times[i]!)
  const maxGap = gaps.length ? Math.max(...gaps) : 0

  return {
    id: 'C1-timestamp-drift',
    question: 'Do Gemini timestamps on a YouTube URL land accurately?',
    verdict: monotonic && cues.length > 5 ? 'PASS' : 'INCONCLUSIVE',
    finding: monotonic
      ? `Returned ${cues.length} cues, monotonically ordered, last at ${times[times.length - 1] ?? 0}s. Self-consistent — but ground truth still requires comparison against a caption track you own.`
      : 'Timestamps are NOT monotonic. Treat the jump-to-moment feature as unproven and hold the quote-only fallback.',
    evidence: {
      cueCount: cues.length,
      firstT: times[0],
      lastT: times[times.length - 1],
      monotonic,
      maxGapSeconds: maxGap,
      latencyMs: res.ms,
      promptTokens: pick(res.json, 'usageMetadata.promptTokenCount'),
      NEXT: 'Upload a video you own with a known caption track, re-run, and compare cue starts to ground truth. That is the real C1.',
    },
    ranAt: new Date().toISOString(),
  }
}
