import { AnalyzeForm } from '@/components/analyze-form'
import { capabilities } from '@/lib/server/deps'

const STEPS = [
  {
    title: 'Paste a link',
    body: 'Any YouTube watch, share or Shorts URL. Nothing is downloaded — VidSense reads and reasons.',
  },
  {
    title: 'Ask anything',
    body: 'Questions about what was said, when it was said, and how long was spent on it.',
  },
  {
    title: 'See the evidence',
    body: 'Every claim carries the words it came from, and an honest statement of how precisely we know when.',
  },
]

export default function HomePage() {
  const caps = capabilities()
  const missing = [
    !caps.youtube && 'YOUTUBE_API_KEY',
    !caps.gemini && 'GEMINI_API_KEY',
  ].filter(Boolean) as string[]

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-24">
      <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        Understand every video.
      </h1>
      <p className="mt-4 max-w-2xl text-balance text-lg text-muted">
        VidSense turns a YouTube video into searchable, evidence-grounded knowledge — so you can ask
        questions, find the moment something was said, and see the words behind every answer.
      </p>

      <div className="mt-8">
        <AnalyzeForm autoFocus />
      </div>

      {missing.length > 0 && (
        <p className="mt-4 rounded-lg border border-approx/40 bg-approx-soft px-4 py-3 text-sm">
          <strong className="font-medium">Server not fully configured.</strong> Missing{' '}
          {missing.join(' and ')}. Ingest will not work until it is set — see the README.
        </p>
      )}

      <ol className="mt-16 grid gap-6 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title}>
            <div className="mb-2 text-xs font-medium tabular-nums text-accent">0{i + 1}</div>
            <h2 className="font-medium">{step.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">{step.body}</p>
          </li>
        ))}
      </ol>

      <section className="mt-16 rounded-xl border border-line bg-surface-raised p-6">
        <h2 className="font-medium">About the timestamps</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Transcript timing comes from a model, and models are not clocks. VidSense measures how far
          its timestamps can be trusted and labels every receipt accordingly — an{' '}
          <span className="text-exact">exact</span> moment, a moment{' '}
          <span className="text-approx">within a few seconds</span>, or one whose{' '}
          <span className="text-unlocated">timing was never established</span>. Where we cannot place
          a quote reliably, you get the quote and no jump link, rather than a link that lands in the
          wrong sentence.
        </p>
      </section>
    </div>
  )
}
