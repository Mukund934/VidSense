/**
 * YouTube Data API experiments.
 *
 * These settle quota arithmetic that the dossier could only estimate, and one
 * question the official documentation genuinely does not answer.
 */

import { DEFAULT_VIDEO_ID, type ExperimentResult, blocked, http, pick, requireEnv } from './lib.js'

const API = 'https://www.googleapis.com/youtube/v3'

/**
 * O3 — What is the real maximum number of video IDs per `videos.list` call?
 *
 * This is the load-bearing unmeasured input in the whole quota model: it decides
 * how cheaply the library's 30-day liveness obligation can be serviced.
 */
export async function o3BatchCeiling(): Promise<ExperimentResult> {
  const apiKey = requireEnv('YOUTUBE_API_KEY')
  if (!apiKey) {
    return blocked('O3-batch-ceiling', 'How many video IDs can one videos.list call take?',
      'set YOUTUBE_API_KEY in .env.local')
  }

  const id = DEFAULT_VIDEO_ID
  const results: Record<string, unknown> = {}
  let ceiling: number | null = null

  for (const n of [50, 51, 100]) {
    const ids = Array.from({ length: n }, () => id).join(',')
    const res = await http(`${API}/videos?part=id&id=${ids}&key=${apiKey}`)
    results[`n=${n}`] = { status: res.status, returned: (pick(res.json, 'items') as unknown[] | undefined)?.length ?? 0 }
    if (!res.ok && ceiling === null) ceiling = n - 1
  }

  return {
    id: 'O3-batch-ceiling',
    question: 'How many video IDs can one videos.list call take?',
    verdict: 'PASS',
    finding: ceiling === null
      ? 'No rejection observed up to 100 IDs — batching is cheaper than the model assumed; recompute the refresh cost downward.'
      : `Rejected above ${ceiling} IDs. Use ${ceiling} as the batch size in the refresh sweep.`,
    evidence: { ...results, NOTE: 'Duplicate IDs are used deliberately: this probes the request limit, not the result set.' },
    ranAt: new Date().toISOString(),
  }
}

/**
 * O4 — Does `captions.list` work on a video you do NOT own?
 *
 * Verified from the docs (2026-09-06): captions.list requires an OAuth scope
 * (youtube.force-ssl or youtubepartner), costs 50 units, and returns ONLY track
 * metadata — never the caption text. What the docs do NOT say is whether it
 * succeeds for a non-owned video. If it 403s, Deep-scan cost falls 81 -> 31 units
 * and the quota ceiling rises ~1.4x.
 *
 * An API key is not sufficient here; this needs a user OAuth access token.
 */
export async function o4CaptionsList(videoId = DEFAULT_VIDEO_ID): Promise<ExperimentResult> {
  const token = requireEnv('YOUTUBE_OAUTH_ACCESS_TOKEN')
  const question = 'Does captions.list succeed on a public video the caller does not own?'

  if (!token) {
    return blocked('O4-captions-list', question,
      'set YOUTUBE_OAUTH_ACCESS_TOKEN in .env.local. An API key will not work — captions.list requires the ' +
      'youtube.force-ssl OAuth scope. Generate a token with `npm run experiment -- oauth-url` and complete consent in a browser.')
  }

  const res = await http(`${API}/captions?part=snippet&videoId=${encodeURIComponent(videoId)}`, {
    headers: { authorization: `Bearer ${token}` },
  })

  const items = (pick(res.json, 'items') as unknown[] | undefined) ?? []

  return {
    id: 'O4-captions-list',
    question,
    verdict: res.status === 403 || res.ok ? 'PASS' : 'INCONCLUSIVE',
    finding: res.ok
      ? `captions.list SUCCEEDS on a non-owned video and returned ${items.length} track(s) — metadata only, no text. Deep-scan keeps the 50-unit line, and track existence/language is available for free-tier UX.`
      : res.status === 403
        ? 'captions.list is FORBIDDEN on a non-owned video. Drop the 50-unit captions.list line from Deep ingest: cost falls 81 -> 31 units and the quota ceiling rises ~1.4x.'
        : `Unexpected HTTP ${res.status}; re-run before concluding.`,
    evidence: {
      status: res.status,
      videoId,
      trackCount: items.length,
      tracks: items.slice(0, 5),
      body: res.ok ? undefined : res.text.slice(0, 400),
      REMINDER: 'captions.download (200 units) is what returns text, and it requires permission to edit the video.',
    },
    ranAt: new Date().toISOString(),
  }
}

/** Print the consent URL needed for O4. Mukund must open it — consent cannot be automated. */
export function oauthUrl(): ExperimentResult {
  const clientId = requireEnv('GOOGLE_CLIENT_ID')
  const redirect = requireEnv('GOOGLE_OAUTH_REDIRECT_URI') ?? 'http://localhost:3000/api/oauth/callback'
  const question = 'What URL grants the youtube.force-ssl scope needed for O4?'

  if (!clientId) return blocked('oauth-url', question, 'set GOOGLE_CLIENT_ID in .env.local')

  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
      access_type: 'offline',
      prompt: 'consent',
    }).toString()

  return {
    id: 'oauth-url',
    question,
    verdict: 'PASS',
    finding: 'Open this URL, consent, then exchange the returned code for an access token and set YOUTUBE_OAUTH_ACCESS_TOKEN.',
    evidence: { url, redirect, scope: 'youtube.force-ssl (read/write; the narrowest scope that permits captions.list)' },
    ranAt: new Date().toISOString(),
  }
}
