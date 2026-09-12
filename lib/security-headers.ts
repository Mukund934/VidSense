/**
 * The headers that stand between untrusted text and the browser.
 *
 * VidSense renders transcripts, titles, descriptions and comments — none of it
 * written by us, all of it reaching a page that holds a signed-in session. The
 * sanitiser in `src/domain/untrusted.ts` is the first line and React's escaping
 * is the second; this is the one that holds when both are wrong.
 *
 * Deliberately shared between `proxy.ts` and `next.config.ts` rather than
 * written twice: a policy that differs between the document and its assets is a
 * policy nobody can reason about.
 *
 * Kept free of `server-only` and of any Node import, because the proxy runs
 * where neither is available.
 */

/** Everything that does not need a per-request value. */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  // Stops a browser guessing that a .md evidence pack is really HTML.
  ['x-content-type-options', 'nosniff'],
  // `frame-ancestors` in the CSP is the real control; this is the same answer
  // for anything still reading the older header.
  ['x-frame-options', 'DENY'],
  // A video id in a path is not a secret, but a referrer is free to leak and
  // buys the user nothing.
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  // The product needs none of these. Saying so removes them from any iframe or
  // script that manages to run.
  [
    'permissions-policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  ],
  // Cross-origin isolation is not on: the YouTube player is an iframe from
  // another origin and COEP would break it. `same-origin` on the opener is
  // still safe, because sign-in uses `window.open` and Firebase's popup keeps
  // its own handle to a window it opened rather than needing ours.
  ['cross-origin-opener-policy', 'same-origin-allow-popups'],
]

/** Hosts the product genuinely talks to, named once each. */
const YOUTUBE_PLAYER = ['https://www.youtube.com', 'https://www.youtube-nocookie.com']
const YOUTUBE_SCRIPTS = ['https://www.youtube.com', 'https://s.ytimg.com']
const GOOGLE_AUTH_SCRIPTS = ['https://apis.google.com', 'https://accounts.google.com']
const FIREBASE_ENDPOINTS = [
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://firebaseinstallations.googleapis.com',
  'https://www.googleapis.com',
]
const AUTH_FRAMES = [
  'https://accounts.google.com',
  'https://*.firebaseapp.com',
  'https://*.web.app',
]

/**
 * The Content-Security-Policy for one request.
 *
 * Nonce-based rather than `'unsafe-inline'` for scripts: Next.js stamps the
 * nonce onto its own hydration scripts when it finds one in the request's CSP
 * header, so the strict policy costs nothing but the plumbing in `proxy.ts`.
 *
 * `'strict-dynamic'` is deliberately absent. The player loads YouTube's IFrame
 * API by inserting a script tag, which `strict-dynamic` would wave through on
 * the strength of the inserting script alone; an explicit host list says which
 * origins may run code here and keeps saying it if that loader ever changes.
 *
 * Styles keep `'unsafe-inline'`, which is honest rather than lazy: Tailwind and
 * React both emit inline style attributes, and no nonce reaches those.
 */
export function contentSecurityPolicy(nonce: string, isDev: boolean): string {
  const scripts = [
    "'self'",
    `'nonce-${nonce}'`,
    ...YOUTUBE_SCRIPTS,
    ...GOOGLE_AUTH_SCRIPTS,
    // React Refresh compiles modules at runtime. Never in a built bundle.
    ...(isDev ? ["'unsafe-eval'"] : []),
  ]

  const connect = [
    "'self'",
    ...FIREBASE_ENDPOINTS,
    // The dev server's hot-reload socket, and nothing else.
    ...(isDev ? ['ws:', 'http://localhost:*'] : []),
  ]

  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://i.ytimg.com https://*.ytimg.com https://*.googleusercontent.com",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    `frame-src ${[...YOUTUBE_PLAYER, ...AUTH_FRAMES].join(' ')}`,
    // Nobody embeds VidSense. A signed-in session inside someone else's page is
    // clickjacking waiting to happen.
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ')
}
