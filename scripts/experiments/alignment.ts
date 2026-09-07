/**
 * C1-ALIGN — how wrong are Gemini's transcript timestamps, and is the error fixable?
 *
 * The earlier C1 established that bulk transcription timestamps overshoot the
 * real duration by roughly half. This experiment answers the question that
 * actually decides the architecture: **is that error a constant scale factor?**
 *
 * If it is, one cheap rescale against the true duration repairs the whole
 * transcript and single-call ingest survives. If it is not, timestamps have to
 * be derived from windows we choose rather than from anything the model says.
 *
 * ## The oracle
 *
 * Ground truth normally needs a caption track we own. It does not here, because
 * the provider gives us one: **clipping bounds content exactly.** Asking for
 * `[200s, 225s]` returns the speech from that span and nothing else — verified
 * to the point of cutting mid-sentence at the boundary. So a narrow clip is an
 * authoritative answer to "what is said at time T", and we can build ground
 * truth out of the same API we are measuring.
 *
 * ## The method
 *
 *   1. Transcribe the whole video in one call. Keep the model's timestamps.
 *   2. Rescale them: `t' = t x (trueDuration / lastModelTimestamp)`.
 *   3. At several probe times T, clip a narrow window and transcribe it. That
 *      text is what is *really* said at T.
 *   4. Locate that text in the transcript by lexical overlap.
 *   5. The error at T is `|rescaled_t_of_match - T|`.
 *
 * Errors are reported before and after rescaling, so the experiment says
 * whether the correction helps, not merely whether the raw numbers are bad.
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
  videoDurationSec,
} from './lib.js'

const PROBE_WINDOW_SEC = 10
const PROBE_COUNT = 8

interface ModelCue {
  t: number
  text: string
}

function key(): string | null {
  return requireEnv('GOOGLE_API_KEY', 'GEMINI_API_KEY')
}

function url(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

/** Words, lowercased, stripped of punctuation — the unit both sides are compared in. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
}

/**
 * How much of `probe` appears in `candidate`.
 *
 * Containment rather than Jaccard: the probe is a short clip and the candidate
 * is a window of transcript, so their sizes are deliberately unequal and a
 * symmetric measure would punish the match for the length difference alone.
 */
export function containment(probe: readonly string[], candidate: readonly string[]): number {
  if (probe.length === 0) return 0
  const pool = new Set(candidate)
  let hits = 0
  for (const w of probe) if (pool.has(w)) hits += 1
  return hits / probe.length
}

/**
 * Find where a probe *begins* in the transcript.
 *
 * Anchoring on the beginning is the whole point, and getting it wrong biases
 * every measurement in this file. A probe covers ten seconds of speech, so it
 * spans several cues; scoring a wide window and returning that window's first
 * index reports a time systematically earlier than the probe actually starts,
 * which looks exactly like transcript drift and is not.
 *
 * So: match on the probe's **leading** words only, against a narrow run of
 * cues. The answer is the cue where the probe starts, not the neighbourhood it
 * falls in.
 */
export function locate(
  cues: readonly ModelCue[],
  probeText: string,
  leadWords = 10,
  runCues = 3,
): { index: number; score: number } | null {
  const all = words(probeText)
  if (all.length < 3) return null
  const lead = all.slice(0, leadWords)

  let best = { index: -1, score: 0 }
  for (let i = 0; i < cues.length; i += 1) {
    const run = cues.slice(i, i + runCues)
    const score = containment(lead, words(run.map((c) => c.text).join(' ')))
    // Strictly greater keeps the earliest cue among equals, which is where the
    // probe starts rather than where its words happen to recur.
    if (score > best.score) best = { index: i, score }
  }

  // Below this the "match" is common words lining up by chance.
  return best.score >= 0.6 && best.index >= 0 ? best : null
}

async function transcribe(
  apiKey: string,
  videoId: string,
  clip?: { start: number; end: number },
): Promise<{ ok: boolean; cues: ModelCue[]; raw: string; status: number; tokens: unknown }> {
  const part: Record<string, unknown> = { fileData: { fileUri: url(videoId) } }
  if (clip) {
    part['videoMetadata'] = { startOffset: `${clip.start}s`, endOffset: `${clip.end}s` }
  }

  const res = await http(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            part,
            {
              text: clip
                ? 'Transcribe the speech in this clip verbatim. Plain text only, no timestamps.'
                : 'Transcribe this video. Return ONLY a JSON array of objects with keys "t" ' +
                  '(start time in seconds, integer) and "text". Cover the whole video. No fence.',
            },
          ],
        },
      ],
      generationConfig: {
        ...(clip ? {} : { responseMimeType: 'application/json' }),
        temperature: 0,
      },
    }),
  })

  const raw = String(pick(res.json, 'candidates.0.content.parts.0.text') ?? '')
  const tokens = pick(res.json, 'usageMetadata.promptTokenCount')
  if (!res.ok) return { ok: false, cues: [], raw: res.text.slice(0, 300), status: res.status, tokens }
  if (clip) return { ok: true, cues: [], raw, status: res.status, tokens }

  try {
    const parsed = JSON.parse(raw) as ModelCue[]
    return { ok: true, cues: parsed.filter((c) => Number.isFinite(Number(c.t))), raw, status: res.status, tokens }
  } catch {
    return { ok: false, cues: [], raw: raw.slice(0, 300), status: res.status, tokens }
  }
}

