'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { isConfigured, signInWithGoogle, signOut } from '@/lib/firebase-client'

/**
 * Sign in, or say why you cannot.
 *
 * Rendered only when Firebase is configured. A deployment without it still
 * works — history follows an anonymous visitor id instead — and showing a
 * button that cannot succeed would be worse than showing none.
 */
export function AuthButton({ signedIn, label }: { signedIn: boolean; label?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isConfigured()) return null

  async function handleSignIn() {
    setBusy(true)
    setError(null)
    const result = await signInWithGoogle()
    setBusy(false)
    if (result.ok) router.refresh()
    else if (result.error) setError(result.error)
  }

  async function handleSignOut() {
    setBusy(true)
    await signOut()
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        disabled={busy}
        onClick={() => void (signedIn ? handleSignOut() : handleSignIn())}
        className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:border-accent disabled:opacity-50"
      >
        {busy ? '…' : signedIn ? 'Sign out' : (label ?? 'Sign in')}
      </button>
      {error && (
        <p role="alert" className="mt-1 max-w-xs text-right text-xs text-approx">
          {error}
        </p>
      )}
    </div>
  )
}
