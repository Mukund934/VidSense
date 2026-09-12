import { NextRequest } from 'next/server'

import { ingestVideo, type IngestProgress } from '@/ingest/orchestrator'
import { sendsVideoToProvider } from '@/ingest/source'
import { parseYouTubeUrl } from '@/ingest/url'
import {
  capabilities,
  historyStore,
  metadataSource,
  transcriptSources,
  videoStore,
} from '@/lib/server/deps'
import { describeError, log, uidHash } from '@/lib/server/log'
import { currentUid } from '@/lib/server/session'
import { settle, spend, tooManyRequests } from '@/lib/server/quota'
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
  if (!claim.decision.allowed) return tooManyRequests(claim.decision)

  const encoder = new TextEncoder()
  const startedAt = Date.now()

  /**
   * Settlement, started the instant a provider call becomes certain.
   *
   * The claim above reserved the worst case a video could be, because its
   * length is not knowable before metadata. Holding that worst case until the
   * ingest *finishes* would keep two and a half hours pinned to the deployment
   * ceiling for the length of a transcription — and against a seven-hour
   * ceiling that is most of it, so two concurrent ingests would fill the
   * product however short the videos turned out to be.
   *
   * `onProviderAttempt` fires after the cache missed, after metadata came back
   * and after the too-long refusal, immediately before the first request leaves
   * the machine. Settling there replaces the reservation with the real duration
   * and shrinks the pessimistic window from a whole ingest to a metadata
   * lookup.
   *
   * `undefined` therefore means something precise: no source was ever called,
   * so nothing was spent and the claim goes back in full.
   */
  let settlement: Promise<void> | undefined

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /**
       * Write one event, unless the reader has already gone.
       *
       * A client that navigates away mid-ingest aborts the fetch, which closes
       * the controller under us — and the next `enqueue` throws *inside the
       * catch block that was handling the first failure*, so the real error is
       * replaced by "Invalid state: Controller is already closed". React's
       * development double-mount does this on every page load, which is how it
       * was found.
       */
      let open = true
      const send = (event: unknown) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          open = false
        }
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
            onProviderAttempt: ({ sourceId, durationSec }) => {
              // Once only: a reservation can be settled a single time, and the
              // first source called is the one that spends the video.
              if (settlement) return
              // An ingest always counts as an ingest, but only a source that
              // actually sends the video is charged hours for it — a pasted
              // transcript is parsed locally and costs the provider nothing.
              settlement = settle(claim, {
                charged: true,
                seconds: sendsVideoToProvider(sourceId) ? durationSec : 0,
              })
            },
          },
        )
        log.info('ingest.done', {
          uid: uidHash(uid),
          videoId: result.videoId,
          status: result.status,
          fromCache: result.fromCache,
          hasTranscript: Boolean(result.transcript),
          provenance: result.transcript?.provenance,
          degraded: result.degraded?.reason,
          // Every source that was tried and did not answer. This is the only
          // place the fallback chain's shape is visible from outside.
          attempts: result.attempts.map((a) => `${a.source}:${a.reason}`).join(',') || undefined,
          ms: Date.now() - startedAt,
        })

        // Keep it in process so the ask and export routes do not pay for a
        // decode, and so the product still works without Firestore configured.
        if (result.metadata) {
          remember(result.videoId, {
            metadata: result.metadata,
            transcript: result.transcript ?? null,
          })
        }

        // Either a source was called and settlement is already under way, or
        // none was — a cache hit, an unavailable video, one too long to send —
        // and the whole claim goes back. A *failed* provider call is not
        // refunded: it was still made, and leaving it free would be a way to
        // burn the deployment's day by pasting links known to fail.
        await (settlement ?? settle(claim, { charged: false }))

        send({ type: 'result', result })
      } catch (err) {
        // If a source was already called, what it spent stands. If the throw
        // came before that, the claim bought nothing and goes back — otherwise
        // a run of failures quietly eats the day's budget and, worse, leaves
        // the deployment holding reserved seconds nobody will ever spend.
        await (settlement ?? settle(claim, { charged: false }))
        // The orchestrator does not throw for expected conditions, so anything
        // arriving here is a defect rather than a degraded video. Say so.
        log.error('ingest.failed', {
          uid: uidHash(uid),
          videoId: ref.videoId,
          detail: describeError(err),
          ms: Date.now() - startedAt,
        })
        send({
          type: 'error',
          message: err instanceof Error ? err.message : 'Ingest failed unexpectedly.',
        })
      } finally {
        if (open) {
          try {
            controller.close()
          } catch {
            /* the reader closed it first, which is not our problem */
          }
        }
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
