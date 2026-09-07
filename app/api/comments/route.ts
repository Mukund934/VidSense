import { NextRequest } from 'next/server'
import { commentsSource } from '@/lib/server/deps'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * The VIEWERS SAY sample.
 *
 * Every failure mode is reported distinctly rather than flattened into "could
 * not load comments": a video with comments turned off is a normal video and
 * should read as one, while exhausted quota is an outage and should not be
 * dressed up as a product state.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const videoId = request.nextUrl.searchParams.get('videoId')?.trim()
  if (!videoId) return Response.json({ error: 'videoId is required.' }, { status: 400 })

  const result = await commentsSource().fetch(videoId)
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'disabled' ? 200 : 503
    return Response.json({ reason: result.reason }, { status })
  }

  return Response.json({
    threads: result.threads,
    truncated: result.truncated,
    quotaUnits: result.quotaUnits,
  })
}
