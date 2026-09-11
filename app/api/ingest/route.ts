import { NextRequest } from 'next/server'

import { ingestVideo, type IngestProgress } from '@/ingest/orchestrator'
import { parseYouTubeUrl } from '@/ingest/url'
import {
  capabilities,
  historyStore,
  metadataSource,
  transcriptSources,
  videoStore,
} from '@/lib/server/deps'
import { currentUid } from '@/lib/server/session'
import { recordVideoSeconds, refund, spend, tooManyRequests } from '@/lib/server/quota'
import { remember } from '@/lib/server/cache'

export const runtime = 'nodejs'
// Ingest waits on a provider transcribing a video; the default is not enough.
export const maxDuration = 300

/**
 * Ingest a video, streaming progress as it goes.
 *
 * NDJSON rather than a single response because transcription takes tens of
 * seconds and a spinner that cannot say what it is waiting for is indistinct
 * from one that has hung. The orchestrator already emits stages; this hands
 * them straight to the client instead of inventing a progress bar.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: { url?: string; transcript?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'Send a JSON body with a "url".' }, { status: 400 })
  }

  const ref = parseYouTubeUrl(body.url ?? '')
  if (!ref) {
    return Response.json(
      { error: 'That does not look like a YouTube video link.' },
      { status: 400 },
    )
  }

  const caps = capabilities()
  if (!caps.youtube) {
    return Response.json(
      { error: 'not_configured', detail: 'YOUTUBE_API_KEY is not set on the server.' },
      { status: 503 },
    )
  }

  const uid = await currentUid()

  // Claimed before anything is fetched, because the provider quota this
  // protects is shared across every user of the deployment — see
  // lib/server/quota.ts. A cache hit costs the provider nothing and is refunded
  // below, so re-opening a video already in the shared cache is free.
  const claim = await spend(uid, 'ingest')
  if (!claim.allowed) return tooManyRequests(claim)

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }

      try {
        const result = await ingestVideo(
          {
            uid,
            ref,
            ...(body.transcript ? { suppliedTranscript: body.transcript } : {}),
          },
          {
            videos: videoStore(),
            history: historyStore(),
            metadata: metadataSource(),
            sources: transcriptSources(body.transcript),
            now: () => Date.now(),
            onProgress: (p: IngestProgress) => send({ type: 'progress', ...p }),
          },
        )
        // Keep it in process so the ask and export routes do not pay for a
        // decode, and so the product still works without Firestore configured.
        if (result.metadata) {
          remember(result.videoId, {
            metadata: result.metadata,
            transcript: result.transcript ?? null,
          })
        }

        // Settle what was claimed up front against what it actually cost. The
        // provider's own limit is hours of video rather than a count of them,
        // so the seconds are recorded even though nothing is capped on them
        // yet — a cap set from measurements beats one set from a guess.
        if (result.fromCache) await refund(uid, 'ingest')
        else if (result.metadata) await recordVideoSeconds(uid, result.metadata.durationSec)

        send({ type: 'result', result })
      } catch (err) {
        // The claim bought a provider call that did not happen. Give it back,
        // or a run of failures quietly eats the day's budget.
        await refund(uid, 'ingest')
        // The orchestrator does not throw for expected conditions, so anything
        // arriving here is a defect rather than a degraded video. Say so.
        send({
          type: 'error',
          message: err instanceof Error ? err.message : 'Ingest failed unexpectedly.',
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
