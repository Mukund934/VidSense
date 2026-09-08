/**
 * O20 — what does the entailment gate cost in wrongly-rejected good citations?
 *
 * `DECISIONS.md` marks this **blocking before gate 3 is trusted**, and it is the
 * right thing to block on. A verifier that catches bad citations is only useful
 * if it leaves good ones alone: at a 10% false-positive rate, one receipt in ten
 * would lose its evidence for no reason, and the product's whole promise is the
 * evidence. Recall matters less than that, because an unverified-but-correct
 * citation is the status quo, while a destroyed correct one is a regression.
 *
 * ## Constructing ground truth
 *
 * The hard part is knowing the right answer in advance. Three tiers, ordered by
 * how certain the label is:
 *
 *   - **identity** — the claim *is* the passage. A verifier that rejects this is
 *     definitively wrong; no judgement call is involved.
 *   - **subspan** — the claim is one sentence taken from a longer passage. Also
 *     definitively supported: the passage literally contains it.
 *   - **paraphrase** — the claim is a model-written restatement of the passage.
 *     Probably supported, but the label is only as good as the paraphrase, so it
 *     is reported separately and never mixed into the headline number.
 *
 * And one negative tier:
 *
 *   - **mismatch** — a claim from this video paired with a passage from a
 *     completely different one. The first attempt drew negatives from a distant
 *     part of the *same* video and every pair came back `unclear`, which was the
 *     honest answer: a self-referential talk is about the same thing throughout,
 *     so "unrelated" was not what those pairs actually were. Crossing videos
 *     removes the confound.
 *
 * The headline false-positive rate is computed over **identity + subspan only**,
 * because those are the two tiers where being wrong is not a matter of opinion.
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
import { buildVerifyPrompt, parseVerdict, type Entailment } from '../../src/answer/verify.js'

type Tier = 'identity' | 'subspan' | 'paraphrase' | 'mismatch'

interface Pair {
  tier: Tier
  claim: string
  evidence: string
  /** What a correct verifier should say. */
  expected: 'supported' | 'not_supported'
}

function key(): string | null {
  return requireEnv('GOOGLE_API_KEY', 'GEMINI_API_KEY')
}

/** Free-tier request-per-minute limits are low enough that 30 back-to-back calls trip them. */
const THROTTLE_MS = 4_500

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A failed call is not a verdict.
 *
 * The first version returned '' on any error, which `parseVerdict` read as
 * UNCLEAR — so a rate limit became a measurement. Every later call in the run
 * was throttled and the whole result was quietly wrong. Failures are now
 * reported and excluded rather than counted.
 */
async function complete(
  apiKey: string,
  prompt: string,
  json = false,
): Promise<{ ok: boolean; text: string; status: number }> {
  const res = await http(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  })
  if (!res.ok) return { ok: false, text: '', status: res.status }
  return {
    ok: true,
    text: String(pick(res.json, 'candidates.0.content.parts.0.text') ?? ''),
    status: res.status,
  }
}

/** Passages long enough to carry a claim, spread across the video. */
async function passages(apiKey: string, videoId: string, want: number): Promise<string[]> {
  // Issued directly rather than through `complete`, because this is the one
  // call that has to carry the video itself.
  const res = await http(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } },
            {
              text:
                'Transcribe this video. Return ONLY a JSON array of strings, each two or three ' +
                'complete sentences of speech, in order. No timestamps, no commentary.',
            },
          ],
        },
      ],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
  })

  if (!res.ok) return []
  const text = String(pick(res.json, 'candidates.0.content.parts.0.text') ?? '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const usable = parsed
    .map((p) => String(p).replace(/\s+/g, ' ').trim())
    // Long enough to contain a sentence that can stand alone as a subspan claim.
    .filter((p) => p.split(/\s+/).length >= 14)

  // Spread the sample across the video rather than taking the opening.
  const step = Math.max(1, Math.floor(usable.length / want))
  return Array.from({ length: Math.min(want, usable.length) }, (_, i) => usable[i * step]!).filter(
    Boolean,
  )
}

function firstSentence(text: string): string | null {
  const parts = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0)
  if (parts.length < 2) return null
  const head = parts[0]!.trim()
  return head.split(/\s+/).length >= 5 ? head : null
}

async function buildPairs(
  apiKey: string,
  spans: string[],
  unrelated: string[],
): Promise<Pair[]> {
  const pairs: Pair[] = []

  for (const span of spans) {
    pairs.push({ tier: 'identity', claim: span, evidence: span, expected: 'supported' })

    const head = firstSentence(span)
    if (head) {
      pairs.push({ tier: 'subspan', claim: head, evidence: span, expected: 'supported' })
    }
  }

  // Paraphrases, one call for the batch.
  const restated = await complete(
    apiKey,
    'Restate each sentence below in different words. Add nothing. Remove nothing. ' +
      'Return ONLY a JSON array of strings, same order, same length.\n\n' +
      JSON.stringify(spans),
    true,
  )
  try {
    const list = JSON.parse(restated.text) as unknown
    if (Array.isArray(list)) {
      list.forEach((claim, i) => {
        const evidence = spans[i]
        const text = String(claim).trim()
        if (evidence && text.length > 10) {
          pairs.push({ tier: 'paraphrase', claim: text, evidence, expected: 'supported' })
        }
      })
    }
  } catch {
    /* paraphrase tier is optional */
  }

  // Negatives are drawn from a different video entirely. Pairing two parts of
  // the same talk produced pairs that were not actually unrelated, and the
  // verifier was right to call them unclear.
  for (let i = 0; i < Math.min(spans.length, unrelated.length); i += 1) {
    const claim = spans[i]
    const evidence = unrelated[i]
    if (claim && evidence) {
      pairs.push({ tier: 'mismatch', claim, evidence, expected: 'not_supported' })
    }
  }

  return pairs
}

