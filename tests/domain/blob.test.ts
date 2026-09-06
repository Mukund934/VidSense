import { describe, expect, it } from 'vitest'
import {
  BlobTooLargeError,
  MAX_BLOB_BYTES,
  decodeBlob,
  decodeChunked,
  encodeBlob,
  encodeChunked,
} from '@/domain/blob'
import type { Cue } from '@/domain/transcript'

function syntheticCues(count: number, wordsPerCue = 12): Cue[] {
  const words = 'the quick brown fox jumps over a lazy dog while packets traverse the network'.split(
    ' ',
  )
  return Array.from({ length: count }, (_, i) => ({
    i,
    startMs: i * 4_000,
    endMs: (i + 1) * 4_000,
    text: Array.from({ length: wordsPerCue }, (_, w) => words[(i + w) % words.length]).join(' '),
  }))
}

describe('encodeBlob / decodeBlob', () => {
  it('round-trips exactly', () => {
    const cues = syntheticCues(50)
    expect(decodeBlob<Cue>(encodeBlob(cues))).toEqual(cues)
  })

  it('reports item count and encoded size', () => {
    const encoded = encodeBlob(syntheticCues(50))
    expect(encoded.count).toBe(50)
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.blob, 'utf8'))
    expect(encoded.codec).toBe('gzip+b64')
  })

  it('handles an empty array', () => {
    expect(decodeBlob(encodeBlob([]))).toEqual([])
  })

  it('rejects an unknown codec rather than guessing', () => {
    const bad = { ...encodeBlob([1, 2]), codec: 'brotli' as unknown as 'gzip+b64' }
    expect(() => decodeBlob(bad)).toThrow(/unsupported blob codec/)
  })

  it('throws once over the document budget', () => {
    expect(() => encodeBlob(syntheticCues(200), 200)).toThrow(BlobTooLargeError)
  })
})

// The load-bearing claim from the architecture doc: a 2-hour transcript fits in
// one Firestore document with room to spare. If this ever fails, the storage
// design is invalid and must be revisited before anything else.
describe('the 2-hour video budget', () => {
  it('encodes ~1,500 cues well under the document limit', () => {
    const encoded = encodeBlob(syntheticCues(1_500))
    expect(encoded.bytes).toBeLessThan(MAX_BLOB_BYTES)
    // Leave real headroom, not a hairline pass.
    expect(encoded.bytes).toBeLessThan(MAX_BLOB_BYTES / 2)
  })

  it('compresses substantially versus raw JSON', () => {
    const cues = syntheticCues(1_500)
    const raw = Buffer.byteLength(JSON.stringify(cues), 'utf8')
    expect(encodeBlob(cues).bytes).toBeLessThan(raw / 2)
  })
})

describe('encodeChunked', () => {
  it('returns a single part when everything fits', () => {
    const out = encodeChunked(syntheticCues(100))
    expect(out.partCount).toBe(1)
  })

  it('splits into multiple parts under a tight budget', () => {
    const cues = syntheticCues(400)
    const tight = Math.floor(encodeBlob(cues).bytes / 4)
    const out = encodeChunked(cues, tight)
    expect(out.partCount).toBeGreaterThan(1)
    for (const part of out.parts) expect(part.bytes).toBeLessThanOrEqual(tight)
  })

  it('round-trips losslessly across parts, preserving order', () => {
    const cues = syntheticCues(400)
    const out = encodeChunked(cues, Math.floor(encodeBlob(cues).bytes / 4))
    expect(decodeChunked<Cue>(out.parts)).toEqual(cues)
  })

  it('keeps global cue indices resolvable after reassembly', () => {
    const cues = syntheticCues(400)
    const out = encodeChunked(cues, Math.floor(encodeBlob(cues).bytes / 5))
    const round = decodeChunked<Cue>(out.parts)
    expect(round.map((c) => c.i)).toEqual(cues.map((c) => c.i))
    expect(round[321]!.startMs).toBe(cues[321]!.startMs)
  })

  it('handles an empty array as one empty part', () => {
    const out = encodeChunked<Cue>([])
    expect(out.partCount).toBe(1)
    expect(decodeChunked<Cue>(out.parts)).toEqual([])
  })

  it('throws when even a single item exceeds the budget', () => {
    expect(() => encodeChunked(syntheticCues(10), 20)).toThrow(BlobTooLargeError)
  })
})
