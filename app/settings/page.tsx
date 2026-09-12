import { DeleteData } from '@/components/delete-data'
import { capabilities, geminiModel } from '@/lib/server/deps'

export const dynamic = 'force-dynamic'

function Row({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <li className="vs-enter flex items-start justify-between gap-4 border-b border-line py-3 last:border-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-sm text-muted">{detail}</p>
      </div>
      <span
        className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
          ok ? 'border-exact/40 bg-exact-soft text-exact' : 'border-approx/40 bg-approx-soft text-approx'
        }`}
      >
        {ok ? 'configured' : 'missing'}
      </span>
    </li>
  )
}

export default function SettingsPage() {
  const caps = capabilities()

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="mt-8">
        <h2 className="font-medium">What this server can do</h2>
        <p className="mt-1 text-sm text-muted">
          Names only — VidSense never displays a key.
        </p>
        <ul className="mt-4 rounded-xl border border-line bg-surface-raised px-4">
          <Row
            label="Transcripts"
            ok={caps.gemini}
            detail={caps.gemini ? `Gemini · ${geminiModel()}` : 'Set GEMINI_API_KEY to analyse videos.'}
          />
          <Row
            label="Video details and comments"
            ok={caps.youtube}
            detail={caps.youtube ? 'YouTube Data API v3' : 'Set YOUTUBE_API_KEY.'}
          />
          <Row
            label="Saved history"
            ok={caps.firestore}
            detail={
              caps.firestore
                ? 'Firestore'
                : 'Without Firestore, analysis works but is not remembered.'
            }
          />
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="font-medium">How timestamps are treated</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Transcript timing comes from a model, and models are not clocks. VidSense measures how far
          it can trust them and labels every receipt accordingly. Where a moment cannot be placed
          reliably you get the quote and no jump link, rather than a link that lands in the wrong
          sentence.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="font-medium">Your data</h2>
        <p className="mt-2 mb-4 text-sm leading-relaxed text-muted">
          VidSense stores which videos you analysed and what you asked. It never downloads or stores
          video or audio.
        </p>
        <DeleteData />
      </section>
    </div>
  )
}
