import { NextRequest } from 'next/server'

import { buildEvidencePack, type PackEntry } from '@/export/evidence-pack'
import type { Receipt } from '@/domain/transcript'
import { loadVideo } from '@/lib/server/video'

export const runtime = 'nodejs'

interface ExportBody {
  videoId?: string
  entries?: Array<{ heading?: string; receipt?: Receipt }>
  notes?: Array<{ tMs?: number; text?: string }>
}

/**
 * Build the Evidence Pack and hand it back as a file.
 *
 * The verbatim ceiling lives in `buildEvidencePack`, not here, so it cannot be
 * bypassed by calling this route differently.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: ExportBody
  try {
    body = (await request.json()) as ExportBody
  } catch {
    return Response.json({ error: 'Send a JSON body.' }, { status: 400 })
  }

  const videoId = (body.videoId ?? '').trim()
  if (!videoId) return Response.json({ error: 'videoId is required.' }, { status: 400 })

  const video = await loadVideo(videoId)
  if (!video) return Response.json({ error: 'not_analysed' }, { status: 409 })

  const entries: PackEntry[] = (body.entries ?? [])
    .filter((e): e is { heading: string; receipt: Receipt } =>
      Boolean(e.receipt && typeof e.heading === 'string'),
    )
    .map((e) => ({ heading: e.heading, receipt: e.receipt }))

  const notes = (body.notes ?? [])
    .filter((n): n is { tMs: number; text: string } =>
      typeof n.tMs === 'number' && typeof n.text === 'string',
    )
    .map((n) => ({ tMs: n.tMs, text: n.text }))

  const pack = buildEvidencePack({
    video: {
      videoId,
      title: video.metadata.title,
      channelTitle: video.metadata.channelTitle,
      durationSec: video.metadata.durationSec,
    },
    entries,
    notes,
    generatedAt: Date.now(),
  })

  const safeName = (video.metadata.title || 'vidsense')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'vidsense'

  return new Response(pack.markdown, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${safeName}-evidence.md"`,
    },
  })
}
