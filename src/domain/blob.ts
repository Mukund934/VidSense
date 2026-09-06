/**
 * Firestore payload codec.
 *
 * Video knowledge is stored as ONE document per video with the bulk payload in a
 * compressed field, not as one document per transcript cue. The arithmetic that
 * forces this: a 2-hour video is ~1,500 cues, and the Firestore free tier allows
 * 20,000 writes/day. One-doc-per-cue would cap the entire product at 13 videos
 * per day. One-doc-per-video costs ~3 writes and supports thousands.
 *
 * Firestore's hard limit is 1 MiB per document. We hold well under it and fail
 * loudly rather than letting an oversized write reach the network.
 */

import { gunzipSync, gzipSync } from 'node:zlib'

/** Firestore's hard ceiling is 1 MiB; we stop well short to leave room for sibling fields. */
export const MAX_BLOB_BYTES = 800_000

export interface EncodedBlob {
  readonly codec: 'gzip+b64'
  /** Number of items in the encoded collection, so callers can report size without decoding. */
  readonly count: number
  /** Encoded size in bytes, for quota accounting and the pre-write guard. */
  readonly bytes: number
  readonly blob: string
}

export class BlobTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`encoded payload is ${bytes} bytes, over the ${limit}-byte document budget`)
    this.name = 'BlobTooLargeError'
  }
}

/** Compress an array to a single Firestore-safe field. */
export function encodeBlob<T>(items: readonly T[], limit = MAX_BLOB_BYTES): EncodedBlob {
  const json = JSON.stringify(items)
  const blob = gzipSync(Buffer.from(json, 'utf8')).toString('base64')
  const bytes = Buffer.byteLength(blob, 'utf8')
  if (bytes > limit) throw new BlobTooLargeError(bytes, limit)
  return { codec: 'gzip+b64', count: items.length, bytes, blob }
}

/** Inverse of {@link encodeBlob}. */
export function decodeBlob<T>(encoded: EncodedBlob): T[] {
  if (encoded.codec !== 'gzip+b64') {
    throw new Error(`unsupported blob codec: ${String(encoded.codec)}`)
  }
  const json = gunzipSync(Buffer.from(encoded.blob, 'base64')).toString('utf8')
  return JSON.parse(json) as T[]
}

/**
 * Split an oversized collection across several documents.
 *
 * Note what does NOT work here: merging adjacent cues to "coarsen" the transcript
 * saves almost nothing, because after gzip the payload is dominated by the cue
 * *text*, not by the per-cue JSON keys. Collapsing 400 cues into 50 leaves the
 * same words behind. Chunking is the only fallback that actually reduces the size
 * of a single document, so it is the one we implement.
 *
 * Parts are contiguous and ordered; part `n` holds a slice of the original array,
 * so a global index `i` still resolves correctly once the parts are concatenated.
 */
export function encodeChunked<T>(
  items: readonly T[],
  limit = MAX_BLOB_BYTES,
): { parts: EncodedBlob[]; partCount: number } {
  if (items.length === 0) return { parts: [encodeBlob<T>([], limit)], partCount: 1 }

  const parts: EncodedBlob[] = []
  let start = 0

  while (start < items.length) {
    let size = items.length - start
    let encoded: EncodedBlob | null = null

    // Halve the span until it fits, so a pathological run cannot loop forever.
    while (size > 0) {
      try {
        encoded = encodeBlob(items.slice(start, start + size), limit)
        break
      } catch (err) {
        if (!(err instanceof BlobTooLargeError)) throw err
        size = Math.floor(size / 2)
      }
    }

    if (!encoded || size === 0) {
      // A single item exceeds the budget on its own; nothing sensible remains.
      throw new BlobTooLargeError(encodeSize(items.slice(start, start + 1)), limit)
    }

    parts.push(encoded)
    start += size
  }

  return { parts, partCount: parts.length }
}

/** Reassemble the output of {@link encodeChunked} into the original array. */
export function decodeChunked<T>(parts: readonly EncodedBlob[]): T[] {
  return parts.flatMap((p) => decodeBlob<T>(p))
}

function encodeSize<T>(items: readonly T[]): number {
  return Buffer.byteLength(
    gzipSync(Buffer.from(JSON.stringify(items), 'utf8')).toString('base64'),
    'utf8',
  )
}
