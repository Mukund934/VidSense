import { describe, expect, it } from 'vitest'
import { isVideoUrl, parseTimeParam, parseYouTubeUrl } from '@/ingest/url'

const ID = 'dQw4w9WgXcQ'

describe('parseYouTubeUrl — shapes people actually paste', () => {
  it.each([
    ['standard watch', `https://www.youtube.com/watch?v=${ID}`],
    ['no www', `https://youtube.com/watch?v=${ID}`],
    ['mobile', `https://m.youtube.com/watch?v=${ID}`],
    ['music', `https://music.youtube.com/watch?v=${ID}`],
    ['short link', `https://youtu.be/${ID}`],
    ['shorts', `https://www.youtube.com/shorts/${ID}`],
    ['embed', `https://www.youtube.com/embed/${ID}`],
    ['nocookie embed', `https://www.youtube-nocookie.com/embed/${ID}`],
    ['live', `https://www.youtube.com/live/${ID}`],
    ['legacy /v/', `https://www.youtube.com/v/${ID}`],
    ['http', `http://www.youtube.com/watch?v=${ID}`],
    ['no scheme', `youtube.com/watch?v=${ID}`],
    ['bare id', ID],
    ['surrounding whitespace', `  https://youtu.be/${ID}  `],
  ])('parses %s', (_label, input) => {
    expect(parseYouTubeUrl(input)?.videoId).toBe(ID)
  })

  it('normalises every form to the same canonical url', () => {
    const forms = [
      `https://youtu.be/${ID}?si=trackingjunk`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://m.youtube.com/watch?v=${ID}&feature=share`,
    ]
    for (const f of forms) {
      expect(parseYouTubeUrl(f)?.canonicalUrl).toBe(`https://www.youtube.com/watch?v=${ID}`)
    }
  })

  it('keeps the playlist id as context without treating it as the target', () => {
    const ref = parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PLabc123`)
    expect(ref?.videoId).toBe(ID)
    expect(ref?.listId).toBe('PLabc123')
  })

  it('ignores tracking parameters', () => {
    const ref = parseYouTubeUrl(`https://youtu.be/${ID}?si=abc&utm_source=x&feature=shared`)
    expect(ref?.videoId).toBe(ID)
    expect(ref?.startMs).toBeUndefined()
  })
})

describe('parseYouTubeUrl — timestamps', () => {
  it.each([
    [`https://youtu.be/${ID}?t=90`, 90_000],
    [`https://youtu.be/${ID}?t=90s`, 90_000],
    [`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`, 3_723_000],
    [`https://www.youtube.com/watch?v=${ID}&t=2m30s`, 150_000],
    [`https://www.youtube.com/embed/${ID}?start=45`, 45_000],
  ])('extracts the start offset from %s', (input, expected) => {
    expect(parseYouTubeUrl(input)?.startMs).toBe(expected)
  })

  it('omits startMs rather than guessing when the value is unparseable', () => {
    const ref = parseYouTubeUrl(`https://youtu.be/${ID}?t=soon`)
    expect(ref?.videoId).toBe(ID)
    expect(ref?.startMs).toBeUndefined()
  })
})

describe('parseYouTubeUrl — rejection', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not a url', 'hello world'],
    ['another host', 'https://vimeo.com/12345'],
    ['lookalike host', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
    ['channel page', 'https://www.youtube.com/@somechannel'],
    ['playlist only', 'https://www.youtube.com/playlist?list=PLabc'],
    ['results page', 'https://www.youtube.com/results?search_query=tcp'],
    ['watch with no v', 'https://www.youtube.com/watch'],
    ['id too short', 'https://youtu.be/abc'],
    ['id too long', 'https://youtu.be/dQw4w9WgXcQextra'],
    ['illegal id characters', 'https://www.youtube.com/watch?v=abcdefghij!'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data uri', 'data:text/html,<h1>x</h1>'],
  ])('rejects %s', (_label, input) => {
    expect(parseYouTubeUrl(input)).toBeNull()
    expect(isVideoUrl(input)).toBe(false)
  })

  // A homograph or subdomain trick must not become an ingest of an attacker's choosing.
  it('rejects a host that merely contains youtube.com', () => {
    expect(parseYouTubeUrl(`https://notyoutube.com/watch?v=${ID}`)).toBeNull()
    expect(parseYouTubeUrl(`https://youtube.com.attacker.test/watch?v=${ID}`)).toBeNull()
  })
})

describe('parseTimeParam', () => {
  it.each([
    ['90', 90_000],
    ['90s', 90_000],
    ['1h', 3_600_000],
    ['2m', 120_000],
    ['1h2m3s', 3_723_000],
    ['0', 0],
  ])('parses %s', (input, expected) => {
    expect(parseTimeParam(input)).toBe(expected)
  })

  it.each([[null], [undefined], [''], ['   '], ['abc'], ['1x2y']])(
    'returns null for %s',
    (input) => {
      expect(parseTimeParam(input as string | null | undefined)).toBeNull()
    },
  )
})
