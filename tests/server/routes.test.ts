/**
 * Route handlers, exercised as HTTP.
 *
 * The unit tests already cover the library these call into. What is only
 * reachable here is the contract at the edge: what status a caller gets, what
 * shape comes back, and — for export — that the constraints hold through the
 * HTTP path and not merely in the function underneath it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTranscript, resolveReceipt, type TimedTranscript } from '@/domain/transcript'
import { timingFor } from '@/domain/timing'
import { MAX_VERBATIM_WORDS } from '@/export/evidence-pack'

const metadata = {
  title: 'A Talk / With Slashes',
  channelId: 'c',
  channelTitle: 'Speaker',
  publishedAt: '2026-01-01',
  durationSec: 300,
}

function transcriptOf(texts: string[], timing = timingFor('caption_track')): TimedTranscript {
  return buildTranscript({
    videoId: 'vid12345678',
    provenance: 'gemini_url',
    language: 'en',
    durationMs: texts.length * 4000,
    cues: texts.map((text, i) => ({ startMs: i * 4000, endMs: (i + 1) * 4000, text })),
    timing,
  })
}

const loadVideo = vi.fn()
vi.mock('@/lib/server/video', () => ({ loadVideo: (id: string) => loadVideo(id) }))

const askImpl = vi.fn()
vi.mock('@/answer/ask', async (original) => {
  const actual = await original<typeof import('@/answer/ask')>()
  return { ...actual, ask: (...args: unknown[]) => askImpl(...args) }
})

const verifyEnabled = vi.fn(() => false)
const verifyImpl = vi.fn(async () => ({ entailment: 'supported' as const }))

vi.mock('@/lib/server/deps', () => ({
  completion: () => async () => '[]',
  ModelUnavailableError: class extends Error {},
  commentsSource: () => ({ fetch: async () => ({ ok: false, reason: 'disabled' as const }) }),
  verificationEnabled: () => verifyEnabled(),
  verifier: () => verifyImpl,
}))

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  loadVideo.mockReset()
  askImpl.mockReset()
  verifyEnabled.mockReset()
  verifyEnabled.mockReturnValue(false)
  verifyImpl.mockReset()
  verifyImpl.mockResolvedValue({ entailment: 'supported' })
})

describe('POST /api/ask', () => {
  async function call(body: unknown) {
    const { POST } = await import('@/app/api/ask/route')
    return POST(post('http://localhost/api/ask', body) as never)
  }

  it('rejects a request with no question', async () => {
    const res = await call({ videoId: 'vid12345678' })
    expect(res.status).toBe(400)
  })

  it('rejects a request with no video', async () => {
    expect((await call({ question: 'why?' })).status).toBe(400)
  })

  it('reports a video with no stored transcript rather than answering anyway', async () => {
    loadVideo.mockResolvedValue({ metadata, transcript: null })
    const res = await call({ videoId: 'vid12345678', question: 'why?' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('no_transcript')
  })

  it('reports an unanalysed video', async () => {
    loadVideo.mockResolvedValue(null)
    expect((await call({ videoId: 'vid12345678', question: 'why?' })).status).toBe(409)
  })

  it('returns the answer for a video it holds', async () => {
    loadVideo.mockResolvedValue({ metadata, transcript: transcriptOf(['hello there']) })
    askImpl.mockResolvedValue({ status: 'answered', claims: [], rejected: [] })

    const res = await call({ videoId: 'vid12345678', question: 'why?' })
    expect(res.status).toBe(200)
    expect((await res.json()).answer.status).toBe('answered')
  })

  describe('the entailment gate', () => {
    const withClaim = () => {
      loadVideo.mockResolvedValue({ metadata, transcript: transcriptOf(['the real words']) })
      askImpl.mockResolvedValue({
        status: 'answered',
        claims: [
          {
            text: 'a claim',
            lane: 'VIDEO',
            receipt: resolveReceipt(transcriptOf(['the real words']), 0, 0),
          },
        ],
        rejected: [],
      })
    }

    it('does not run when the flag is off, so an answer costs one call', async () => {
      withClaim()
      const body = await (await call({ videoId: 'vid12345678', question: 'why?' })).json()
      expect(verifyImpl).not.toHaveBeenCalled()
      expect(body.answer.claims[0].verification).toBeUndefined()
    })

    it('runs when the flag is on and marks a checked claim', async () => {
      withClaim()
      verifyEnabled.mockReturnValue(true)
      const body = await (await call({ videoId: 'vid12345678', question: 'why?' })).json()
      expect(verifyImpl).toHaveBeenCalledTimes(1)
      expect(body.answer.claims[0].verification.entailment).toBe('supported')
    })

    it('strips the receipt when the citation does not support the claim', async () => {
      withClaim()
      verifyEnabled.mockReturnValue(true)
      verifyImpl.mockResolvedValue({ entailment: 'not_supported' })

      const body = await (await call({ videoId: 'vid12345678', question: 'why?' })).json()
      expect(body.answer.claims[0].receipt).toBeNull()
      expect(body.answer.claims[0].text).toBe('a claim')
    })
  })

  it('never lets the caller supply the transcript it is cited against', async () => {
    loadVideo.mockResolvedValue({ metadata, transcript: transcriptOf(['the real words']) })
    askImpl.mockResolvedValue({ status: 'answered', claims: [], rejected: [] })

    await call({
      videoId: 'vid12345678',
      question: 'why?',
      transcript: transcriptOf(['forged evidence']),
    })

    // The transcript handed to the answer layer is the stored one, not the body's.
    const used = askImpl.mock.calls[0]![0] as TimedTranscript
    expect(used.cues[0]!.text).toBe('the real words')
  })
})

describe('POST /api/export', () => {
  async function call(body: unknown) {
    const { POST } = await import('@/app/api/export/route')
    return POST(post('http://localhost/api/export', body) as never)
  }

  const receipt = (text: string) => resolveReceipt(transcriptOf([text]), 0, 0)

  it('refuses without a video id', async () => {
    expect((await call({})).status).toBe(400)
  })

  it('refuses a video that was never analysed', async () => {
    loadVideo.mockResolvedValue(null)
    expect((await call({ videoId: 'vid12345678' })).status).toBe(409)
  })

  it('returns markdown as a download', async () => {
    loadVideo.mockResolvedValue({ metadata, transcript: transcriptOf(['x']) })
    const res = await call({
      videoId: 'vid12345678',
      entries: [{ heading: 'Why?', receipt: receipt('because of this') }],
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(await res.text()).toContain('because of this')
  })

  it('sanitises the filename, so a title cannot shape the header', async () => {
    loadVideo.mockResolvedValue({ metadata, transcript: transcriptOf(['x']) })
    const res = await call({ videoId: 'vid12345678', entries: [] })
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).not.toContain('/')
    expect(disposition).toContain('A-Talk-With-Slashes')
  })

  it('enforces the verbatim ceiling through the HTTP path', async () => {
    loadVideo.mockResolvedValue({ metadata, transcript: transcriptOf(['x']) })
    const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ')
    const entries = Array.from({ length: 10 }, (_, i) => ({
      heading: `claim ${i}`,
      receipt: receipt(long),
    }))

    const body = await (await call({ videoId: 'vid12345678', entries })).text()
    // Count only real quotations. The "quote omitted" notices are blockquotes
    // too, and they are not verbatim content from the video.
    const quoted = body
      .split('\n')
      .filter((line) => line.startsWith('> ') && !line.includes('Quote omitted'))
      .map((line) => line.slice(2))
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length

    expect(quoted).toBeLessThanOrEqual(MAX_VERBATIM_WORDS + 5)
    expect(body).toContain('reached its quotation limit')
  })

  it('drops malformed entries rather than failing the whole export', async () => {
    loadVideo.mockResolvedValue({ metadata, transcript: transcriptOf(['x']) })
    const res = await call({
      videoId: 'vid12345678',
      entries: [{ heading: 'ok', receipt: receipt('kept') }, { heading: 'no receipt' }, {}],
    })
    const body = await res.text()
    expect(body).toContain('kept')
    expect(res.status).toBe(200)
  })
})

describe('GET /api/comments', () => {
  it('reports disabled comments with 200, because it is a normal video state', async () => {
    const { GET } = await import('@/app/api/comments/route')
    const url = new URL('http://localhost/api/comments?videoId=vid12345678')
    const res = await GET({ nextUrl: url } as never)
    expect(res.status).toBe(200)
    expect((await res.json()).reason).toBe('disabled')
  })

  it('requires a video id', async () => {
    const { GET } = await import('@/app/api/comments/route')
    const url = new URL('http://localhost/api/comments')
    const res = await GET({ nextUrl: url } as never)
    expect(res.status).toBe(400)
  })
})
