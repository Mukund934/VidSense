import { capabilities, geminiModel } from '@/lib/server/deps'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Is this deployment able to do its job?
 *
 * Deliberately not a liveness probe that returns 200 for a process that is
 * running. A VidSense with no Gemini key boots perfectly and cannot analyse
 * anything, which is exactly the failure a deploy is most likely to produce —
 * so `ok` means *configured*, and a missing key is a 503 that a smoke test
 * catches before a user does.
 *
 * Firestore is reported and does not gate `ok`. The product is designed to work
 * without it — it just forgets — so a storage outage is a degradation rather
 * than an outage, and treating it as one would take the site down to protect a
 * cache.
 *
 * Nothing here is a secret. It says which capabilities exist and which model is
 * configured, which is the same thing the settings page shows any visitor, and
 * never a key or any part of one.
 */
export function GET(): Response {
  const caps = capabilities()
  const required = { transcripts: caps.gemini, metadata: caps.youtube }
  const ok = Object.values(required).every(Boolean)

  return Response.json(
    {
      ok,
      required,
      optional: { storage: caps.firestore },
      model: caps.gemini ? geminiModel() : null,
    },
    {
      status: ok ? 200 : 503,
      // A cached health check is a health check for a moment that has passed.
      headers: { 'cache-control': 'no-store' },
    },
  )
}
