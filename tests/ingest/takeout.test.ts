import { describe, expect, it } from 'vitest'
import { MAX_ENTRIES, TAKEOUT_MESSAGE, parseTakeout } from '@/ingest/takeout'

/** A watch entry shaped the way Takeout actually writes them. */
const watch = (videoId: string, time: string, over: Record<string, unknown> = {}) => ({
  header: 'YouTube',
  title: 'Watched Something',
  titleUrl: `https://www.youtube.com/watch?v=${videoId}`,
  subtitles: [{ name: 'A Channel', url: 'https://www.youtube.com/channel/UC123' }],
  time,
  products: ['YouTube'],
  activityControls: ['YouTube watch history'],
  ...over,
})

const search = (query: string) => ({
  header: 'YouTube',
  title: `Searched for ${query}`,
  titleUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  time: '2026-01-01T00:00:00.000Z',
  products: ['YouTube'],
})

const ad = (videoId: string) =>
  watch(videoId, '2026-01-01T00:00:00.000Z', {
    details: [{ name: 'From Google Ads' }],
  })

const parse = (records: unknown[], limit?: number) =>
  parseTakeout(JSON.stringify(records), limit)

const A = 'dQw4w9WgXcQ'
const B = 'jNQXAC9IVRw'
const C = '8S0FDjFBj8o'

describe('parseTakeout', () => {
  it('extracts a video id and a timestamp, and nothing else', () => {
    const result = parse([watch(A, '2026-03-01T12:00:00.000Z')])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Titles, channels and the rest of the record are dropped here and never
    // leave the parser.
    expect(result.entries).toEqual([
      { videoId: A, watchedAt: Date.parse('2026-03-01T12:00:00.000Z') },
    ])
    expect(Object.keys(result.entries[0]!)).toEqual(['videoId', 'watchedAt'])
  })

  it('orders the newest watch first', () => {
    const result = parse([
      watch(A, '2026-01-01T00:00:00.000Z'),
      watch(B, '2026-06-01T00:00:00.000Z'),
      watch(C, '2026-03-01T00:00:00.000Z'),
    ])
    expect(result.ok && result.entries.map((e) => e.videoId)).toEqual([B, C, A])
  })

  it('collapses repeat views, keeping the most recent', () => {
    const result = parse([
      watch(A, '2026-01-01T00:00:00.000Z'),
      watch(A, '2026-05-01T00:00:00.000Z'),
      watch(A, '2026-03-01T00:00:00.000Z'),
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.watchedAt).toBe(Date.parse('2026-05-01T00:00:00.000Z'))
    expect(result.stats.duplicates).toBe(2)
  })

  describe('what it refuses to call a watch', () => {
    it('drops searches', () => {
      const result = parse([watch(A, '2026-01-01T00:00:00.000Z'), search('cats')])
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.entries).toHaveLength(1)
      expect(result.stats.notVideos).toBe(1)
    })

    it('drops adverts, because being shown something is not watching it', () => {
      const result = parse([watch(A, '2026-01-01T00:00:00.000Z'), ad(B)])
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.entries.map((e) => e.videoId)).toEqual([A])
      expect(result.stats.ads).toBe(1)
    })

    it('drops a removed video, which carries no url', () => {
      const removed = {
        header: 'YouTube',
        title: 'Watched a video that has been removed',
        time: '2026-01-01T00:00:00.000Z',
      }
      const result = parse([watch(A, '2026-01-01T00:00:00.000Z'), removed])
      expect(result.ok && result.entries).toHaveLength(1)
    })

    it('drops a channel visit', () => {
      const visit = {
        header: 'YouTube',
        title: 'Visited a channel',
        titleUrl: 'https://www.youtube.com/@someone',
        time: '2026-01-01T00:00:00.000Z',
      }
      expect(parse([watch(A, '2026-01-01T00:00:00.000Z'), visit]).ok).toBe(true)
      const result = parse([watch(A, '2026-01-01T00:00:00.000Z'), visit])
      expect(result.ok && result.entries).toHaveLength(1)
    })

    it('drops anything on a host it does not recognise', () => {
      const elsewhere = {
        titleUrl: 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
        time: '2026-01-01T00:00:00.000Z',
      }
      const result = parse([elsewhere])
      expect(result.ok).toBe(false)
    })

    it('drops an entry with no usable time', () => {
      const result = parse([watch(A, 'not a date')])
      expect(result.ok).toBe(false)
    })

    it('survives junk in the array', () => {
      const result = parse([null, 'string', 42, watch(A, '2026-01-01T00:00:00.000Z')])
      expect(result.ok && result.entries).toHaveLength(1)
    })
  })

  it('keeps a YouTube Music watch', () => {
    // music.youtube.com is a host the URL parser already accepts, and a song
    // watched is still a video watched.
    const music = watch(A, '2026-01-01T00:00:00.000Z', {
      header: 'YouTube Music',
      titleUrl: `https://music.youtube.com/watch?v=${A}`,
    })
    expect(parse([music]).ok).toBe(true)
  })

  describe('the cap', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        watch(
          `vid${String(i).padStart(8, '0')}`.slice(0, 11),
          new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString(),
        ),
      )

    it('keeps the most recent entries when there are more than it holds', () => {
      const result = parseTakeout(JSON.stringify(many(50)), 10)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.entries).toHaveLength(10)
      // Newest first, so the cap takes the newest rather than the oldest.
      expect(result.entries[0]!.watchedAt).toBeGreaterThan(result.entries[9]!.watchedAt)
      expect(result.stats.videos).toBe(50)
      expect(result.stats.kept).toBe(10)
    })

    it('defaults to a size that stays inside one document', () => {
      expect(MAX_ENTRIES).toBe(5_000)
    })
  })

  describe('files that are not what the user thought', () => {
    it('recognises the HTML export and says which setting to change', () => {
      const result = parseTakeout('<!DOCTYPE html><html><body>Watch history</body></html>')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('html_export')
      expect(TAKEOUT_MESSAGE.html_export).toMatch(/choosing JSON/i)
    })

    it('rejects text that is not JSON at all', () => {
      const result = parseTakeout('this is not json')
      expect(result.ok === false && result.reason).toBe('not_json')
    })

    it('rejects JSON that is not a Takeout array', () => {
      const result = parseTakeout('{"watchHistory": []}')
      expect(result.ok === false && result.reason).toBe('not_an_array')
    })

    it('says plainly when a file holds no watches', () => {
      const result = parse([search('cats'), search('dogs')])
      expect(result.ok === false && result.reason).toBe('no_watches')
      expect(TAKEOUT_MESSAGE.no_watches).toMatch(/search history/i)
    })

    it('has a human sentence for every failure', () => {
      for (const message of Object.values(TAKEOUT_MESSAGE)) {
        expect(message.length).toBeGreaterThan(20)
      }
    })
  })

  it('counts what it saw, so the user can see what was dropped', () => {
    const result = parse([
      watch(A, '2026-01-01T00:00:00.000Z'),
      watch(A, '2026-02-01T00:00:00.000Z'),
      watch(B, '2026-01-01T00:00:00.000Z'),
      search('cats'),
      ad(C),
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stats).toEqual({
      total: 5,
      videos: 3,
      notVideos: 1,
      ads: 1,
      duplicates: 1,
      kept: 2,
    })
  })
})
