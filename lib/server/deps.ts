import 'server-only'

/**
 * Where the application meets the outside world.
 *
 * Every adapter the library takes by injection is constructed here, once, from
 * environment variables — and nowhere else. Route handlers ask for what they
 * need and never read `process.env` themselves, so the set of secrets in play
 * is a list you can read in one file.
 *
 * Nothing here throws when a credential is missing. A key that is absent
 * produces an adapter that reports `not_configured`, which the ingest chain
 * already knows how to route around. Refusing to boot would turn a partial
 * configuration into a blank page.
 */

import { cert, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { readFileSync } from 'node:fs'

import { FirestoreHistoryStore, FirestoreVideoStore } from '@/data/firestore'
import { GeminiUrlSource } from '@/ingest/sources/gemini-url'
import { UserSuppliedSource } from '@/ingest/sources/user-supplied'
import { YouTubeCommentsSource } from '@/ingest/sources/youtube-comments'
import { YouTubeMetadataSource } from '@/ingest/sources/youtube-metadata'
import type { HistoryStore, VideoStore } from '@/ingest/ports'
import type { TranscriptSource } from '@/ingest/source'
import { buildVerifyPrompt, parseVerdict, type Verifier } from '@/answer/verify'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

export function geminiKey(): string | undefined {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || undefined
}

export function youtubeKey(): string | undefined {
  return process.env.YOUTUBE_API_KEY || undefined
}

export function geminiModel(): string {
  return process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
}

/**
 * Which capabilities are actually available.
 *
 * The UI reads this to explain what is missing instead of failing silently —
 * "no Gemini key" is a setup problem with an obvious fix, and it should not
 * present as a broken video.
 */
export function capabilities(): { gemini: boolean; youtube: boolean; firestore: boolean } {
  return { gemini: Boolean(geminiKey()), youtube: Boolean(youtubeKey()), firestore: firestoreReady() }
}

// ------------------------------------------------------------------ firestore

let cachedApp: App | null = null

function firestoreReady(): boolean {
  return Boolean(
    process.env.USE_FIREBASE_EMULATOR === '1' ||
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
  )
}

export function adminApp(): App | null {
  if (cachedApp) return cachedApp
  if (!firestoreReady()) return null

  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'vidsense-local'

  if (process.env.USE_FIREBASE_EMULATOR === '1' && !process.env.FIRESTORE_EMULATOR_HOST) {
    // Read at Firestore construction time, so it has to be set before getFirestore.
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8082'
  }

  try {
    const existing = getApps()
    if (existing.length > 0) {
      cachedApp = existing[0]!
      return cachedApp
    }

    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    cachedApp = initializeApp(
      path
        ? { projectId, credential: cert(JSON.parse(readFileSync(path, 'utf8')) as object) }
        : { projectId },
    )
    return cachedApp
  } catch {
    return null
  }
}

export function firestore(): Firestore | null {
  const app = adminApp()
  if (!app) return null
  try {
    return getFirestore(app)
  } catch {
    return null
  }
}

/**
 * Stores that never throw.
 *
 * A storage outage must degrade to "we did not cache that", not to a failed
 * request — the transcript the user is waiting for has already been paid for.
 * When Firestore is unavailable the product still works; it just forgets.
 */
export function videoStore(): VideoStore {
  const db = firestore()
  if (!db) return { async get() { return null }, async put() {} }
  const real = new FirestoreVideoStore(db)
  return {
    async get(id) {
      try { return await real.get(id) } catch { return null }
    },
    async put(id, doc) {
      try { await real.put(id, doc) } catch { /* forgetting is survivable */ }
    },
  }
}

export function historyStore(): HistoryStore {
  const db = firestore()
  if (!db) return { async touch() {} }
  const real = new FirestoreHistoryStore(db)
  return {
    async touch(uid, entry) {
      try { await real.touch(uid, entry) } catch { /* forgetting is survivable */ }
    },
  }
}

// -------------------------------------------------------------------- sources

export function metadataSource(): YouTubeMetadataSource {
  return new YouTubeMetadataSource({ apiKey: youtubeKey() })
}

export function commentsSource(): YouTubeCommentsSource {
  return new YouTubeCommentsSource({ apiKey: youtubeKey() })
}

export function transcriptSources(suppliedTranscript?: string): TranscriptSource[] {
  const sources: TranscriptSource[] = [
    new GeminiUrlSource({ apiKey: geminiKey(), model: geminiModel() }),
  ]
  // Only in play when the user actually pasted something.
  if (suppliedTranscript) sources.push(new UserSuppliedSource())
  return sources
}

// ------------------------------------------------------------------ verifier

/**
 * Is the entailment gate switched on?
 *
 * Off by default, per **D32**: gate 3 runs offline at launch, and inline is a
 * post-beta decision. Turning it on costs roughly one extra model call per
 * claim, which is a real latency and cost decision rather than a free win.
 *
 * What O20 established is that turning it on is *safe* — measured 2026-09-08 at
 * 0 false positives on 15 definitively-true citations, so the gate does not
 * destroy good evidence. That was the blocking question.
 */
export function verificationEnabled(): boolean {
  return process.env.VERIFY_ANSWERS === '1' && Boolean(geminiKey())
}

/** A `Verifier` backed by Gemini. Question withheld; the span is fenced. */
export function verifier(): Verifier {
  const complete = completion()
  return async ({ claim, evidence }) => {
    const reply = await complete(buildVerifyPrompt(claim, evidence))
    return parseVerdict(reply)
  }
}

// --------------------------------------------------------------------- model

export class ModelUnavailableError extends Error {}

/**
 * A `Completion` for the answer layer, backed by Gemini.
 *
 * The key travels in a header rather than the query string: a URL is the most
 * leak-prone place a credential can sit, because it reaches proxies, error
 * reporters and access logs that a body never touches.
 */
export function completion(): (prompt: string) => Promise<string> {
  const key = geminiKey()
  const model = geminiModel()

  return async (prompt: string) => {
    if (!key) throw new ModelUnavailableError('No Gemini API key is configured.')

    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new ModelUnavailableError(`Gemini returned HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    const payload = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  }
}