function rate(n: number, d: number): number {
  return d === 0 ? 0 : Number(((n / d) * 100).toFixed(1))
}

export async function o20Verifier(videoId = DEFAULT_VIDEO_ID): Promise<ExperimentResult> {
  const id = 'O20-verifier'
  const question = 'What does the entailment gate cost in wrongly-rejected good citations?'

  const apiKey = key()
  if (!apiKey) return blocked(id, question, 'set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env.local')

  const spans = await passages(apiKey, videoId, 10)
  const otherId = process.env['UNRELATED_VIDEO_ID'] ?? 'aircAruvnKk'
  const unrelated = await passages(apiKey, otherId, 10)

  if (spans.length < 6) {
    return {
      id,
      question,
      verdict: 'INCONCLUSIVE',
      finding: `Only ${spans.length} usable passages; not enough to measure anything.`,
      evidence: { model: GEMINI_MODEL, videoId },
      ranAt: new Date().toISOString(),
    }
  }

  const pairs = await buildPairs(apiKey, spans, unrelated)
  const results: Array<Pair & { got: Entailment; reply: string }> = []
  const failures: number[] = []

  for (const [i, pair] of pairs.entries()) {
    if (i > 0) await pause(THROTTLE_MS)
    const reply = await complete(apiKey, buildVerifyPrompt(pair.claim, pair.evidence))
    if (!reply.ok) {
      failures.push(reply.status)
      continue
    }
    results.push({
      ...pair,
      got: parseVerdict(reply.text).entailment,
      reply: reply.text.slice(0, 60),
    })
  }

  if (results.length < pairs.length / 2) {
    return {
      id,
      question,
      verdict: 'INCONCLUSIVE',
      finding:
        `${failures.length} of ${pairs.length} verifier calls failed (statuses ` +
        `${[...new Set(failures)].join(', ')}). Too few verdicts to measure anything.`,
      evidence: { model: GEMINI_MODEL, videoId, failures: failures.length, pairs: pairs.length },
      ranAt: new Date().toISOString(),
    }
  }

  const byTier = (tier: Tier) => results.filter((r) => r.tier === tier)
  const tierStats = (tiers: Tier[]) => {
    const rows = results.filter((r) => tiers.includes(r.tier))
    const positive = rows.filter((r) => r.expected === 'supported')
    const negative = rows.filter((r) => r.expected === 'not_supported')
    return {
      n: rows.length,
      falsePositives: positive.filter((r) => r.got === 'not_supported').length,
      unclearOnTrue: positive.filter((r) => r.got === 'unclear').length,
      caught: negative.filter((r) => r.got === 'not_supported').length,
      missed: negative.filter((r) => r.got === 'supported').length,
    }
  }

  // The headline: only the tiers where "supported" is not a judgement call.
  const definitive = tierStats(['identity', 'subspan'])
  const fpRate = rate(definitive.falsePositives, definitive.n)
  const paraphrase = tierStats(['paraphrase'])
  const mismatch = tierStats(['mismatch'])
  const recall = rate(mismatch.caught, mismatch.caught + mismatch.missed)

  // A gate that destroys good citations is worse than no gate at all.
  const FP_CEILING = 5
  const RECALL_FLOOR = 60
  const usable = fpRate <= FP_CEILING && recall >= RECALL_FLOOR

  return {
    id,
    question,
    verdict: usable ? 'PASS' : 'FAIL',
    finding: usable
      ? `Gate 3 is safe to trust: ${fpRate}% false positives on definitively-true citations ` +
        `(${definitive.falsePositives}/${definitive.n}), catching ${recall}% of mismatched ones. ` +
        'It rejects bad evidence without destroying good evidence.'
      : `Gate 3 is NOT yet trustworthy: ${fpRate}% false positives on definitively-true citations ` +
        `(${definitive.falsePositives}/${definitive.n}, ceiling ${FP_CEILING}%), recall ${recall}% ` +
        `(floor ${RECALL_FLOOR}%). Do not let it strip receipts until this improves.`,
    evidence: {
      model: GEMINI_MODEL,
      videoId,
      passages: spans.length,
      unrelatedPassages: unrelated.length,
      unrelatedVideoId: otherId,
      pairs: results.length,
      callsFailed: failures.length,
      headlineFalsePositiveRatePct: fpRate,
      mismatchRecallPct: recall,
      definitive,
      paraphrase,
      mismatch,
      byTier: {
        identity: byTier('identity').map((r) => r.got),
        subspan: byTier('subspan').map((r) => r.got),
        paraphrase: byTier('paraphrase').map((r) => r.got),
        mismatch: byTier('mismatch').map((r) => r.got),
      },
      // Kept so an `unclear` result can be told apart from a reply the parser
      // could not read — they mean very different things.
      sampleReplies: results.slice(0, 6).map((r) => `${r.tier}: ${r.reply}`),
      NOTE:
        'False positives are counted only on identity and subspan pairs, where the claim is ' +
        'contained in the passage verbatim and "supported" is not a matter of opinion.',
    },
    ranAt: new Date().toISOString(),
  }
}
