import { notFound } from 'next/navigation'
import { Workspace } from '@/components/workspace'

/** YouTube video ids are 11 characters of URL-safe base64. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

export default async function VideoPage({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params
  // Validated before anything is rendered or fetched: the id reaches an API and
  // a player embed, and neither should be handed something unchecked.
  if (!VIDEO_ID.test(videoId)) notFound()
  return <Workspace videoId={videoId} />
}
