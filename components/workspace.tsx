'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IngestResult, IngestStage } from '@/ingest/orchestrator'
import type { Answer } from '@/answer/contract'
import type { Receipt } from '@/domain/transcript'
import { formatTimestamp } from '@/domain/transcript'
import { ChatPanel, type Turn } from '@/components/chat-panel'
import { IngestProgressView } from '@/components/ingest-progress'
import { MarksPanel } from '@/components/marks-panel'
import { Player, type PlayerHandle } from '@/components/player'
import { TranscriptPanel } from '@/components/transcript-panel'
import { ViewersPanel } from '@/components/viewers-panel'
import { Button, Notice } from '@/components/ui'

type Phase =
  | { kind: 'ingesting'; stage: IngestStage; detail?: string }
  | { kind: 'ready'; result: IngestResult }
  | { kind: 'failed'; message: string }

type Tab = 'transcript' | 'chat' | 'viewers' | 'marks'

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['chat', 'Ask'],
  ['transcript', 'Transcript'],
  ['viewers', 'Viewers say'],
  ['marks', 'Marks'],
]

type ExportState = 'idle' | 'working' | 'done' | 'failed'

export function Workspace({ videoId }: { videoId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ingesting', stage: 'metadata' })
  const [tab, setTab] = useState<Tab>('chat')
  const [currentMs, setCurrentMs] = useState(0)
  const [turns, setTurns] = useState<Turn[]>([])
  const [asking, setAsking] = useState(false)
  const [exporting, setExporting] = useState<ExportState>('idle')
  const player = useRef<PlayerHandle>(null)

  // Ingest is streamed so the wait can say what it is waiting for. A spinner
  // that cannot name its stage is indistinguishable from one that has hung.
  useEffect(() => {
    const controller = new AbortController()

    async function run() {
      try {
        const res = await fetch('/api/ingest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
          signal: controller.signal,
        })

        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string }
          setPhase({
            kind: 'failed',
            message: body.detail ?? body.error ?? 'The server could not start the analysis.',
          })
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line) as
              | { type: 'progress'; stage: IngestStage; detail?: string }
              | { type: 'result'; result: IngestResult }
              | { type: 'error'; message: string }

            if (event.type === 'progress') {
              setPhase({
                kind: 'ingesting',
                stage: event.stage,
                ...(event.detail ? { detail: event.detail } : {}),
              })
            } else if (event.type === 'result') {
              setPhase({ kind: 'ready', result: event.result })
              setTab(event.result.transcript ? 'chat' : 'viewers')
            } else {
              setPhase({ kind: 'failed', message: event.message })
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return
        setPhase({
          kind: 'failed',
          message: err instanceof Error ? err.message : 'The analysis could not be completed.',
        })
      }
    }

    void run()
    return () => controller.abort()
  }, [videoId])

  const seek = useCallback((ms: number) => {
    player.current?.seekTo(ms)
  }, [])

  const askQuestion = useCallback(
    async (question: string) => {
      setAsking(true)
      setTurns((t) => [...t, { question, answer: null }])
      try {
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ videoId, question }),
        })
        const body = (await res.json()) as { answer?: Answer; detail?: string; error?: string }
        setTurns((t) =>
          t.map((turn, i) =>
            i === t.length - 1
              ? body.answer
                ? { ...turn, answer: body.answer }
                : { ...turn, error: body.detail ?? 'The answer could not be generated.' }
              : turn,
          ),
        )
      } catch {
        setTurns((t) =>
          t.map((turn, i) =>
            i === t.length - 1 ? { ...turn, error: 'The request failed. Try again.' } : turn,
          ),
        )
      } finally {
        setAsking(false)
      }
    },
    [videoId],
  )

  const exportPack = useCallback(async () => {
    setExporting('working')
    try {
      const entries = turns.flatMap((turn) =>
        (turn.answer?.status === 'answered' ? turn.answer.claims : [])
          .filter((c): c is typeof c & { receipt: Receipt } => c.receipt !== null)
          .map((c) => ({ heading: turn.question, receipt: c.receipt })),
      )

      // Marks are the user's own work and belong in what they take away. Fetched
      // at export time rather than mirrored in state, so the pack reflects what
      // is actually saved instead of what this tab happens to remember.
      const notes = await fetch(`/api/annotations?videoId=${encodeURIComponent(videoId)}`)
        .then(async (r) => {
          const body = (await r.json()) as { annotations?: Array<{ tMs: number; text: string }> }
          return (body.annotations ?? []).filter((a) => a.text.trim().length > 0)
        })
        .catch(() => [])

      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId, entries, notes }),
      })
      if (!res.ok) {
        setExporting('failed')
        return
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'vidsense-evidence.md'
      link.click()
      URL.revokeObjectURL(url)
      setExporting('done')
      setTimeout(() => setExporting('idle'), 2600)
    } catch {
      setExporting('failed')
    }
  }, [turns, videoId])

  if (phase.kind === 'ingesting') {
    return (
      <IngestProgressView stage={phase.stage} {...(phase.detail ? { detail: phase.detail } : {})} />
    )
  }
  if (phase.kind === 'failed') return <Failed message={phase.message} />

  const { result } = phase
  const transcript = result.transcript ?? null
  const title = result.metadata?.title ?? ''
  const hasReceipts = turns.some((t) => t.answer?.status === 'answered')

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="vs-enter mb-5">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {/* No metadata means the lookup itself failed, which is a different
              thing from a video that has no title. Say the honest one. */}
          {title || 'This video could not be opened'}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {result.metadata?.channelTitle ?? `youtube.com/watch?v=${videoId}`}
          {result.metadata?.durationSec
            ? ` · ${formatTimestamp(result.metadata.durationSec * 1000)}`
            : null}
          {result.fromCache ? ' · reopened from your library' : null}
        </p>
      </header>

      {result.status === 'degraded' && result.degraded && (
        <Notice tone="warn" title="Limited analysis" className="mb-5">
          {result.degraded.message}
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {/* Sticky on a wide screen so the player stays with the transcript
              while the panel beside it scrolls; static on a narrow one, where
              pinning a 16:9 video would eat most of the viewport. */}
          <div className="space-y-3 lg:sticky lg:top-20">
            <Player videoId={videoId} onTime={setCurrentMs} ref={player} />
            {(hasReceipts || tab === 'marks') && (
              <Button
                onClick={() => void exportPack()}
                loading={exporting === 'working'}
                loadingLabel="Building the pack"
                className="w-full"
              >
                {exporting === 'done'
                  ? 'Downloaded'
                  : exporting === 'failed'
                    ? 'That did not work — try again'
                    : 'Export evidence pack'}
              </Button>
            )}
          </div>
        </div>

        <div className="flex h-[calc(100dvh-14rem)] min-h-[26rem] flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-raised lg:h-[36rem]">
          <div role="tablist" aria-label="Video tools" className="flex shrink-0 border-b border-line">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`relative flex-1 px-2 py-2.5 text-sm font-medium transition-colors
                            duration-[var(--dur-fast)] sm:px-3 ${
                              tab === key ? 'text-ink' : 'text-muted hover:text-ink'
                            }`}
              >
                {label}
                {/* Drawn under the label rather than a border on the button, so
                    it can slide in from the centre instead of blinking on. */}
                <span
                  aria-hidden
                  className={`absolute inset-x-0 bottom-0 h-0.5 origin-center bg-accent
                              transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]
                              ${tab === key ? 'scale-x-100' : 'scale-x-0'}`}
                />
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1">
            {tab === 'chat' && (
              <ChatPanel
                turns={turns}
                pending={asking}
                onAsk={(q) => void askQuestion(q)}
                onSeek={seek}
                videoId={videoId}
                title={title}
                disabled={!transcript}
                disabledReason="There is no transcript for this video, so there is nothing to answer from."
              />
            )}
            {tab === 'transcript' &&
              (transcript ? (
                <TranscriptPanel transcript={transcript} currentMs={currentMs} onSeek={seek} />
              ) : (
                <p className="p-6 text-sm text-muted">No transcript is available for this video.</p>
              ))}
            {tab === 'viewers' && <ViewersPanel key={videoId} videoId={videoId} />}
            {tab === 'marks' && (
              <MarksPanel key={videoId} videoId={videoId} currentMs={currentMs} onSeek={seek} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Failed({ message }: { message: string }) {
  return (
    <div className="vs-enter mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-lg font-semibold">That did not work</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">{message}</p>
      <Link
        href="/"
        className="mt-6 inline-block text-sm text-accent underline underline-offset-2 hover:text-accent-hover"
      >
        Try another video
      </Link>
    </div>
  )
}
