import { NextRequest } from 'next/server'

import { ask } from '@/answer/ask'
import { verifyAnswer } from '@/answer/verify'
import {
  completion,
  ModelUnavailableError,
  verificationEnabled,
  verifier,
} from '@/lib/server/deps'
import { refund, spend, tooManyRequests } from '@/lib/server/quota'
import { currentUid } from '@/lib/server/session'
import { loadVideo } from '@/lib/server/video'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * Answer a question about one video.
 *
 * The transcript is loaded server-side rather than accepted from the client.
 * A receipt is only worth something if the evidence it cites is evidence we
 * hold — letting the caller supply the transcript would let them supply the
 * proof too.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: { videoId?: string; question?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'Send a JSON body.' }, { status: 400 })
  }

  const videoId = (body.videoId ?? '').trim()
  const question = (body.question ?? '').trim()
  if (!videoId || !question) {
    return Response.json({ error: 'Both videoId and question are required.' }, { status: 400 })
  }

  const video = await loadVideo(videoId)
  if (!video?.transcript) {
    return Response.json(
      {
        error: 'no_transcript',
        detail: 'This video has no stored transcript. Open it again to re-analyse.',
      },
      { status: 409 },
    )
  }

  // After the transcript check and before the model call. A question about a
  // video with no transcript is refused without reaching a provider, so it
  // should not cost the asker anything either.
  const uid = await currentUid()
  const claim = await spend(uid, 'ask')
  if (!claim.allowed) return tooManyRequests(claim)

  try {
    const answer = await ask(video.transcript, question, completion())

    // Off unless asked for: one extra call per claim is a real cost, and D32
    // keeps gate 3 out of the request path until that trade is made
    // deliberately. O20 established it is safe to switch on, not that it is free.
    const checked = verificationEnabled()
      ? await verifyAnswer(answer, verifier(), { maxClaims: 6 })
      : answer

    return Response.json({ answer: checked })
  } catch (err) {
    // No answer was produced, so the question should not count against the
    // day's budget. Being unable to answer is not something to charge for.
    await refund(uid, 'ask')
    if (err instanceof ModelUnavailableError) {
      return Response.json({ error: 'model_unavailable', detail: err.message }, { status: 503 })
    }
    return Response.json({ error: 'unexpected' }, { status: 500 })
  }
}
