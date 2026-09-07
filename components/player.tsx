'use client'

import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'

/**
 * The embedded YouTube player.
 *
 * Uses the public IFrame Player API, which needs no key and consumes no quota —
 * worth stating because almost everything else the product touches does.
 *
 * Seeking is imperative rather than state-driven on purpose: "jump to 14:32" is
 * an event, not a value, and modelling it as state makes a second jump to the
 * same moment do nothing.
 */
export interface PlayerHandle {
  seekTo(ms: number): void
}

interface YouTubePlayer {
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo(): void
  destroy(): void
  getCurrentTime(): number
}

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement, opts: Record<string, unknown>) => YouTubePlayer
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<void> | null = null

function loadApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.YT?.Player) return Promise.resolve()
  if (apiPromise) return apiPromise

  apiPromise = new Promise<void>((resolve) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve()
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    document.head.appendChild(script)
  })
  return apiPromise
}

export function Player({
  videoId,
  onTime,
  ref,
}: {
  videoId: string
  onTime?: (ms: number) => void
  ref?: Ref<PlayerHandle>
}) {
  const mount = useRef<HTMLDivElement>(null)
  const player = useRef<YouTubePlayer | null>(null)

  useImperativeHandle(ref, () => ({
    seekTo(ms: number) {
      player.current?.seekTo(Math.max(0, ms / 1000), true)
      player.current?.playVideo()
    },
  }))

  useEffect(() => {
    let cancelled = false
    let ticker: ReturnType<typeof setInterval> | undefined

    void loadApi().then(() => {
      if (cancelled || !mount.current || !window.YT) return
      player.current = new window.YT.Player(mount.current, {
        videoId,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
      })

      if (onTime) {
        // Polled rather than evented: the IFrame API has no timeupdate, and one
        // read every 500ms is cheap next to a video already decoding.
        ticker = setInterval(() => {
          const t = player.current?.getCurrentTime?.()
          if (typeof t === 'number') onTime(Math.round(t * 1000))
        }, 500)
      }
    })

    return () => {
      cancelled = true
      if (ticker) clearInterval(ticker)
      try {
        player.current?.destroy()
      } catch {
        /* the iframe may already be gone */
      }
      player.current = null
    }
  }, [videoId, onTime])

  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg border border-line bg-black">
      <div ref={mount} className="h-full w-full" />
    </div>
  )
}
