'use client'

import Image from 'next/image'

import type { IngestStage } from '@/ingest/orchestrator'
import { Spinner } from '@/components/ui'

/**
 * The wait, said out loud.
 *
 * Reading a video takes tens of seconds and there is nothing to show while it
 * happens, so this is the first minute of every session and it is worth getting
 * right. A bar that jumps from a third to two thirds tells the user only that
 * something moved. Named steps tell them what has already happened, what is
 * happening now, and what is left — which turns an unbounded wait into a
 * bounded one, and makes a stall legible instead of ambiguous.
 *
 * The three states are deliberately different in kind rather than in shade:
 * done is a tick, running is a spinner, pending is an outline. A reader
 * squinting at a small progress list should not have to compare two greys.
 *
 * The thumbnail is there for a different reason. Somebody who clicked a video
 * in their history and then waited thirty seconds in front of the word "video"
 * has no confirmation they opened the right one. The still is derivable from
 * the id alone — no API call, no key, no quota — so it costs nothing to answer
 * that immediately, before the metadata lookup has returned anything.
 */

const STEPS: ReadonlyArray<{ stage: IngestStage; label: string; done: string }> = [
  { stage: 'metadata', label: 'Looking up the video', done: 'Video found' },
  { stage: 'transcript', label: 'Reading what is said', done: 'Transcript read' },
  { stage: 'storing', label: 'Saving what we found', done: 'Saved' },
]

const ORDER: IngestStage[] = ['metadata', 'transcript', 'storing', 'ready']

export function IngestProgressView({
  stage,
  detail,
  videoId,
}: {
  stage: IngestStage
  detail?: string
  videoId?: string
}) {
  // A cache hit skips the whole sequence, and pretending otherwise would be a
  // fake progress bar for work that is not happening.
  if (stage === 'cached') {
    return (
      <Shell>
        {videoId && <Thumbnail videoId={videoId} />}
        <p className="vs-enter font-medium">Found it — you have analysed this before</p>
        <p className="mt-1 text-sm text-muted">Opening your workspace.</p>
      </Shell>
    )
  }

  const current = Math.max(0, ORDER.indexOf(stage))

  return (
    <Shell>
      {videoId && <Thumbnail videoId={videoId} />}
      <p className="text-sm font-medium text-muted">Reading this video</p>

      <ol className="mt-5 space-y-3.5 text-left">
        {STEPS.map((step, i) => {
          const state = i < current ? 'done' : i === current ? 'running' : 'pending'
          return (
            <li key={step.stage} className="flex items-start gap-3">
              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center">
                {state === 'done' && <Tick />}
                {state === 'running' && <Spinner className="h-4 w-4 text-accent" />}
                {state === 'pending' && (
                  <span className="h-2 w-2 rounded-full border border-line-strong" />
                )}
              </span>
              <span className="min-w-0">
                <span
                  className={`block text-sm transition-colors duration-[var(--dur-base)] ${
                    state === 'pending' ? 'text-muted' : 'text-ink'
                  } ${state === 'running' ? 'font-medium' : ''}`}
                >
                  {state === 'done' ? step.done : step.label}
                </span>
                {/* The source that answered — worth showing, because "via
                    user supplied" and "via gemini url" are different products. */}
                {state === 'running' && detail && (
                  <span className="vs-fade-in mt-0.5 block text-xs text-muted">
                    via {detail.replace(/_/g, ' ')}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ol>

      <p className="mt-6 text-xs leading-relaxed text-muted">
        A long video can take up to a minute. Nothing is downloaded — VidSense reads and reasons.
      </p>
    </Shell>
  )
}

/**
 * The video's own still, from its id.
 *
 * `unoptimized` on purpose. YouTube already serves these at a sensible size and
 * compression, so putting them through the image optimiser buys nothing and
 * spends a metered allowance on every deployment that has one — the same
 * free-first reasoning as everywhere else. `onError` hides it rather than
 * leaving a broken frame: a still that will not load is a cosmetic loss, and
 * the progress list underneath is the part that matters.
 */
function Thumbnail({ videoId }: { videoId: string }) {
  return (
    <Image
      src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
      alt=""
      width={320}
      height={180}
      unoptimized
      onError={(event) => {
        event.currentTarget.style.display = 'none'
      }}
      className="vs-enter mx-auto mb-5 aspect-video w-full rounded-lg border border-line object-cover"
    />
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-sm px-4 py-24 text-center" aria-live="polite" aria-busy="true">
      <div className="vs-enter rounded-xl border border-line bg-surface-raised p-6 shadow-raised">
        {children}
      </div>
    </div>
  )
}

function Tick() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 text-exact">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
