import { beforeEach, describe, expect, it } from 'vitest'
import { cacheSize, forget, recall, remember } from '@/lib/server/cache'
import { buildTranscript } from '@/domain/transcript'
import { timingFor } from '@/domain/timing'

const metadata = (title: string) => ({
  title,
  channelId: 'c',
  channelTitle: 'ch',
  publishedAt: '2026-01-01',
  durationSec: 100,
})

const transcript = () =>
  buildTranscript({
    videoId: 'v',
    provenance: 'gemini_url',
    language: 'en',
    durationMs: 4000,
    cues: [{ startMs: 0, endMs: 4000, text: 'hello' }],
    timing: timingFor('model_rescaled'),
  })

function fill(n: number, from = 0) {
  for (let i = from; i < from + n; i += 1) {
    remember(`vid${i}`, { metadata: metadata(`v${i}`), transcript: null })
  }
}

beforeEach(() => {
  for (let i = 0; i < 200; i += 1) forget(`vid${i}`)
  forget('a')
  forget('b')
})

describe('the in-process video cache', () => {
  it('returns null for something it has never seen', () => {
    expect(recall('vid999')).toBeNull()
  })

  it('round-trips a video', () => {
    remember('a', { metadata: metadata('Talk'), transcript: transcript() })
    expect(recall('a')?.metadata.title).toBe('Talk')
    expect(recall('a')?.transcript?.cues).toHaveLength(1)
  })

  it('preserves timing, so a cache hit does not downgrade precision', () => {
    remember('a', { metadata: metadata('Talk'), transcript: transcript() })
    expect(recall('a')?.transcript?.timing.source).toBe('model_rescaled')
  })

  it('overwrites rather than duplicating on re-remember', () => {
    remember('a', { metadata: metadata('first'), transcript: null })
    remember('a', { metadata: metadata('second'), transcript: null })
    expect(recall('a')?.metadata.title).toBe('second')
    expect(cacheSize()).toBe(1)
  })

  it('forgets on request', () => {
    remember('a', { metadata: metadata('x'), transcript: null })
    forget('a')
    expect(recall('a')).toBeNull()
  })

  describe('bounded, least-recently-used', () => {
    it('never grows past its limit', () => {
      fill(60)
      expect(cacheSize()).toBeLessThanOrEqual(24)
    })

    it('evicts the least recently used entry', () => {
      fill(24)
      // vid0 is oldest; adding one more should push it out.
      remember('newcomer', { metadata: metadata('new'), transcript: null })
      expect(recall('vid0')).toBeNull()
      expect(recall('newcomer')).not.toBeNull()
      forget('newcomer')
    })

    it('reading an entry keeps it alive', () => {
      fill(24)
      // Touch the oldest so it is no longer the eviction candidate.
      expect(recall('vid0')).not.toBeNull()
      remember('newcomer', { metadata: metadata('new'), transcript: null })
      expect(recall('vid0')).not.toBeNull()
      expect(recall('vid1')).toBeNull()
      forget('newcomer')
    })
  })
})
