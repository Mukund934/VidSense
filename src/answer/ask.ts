/**
 * Asking a question about one video.
 *
 * The transcript goes into context whole. `ARCHITECTURE.md` §5 explains why
 * there is no retrieval step here: a two-hour transcript is 25–35k tokens, so at
 * one-video scale an embedding model would cost money to answer *worse* than
 * simply reading the thing. Lexical search still exists, but it serves "show me
 * every mention", not "answer this question".
 *
 * The model is injected. Every behaviour in this module — abstention, out-of-
 * range citations, lane discipline, malformed output — is therefore testable
 * offline with no key and no network, which is the only way a suite that
 * guards a safety property can run on every commit.
 */

import { formatTimestamp, type TimedTranscript } from '@/domain/transcript'
import { untrustedPreamble, wrapUntrusted } from '@/domain/untrusted'
import { type Answer, NOT_IN_VIDEO, buildAnswer } from '@/answer/contract'

/** Whatever produces text from a prompt. Anything else is the caller's problem. */
export type Completion = (prompt: string) => Promise<string>

export interface AskOptions {
  /** Cap the transcript sent to the model. Zero means no cap. */
  readonly maxCues?: number
}

/**
 * Render cues with their indices, which are the only handle the model gets.
 *
 * Timestamps are included as text for the model's own reasoning about order and
 * pacing, but it is told not to echo them — the indices are what come back, and
 * the time is resolved on our side.
 */
export function renderTranscript(transcript: TimedTranscript, maxCues = 0): string {
  const cues = maxCues > 0 ? transcript.cues.slice(0, maxCues) : transcript.cues
  return cues.map((c) => `[${c.i}] (${formatTimestamp(c.startMs)}) ${c.text}`).join('\n')
}

export function buildPrompt(transcript: TimedTranscript, question: string): string {
  const fenced = wrapUntrusted('transcript', renderTranscript(transcript))

  return [
    untrustedPreamble([fenced.nonce]),
    '',
    'You answer questions about one video, using only its transcript.',
    '',
    'RULES',
    '1. Every claim about the video must cite the cue indices it comes from.',
    '2. Never write a timestamp, a URL, or a quotation. You supply the claim and',
    '   the cue indices; the application resolves the words and the time itself.',
    '3. Never cite an index that is not in the transcript below.',
    `4. If the transcript does not address the question, reply with exactly ${NOT_IN_VIDEO}`,
    '   and nothing else. That is a correct and useful answer, not a failure.',
    '5. Do not pad an answer with general knowledge. If something is your own',
    '   inference rather than something the video says, mark it INFERENCE.',
    '',
    'OUTPUT',
    'Reply with a JSON array and nothing else. Each element:',
    '  { "text": "one claim", "cueStart": <int>, "cueEnd": <int>, "lane": "VIDEO" }',
    'Use lane INFERENCE for your own reasoning; such claims carry no cue indices.',
    '',
    'TRANSCRIPT',
    fenced.block,
    '',
    'QUESTION',
    question.trim(),
  ].join('\n')
}

/** True when the model took the abstention route. */
function abstained(reply: string): boolean {
  // Checked on a stripped copy so surrounding punctuation or a stray fence does
  // not turn a correct abstention into an unreadable answer.
  return reply.replace(/[^A-Z_]/g, '').includes(NOT_IN_VIDEO)
}

/** Pull the JSON array out of a reply that may be wrapped in prose or a fence. */
export function extractJson(reply: string): unknown {
  const trimmed = reply.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('[')
    const end = trimmed.lastIndexOf(']')
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

export async function ask(
  transcript: TimedTranscript,
  question: string,
  complete: Completion,
  options: AskOptions = {},
): Promise<Answer> {
  if (!question.trim()) {
    return {
      status: 'unreadable',
      claims: [],
      rejected: [],
      message: 'Ask a question about the video.',
    }
  }

  if (transcript.cues.length === 0) {
    return {
      status: 'not_in_video',
      claims: [],
      rejected: [],
      message: 'There is no transcript for this video, so there is nothing to answer from.',
    }
  }

  let reply: string
  try {
    reply = await complete(buildPrompt(transcript, question))
  } catch (err) {
    return {
      status: 'unreadable',
      claims: [],
      rejected: [],
      message: `The answer could not be generated: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (abstained(reply)) return buildAnswer(transcript, null, { abstained: true })

  return buildAnswer(transcript, extractJson(reply))
}
