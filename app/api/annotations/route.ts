import { NextRequest } from 'next/server'

import {
  VALIDATION_MESSAGE,
  validate,
  type AnnotationKind,
  type NewAnnotation,
} from '@/data/annotations'
import { annotationStore } from '@/lib/server/deps'
import { currentUid } from '@/lib/server/session'

export const runtime = 'nodejs'

/**
 * A user's own marks on one video.
 *
 * Scoped to `users/{uid}` on every path — the uid comes from the session and is
 * never accepted from the request, so one caller cannot read or delete
 * another's marks by asking nicely.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const videoId = request.nextUrl.searchParams.get('videoId')?.trim()
  if (!videoId) return Response.json({ error: 'videoId is required.' }, { status: 400 })

  const store = annotationStore()
  if (!store) return Response.json({ annotations: [], unavailable: true })

  const uid = await currentUid()
  try {
    return Response.json({ annotations: await store.list(uid, videoId) })
  } catch {
    return Response.json({ annotations: [], unavailable: true })
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: Partial<NewAnnotation>
  try {
    body = (await request.json()) as Partial<NewAnnotation>
  } catch {
    return Response.json({ error: 'Send a JSON body.' }, { status: 400 })
  }

  const input: NewAnnotation = {
    kind: (body.kind ?? 'bookmark') as AnnotationKind,
    videoId: String(body.videoId ?? ''),
    tMs: Math.round(Number(body.tMs ?? -1)),
    text: String(body.text ?? ''),
  }

  const problem = validate(input)
  if (problem) {
    return Response.json({ error: problem, detail: VALIDATION_MESSAGE[problem] }, { status: 400 })
  }

  const store = annotationStore()
  if (!store) {
    return Response.json(
      { error: 'unavailable', detail: 'Marks need storage, which this server has not been given.' },
      { status: 503 },
    )
  }

  const uid = await currentUid()
  try {
    return Response.json({ annotation: await store.add(uid, input) }, { status: 201 })
  } catch {
    return Response.json({ error: 'unavailable', detail: 'That mark could not be saved.' }, { status: 503 })
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const id = request.nextUrl.searchParams.get('id')?.trim()
  const kind = request.nextUrl.searchParams.get('kind')?.trim()
  if (!id || (kind !== 'note' && kind !== 'bookmark')) {
    return Response.json({ error: 'id and a valid kind are required.' }, { status: 400 })
  }

  const store = annotationStore()
  if (!store) return Response.json({ ok: true })

  const uid = await currentUid()
  try {
    await store.remove(uid, kind, id)
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
  return Response.json({ ok: true })
}
