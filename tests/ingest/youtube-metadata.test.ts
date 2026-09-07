import { describe, expect, it, vi } from 'vitest'
import {
  type HttpFn,
  YouTubeMetadataSource,
  classifyItem,
  parseIsoDuration,
} from '@/ingest/sources/youtube-metadata'

const VIDEO_ID = 'dQw4w9WgXcQ'

const ITEM = {
  snippet: {
    title: 'Computer Networks',
    channelId: 'UC123',
    channelTitle: 'Prof X',
    publishedAt: '2026-01-01T00:00:00Z',
    liveBroadcastContent: 'none',
    thumbnails: {
      default: { url: 'https://i.ytimg.com/d.jpg' },
      high: { url: 'https://i.ytimg.com/h.jpg' },
      maxres: { url: 'https://i.ytimg.com/m.jpg' },
    },
  },
  contentDetails: { duration: 'PT2H15M30S' },
  status: { privacyStatus: 'public', uploadStatus: 'processed' },
}

function http(status: number, body: unknown): HttpFn {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    text: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('parseIsoDuration', () => {
  it.each([
    ['PT2H15M30S', 8130],
    ['PT45M', 2700],
    ['PT30S', 30],
    ['PT1H', 3600],
    ['P1DT2H', 93600],
    ['PT0S', 0],
  ])('parses %s to %i seconds', (input, expected) => {
    expect(parseIsoDuration(input)).toBe(expected)
  })

  it.each([[undefined], [null], [''], ['garbage'], [123]])('returns 0 for %s', (input) => {
    expect(parseIsoDuration(input)).toBe(0)
  })
})

describe('classifyItem — availability', () => {
  it('accepts a normal public video', () => {
    const result = classifyItem(ITEM)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.metadata.title).toBe('Computer Networks')
      expect(result.metadata.durationSec).toBe(8130)
      expect(result.availability).toBe('public')
    }
  })

  it('prefers the largest thumbnail', () => {
    const result = classifyItem(ITEM)
    if (result.ok) expect(result.metadata.thumbnailUrl).toBe('https://i.ytimg.com/m.jpg')
  })

  it('falls back down the thumbnail sizes', () => {
    const result = classifyItem({
      ...ITEM,
      snippet: { ...ITEM.snippet, thumbnails: { default: { url: 'https://i.ytimg.com/d.jpg' } } },
    })
    if (result.ok) expect(result.metadata.thumbnailUrl).toBe('https://i.ytimg.com/d.jpg')
  })

  it('marks unlisted videos as unlisted, not public', () => {
    const result = classifyItem({ ...ITEM, status: { privacyStatus: 'unlisted' } })
    expect(result.ok && result.availability).toBe('unlisted')
  })

  it('refuses an upcoming premiere', () => {
    const result = classifyItem({
      ...ITEM,
      snippet: { ...ITEM.snippet, liveBroadcastContent: 'upcoming' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('upcoming')
  })

  it('refuses a stream that is live now', () => {
    const result = classifyItem({
      ...ITEM,
      snippet: { ...ITEM.snippet, liveBroadcastContent: 'live' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('live')
  })

  // A finished livestream is an ordinary video and must not be refused.
  it('accepts a livestream that has ended', () => {
    const result = classifyItem({
      ...ITEM,
      snippet: { ...ITEM.snippet, liveBroadcastContent: 'live' },
      liveStreamingDetails: { actualEndTime: '2026-01-01T02:00:00Z' },
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a private video', () => {
    const result = classifyItem({ ...ITEM, status: { privacyStatus: 'private' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
  })

  it.each(['rejected', 'deleted', 'failed'])('refuses uploadStatus=%s', (uploadStatus) => {
    const result = classifyItem({ ...ITEM, status: { privacyStatus: 'public', uploadStatus } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
  })

  it('tolerates a sparse item without throwing', () => {
    const result = classifyItem({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.metadata.title).toBe('')
      expect(result.metadata.durationSec).toBe(0)
    }
  })
})

describe('classifyItem - untrusted text', () => {
  it('sanitises the title and channel name, which reach the model too', () => {
    const zwsp = '\u200B'
    const result = classifyItem({
      ...ITEM,
      snippet: { ...ITEM.snippet, title: `Real${zwsp} Title`, channelTitle: `Ch${zwsp}an` },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.metadata.title).toBe('Real Title')
    expect(result.metadata.channelTitle).toBe('Chan')
  })

  it('strips a tag-block payload hidden in a title', () => {
    const hidden = [...'OBEY'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')
    const result = classifyItem({ ...ITEM, snippet: { ...ITEM.snippet, title: `Lecture 1${hidden}` } })
    expect(result.ok && result.metadata.title).toBe('Lecture 1')
  })
})

describe('YouTubeMetadataSource', () => {
  it('requests only the parts it needs, by id', async () => {
    const spy = vi.fn<HttpFn>(async () => ({ status: 200, ok: true, text: JSON.stringify({ items: [ITEM] }) }))
    await new YouTubeMetadataSource({ apiKey: 'k', http: spy }).fetch(VIDEO_ID)

    const url = String(spy.mock.calls[0]?.[0])
    expect(url).toContain(`id=${VIDEO_ID}`)
    expect(url).toContain('part=snippet,contentDetails,status,liveStreamingDetails')
    // search.list costs 100 units; it must never appear in a product loop.
    expect(url).not.toContain('/search')
  })

  it('returns metadata for a normal video', async () => {
    const source = new YouTubeMetadataSource({ apiKey: 'k', http: http(200, { items: [ITEM] }) })
    const result = await source.fetch(VIDEO_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.metadata.channelTitle).toBe('Prof X')
  })

  it('reports not_found for an empty items array', async () => {
    const source = new YouTubeMetadataSource({ apiKey: 'k', http: http(200, { items: [] }) })
    const result = await source.fetch(VIDEO_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_found')
  })

  it('surfaces the 403 body, since quota exhaustion and a bad key both land there', async () => {
    const source = new YouTubeMetadataSource({
      apiKey: 'k',
      http: http(403, { error: { message: 'quotaExceeded' } }),
    })
    const result = await source.fetch(VIDEO_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('error')
      expect(result.detail).toContain('quotaExceeded')
    }
  })

  it.each([
    ['a server error', 500, 'boom'],
    ['a non-JSON body', 200, 'not json'],
  ] as const)('handles %s', async (_label, status, body) => {
    const source = new YouTubeMetadataSource({ apiKey: 'k', http: http(status, body) })
    const result = await source.fetch(VIDEO_ID)
    expect(result.ok).toBe(false)
  })

  it('does not throw when the transport fails', async () => {
    const source = new YouTubeMetadataSource({
      apiKey: 'k',
      http: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    const result = await source.fetch(VIDEO_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('ENOTFOUND')
  })

  it('reports a missing key without calling out', async () => {
    const spy = vi.fn<HttpFn>()
    const result = await new YouTubeMetadataSource({ apiKey: undefined, http: spy }).fetch(VIDEO_ID)
    expect(spy).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })
})
