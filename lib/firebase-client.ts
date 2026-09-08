'use client'

/**
 * Firebase in the browser.
 *
 * The web config is publishable by design — safety comes from Security Rules
 * and App Check, not from hiding an identifier that ships in every client
 * bundle anyway. What must never appear here is `GEMINI_API_KEY` or
 * `YOUTUBE_API_KEY`, which are server-only and have no `NEXT_PUBLIC_` form.
 *
 * Everything is lazy. A deployment without Firebase configured should render a
 * working product without an auth button, not fail to boot.
 */

import { getApps, initializeApp, type FirebaseApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
  signOut as fbSignOut,
  type Auth,
} from 'firebase/auth'

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

export function isConfigured(): boolean {
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId)
}

let app: FirebaseApp | null = null

function auth(): Auth | null {
  const { apiKey, authDomain, projectId, appId } = config
  // Narrowed here rather than asserted, so a half-set environment cannot reach
  // initializeApp with an undefined field and fail somewhere less obvious.
  if (!apiKey || !authDomain || !projectId || !appId) return null

  if (!app) app = getApps()[0] ?? initializeApp({ apiKey, authDomain, projectId, appId })
  return getAuth(app)
}

/**
 * Sign in, then hand the ID token to the server so it can be verified there.
 *
 * The browser's opinion of who it is settles nothing. The server verifies the
 * token with the Admin SDK and issues its own session; until it does, the user
 * is not signed in as far as anything that matters is concerned.
 */
export async function signInWithGoogle(): Promise<{ ok: boolean; error?: string }> {
  const instance = auth()
  if (!instance) return { ok: false, error: 'Firebase is not configured on this deployment.' }

  try {
    const credential = await signInWithPopup(instance, new GoogleAuthProvider())
    const idToken = await credential.user.getIdToken()

    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: string }
      return { ok: false, error: body.detail ?? 'The server could not verify that sign-in.' }
    }
    return { ok: true }
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return { ok: false }
    }
    return { ok: false, error: 'Sign-in did not complete.' }
  }
}

export async function signOut(): Promise<void> {
  const instance = auth()
  if (instance) await fbSignOut(instance).catch(() => undefined)
  await fetch('/api/session', { method: 'DELETE' }).catch(() => undefined)
}