function stats(values: readonly number[]): { median: number; p95: number; max: number; mean: number } {
  if (values.length === 0) return { median: 0, p95: 0, max: 0, mean: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return {
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1]!,
    mean: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)),
  }
}

export async function c1Alignment(videoId = DEFAULT_VIDEO_ID): Promise<ExperimentResult> {
  const id = 'C1-alignment'
  const question = 'Is Gemini timestamp error a constant scale factor, and does rescaling fix it?'

  const apiKey = key()
  if (!apiKey) return blocked(id, question, 'set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env.local')

  const duration = await videoDurationSec(videoId)
  if (duration === null) {
    return blocked(id, question, 'set YOUTUBE_API_KEY — ground truth needs the real duration')
  }

  const full = await transcribe(apiKey, videoId)
  if (!full.ok || full.cues.length < 8) {
    return {
      id,
      question,
      verdict: 'INCONCLUSIVE',
      finding: `Could not obtain a usable transcript (HTTP ${full.status}, ${full.cues.length} cues).`,
      evidence: { model: GEMINI_MODEL, videoId, sample: full.raw.slice(0, 200) },
      ranAt: new Date().toISOString(),
    }
  }

  const times = full.cues.map((c) => Number(c.t))
  const lastModel = Math.max(...times)
  const scale = lastModel > 0 ? duration / lastModel : 1

  // Probe times spread over the interior, avoiding the very edges where a clip
  // would run off the end of the video.
  const probes = Array.from({ length: PROBE_COUNT }, (_, i) =>
    Math.round(((i + 1) / (PROBE_COUNT + 1)) * (duration - PROBE_WINDOW_SEC)),
  )

  const rawErrors: number[] = []
  const scaledErrors: number[] = []
  const samples: Array<Record<string, unknown>> = []

  for (const t of probes) {
    const clip = await transcribe(apiKey, videoId, { start: t, end: t + PROBE_WINDOW_SEC })
    if (!clip.ok || clip.raw.trim().length < 12) continue

    const hit = locate(full.cues, clip.raw)
    if (!hit) {
      samples.push({ probeT: t, matched: false })
      continue
    }

    const modelT = Number(full.cues[hit.index]!.t)
    const scaledT = modelT * scale
    const rawErr = Math.abs(modelT - t)
    const scaledErr = Math.abs(scaledT - t)
    rawErrors.push(rawErr)
    scaledErrors.push(scaledErr)
    samples.push({
      probeT: t,
      modelT,
      scaledT: Number(scaledT.toFixed(1)),
      rawErrorSec: Number(rawErr.toFixed(1)),
      scaledErrorSec: Number(scaledErr.toFixed(1)),
      matchScore: Number(hit.score.toFixed(2)),
    })
  }

  if (scaledErrors.length < 4) {
    return {
      id,
      question,
      verdict: 'INCONCLUSIVE',
      finding: `Only ${scaledErrors.length} probes matched; not enough to measure alignment.`,
      evidence: { model: GEMINI_MODEL, videoId, durationSec: duration, scale, samples },
      ranAt: new Date().toISOString(),
    }
  }

  const raw = stats(rawErrors)
  const scaled = stats(scaledErrors)

  // A receipt that lands within a couple of seconds is a working jump link.
  // Beyond ~5s the user arrives somewhere else in the sentence, or a different one.
  const USABLE_MEDIAN = 3
  const USABLE_P95 = 8
  const usable = scaled.median <= USABLE_MEDIAN && scaled.p95 <= USABLE_P95

  return {
    id,
    question,
    verdict: usable ? 'PASS' : 'FAIL',
    finding: usable
      ? `Rescaling works: median error ${scaled.median}s, p95 ${scaled.p95}s after correction ` +
        `(was ${raw.median}s / ${raw.p95}s). A single duration-anchored scale factor repairs the transcript.`
      : `Rescaling is NOT sufficient: median error is still ${scaled.median}s and p95 ${scaled.p95}s ` +
        `after correction (raw ${raw.median}s / ${raw.p95}s). The error is not a constant scale — ` +
        'timestamps must be derived from windows we control, not from the model.',
    evidence: {
      model: GEMINI_MODEL,
      videoId,
      durationSec: duration,
      lastModelTimestamp: lastModel,
      scaleFactor: Number(scale.toFixed(4)),
      cueCount: full.cues.length,
      probesMatched: scaledErrors.length,
      rawError: raw,
      scaledError: scaled,
      promptTokensFullVideo: full.tokens,
      samples,
    },
    ranAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------

/**
 * C1-WINDOW — derive timestamps from windows we choose, and measure the result.
 *
 * The alternative to trusting the model's clock. The video is transcribed in
 * fixed spans; a cue's time comes from the span it was returned in, placed
 * proportionally by its position in that span's text. The model never supplies
 * a number.
 *
 * The point is not that this is more accurate — it is that the error is
 * **bounded by construction**. "This line is somewhere in [120s, 150s] because
 * that is the only audio we sent" is a guarantee. "This line is at 132s because
 * a fitted line said so" is an estimate. The product sells receipts, so the
 * guarantee is worth paying for.
 */
export async function c1Windowed(videoId = DEFAULT_VIDEO_ID): Promise<ExperimentResult> {
  const id = 'C1-windowed'
  const question = 'Does deriving timestamps from chosen windows produce usable receipts?'

  const apiKey = key()
  if (!apiKey) return blocked(id, question, 'set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env.local')

  const duration = await videoDurationSec(videoId)
  if (duration === null) return blocked(id, question, 'set YOUTUBE_API_KEY — needs the real duration')

  const windowSec = Number(process.env['WINDOW_SEC'] ?? 30)
  const spans: Array<{ start: number; end: number }> = []
  for (let t = 0; t < duration; t += windowSec) {
    spans.push({ start: t, end: Math.min(duration, t + windowSec) })
  }

  const cues: ModelCue[] = []
  let tokens = 0
  let failedSpans = 0

  for (const span of spans) {
    const clip = await transcribe(apiKey, videoId, span)
    if (typeof clip.tokens === 'number') tokens += clip.tokens
    if (!clip.ok || clip.raw.trim().length < 4) {
      failedSpans += 1
      continue
    }

    // Split into sentence-ish units and place each proportionally by where its
    // text sits in the span. Speech rate is near enough constant inside 30s
    // that character position is a fair proxy for elapsed time.
    const units = clip.raw.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 1)
    const total = units.reduce((n, u) => n + u.length, 0) || 1
    let consumed = 0
    for (const unit of units) {
      const t = span.start + ((span.end - span.start) * consumed) / total
      cues.push({ t: Math.round(t), text: unit })
      consumed += unit.length
    }
  }

  if (cues.length < 8) {
    return {
      id, question, verdict: 'INCONCLUSIVE',
      finding: `Only ${cues.length} cues across ${spans.length} windows; ${failedSpans} spans failed.`,
      evidence: { model: GEMINI_MODEL, videoId, windowSec, spans: spans.length, failedSpans },
      ranAt: new Date().toISOString(),
    }
  }

  // Probe at times deliberately off the window grid, so a probe cannot be
  // flattered by landing exactly on a boundary we chose.
  const offset = Math.round(windowSec / 3)
  const probes = Array.from({ length: PROBE_COUNT }, (_, i) =>
    Math.min(
      duration - PROBE_WINDOW_SEC,
      offset + Math.round(((i + 1) / (PROBE_COUNT + 1)) * (duration - PROBE_WINDOW_SEC)),
    ),
  )

  const errors: number[] = []
  const samples: Array<Record<string, unknown>> = []
  for (const t of probes) {
    const clip = await transcribe(apiKey, videoId, { start: t, end: t + PROBE_WINDOW_SEC })
    if (!clip.ok || clip.raw.trim().length < 12) continue
    const hit = locate(cues, clip.raw)
    if (!hit) { samples.push({ probeT: t, matched: false }); continue }
    const err = Math.abs(Number(cues[hit.index]!.t) - t)
    errors.push(err)
    samples.push({ probeT: t, derivedT: cues[hit.index]!.t, errorSec: Number(err.toFixed(1)), matchScore: Number(hit.score.toFixed(2)) })
  }

  if (errors.length < 4) {
    return {
      id, question, verdict: 'INCONCLUSIVE',
      finding: `Only ${errors.length} probes matched.`,
      evidence: { model: GEMINI_MODEL, videoId, windowSec, cueCount: cues.length, samples },
      ranAt: new Date().toISOString(),
    }
  }

  const e = stats(errors)
  const usable = e.median <= 3 && e.p95 <= 8

  return {
    id, question,
    verdict: usable ? 'PASS' : 'FAIL',
    finding: usable
      ? `Windowed timestamps are usable: median ${e.median}s, p95 ${e.p95}s at a ${windowSec}s window. ` +
        'Error is bounded by the window, not estimated from the model.'
      : `Windowed timestamps at ${windowSec}s: median ${e.median}s, p95 ${e.p95}s — still outside the ` +
        'receipt bar. Try a smaller window before abandoning the approach.',
    evidence: {
      model: GEMINI_MODEL, videoId, durationSec: duration, windowSec,
      windows: spans.length, failedSpans, cueCount: cues.length,
      probesMatched: errors.length, error: e, promptTokensTotal: tokens, samples,
    },
    ranAt: new Date().toISOString(),
  }
}
