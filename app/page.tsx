import { AnalyzeForm } from '@/components/analyze-form'
import { ReceiptCard } from '@/components/receipt'
import { PrecisionBadge } from '@/components/precision'
import { capabilities } from '@/lib/server/deps'
import { Notice } from '@/components/ui'
import { timingFor, precisionOf } from '@/domain/timing'
import type { Receipt } from '@/domain/transcript'

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

/**
 * What an answer actually looks like, rendered by the component that renders
 * the real ones.
 *
 * Describing a receipt takes a paragraph nobody reads. Showing one takes a
 * glance, teaches the badges before they appear in the product, and cannot
 * drift from the real thing — if the card changes, this changes with it.
 *
 * The timing is `model_rescaled` because that is what v1 actually produces, so
 * the badge here says *within about 17s* rather than flattering itself with
 * `exact`. A landing page that overclaims about precision would be an odd way
 * to introduce a product whose argument is that it does not.
 */
const EXAMPLE: Receipt = (() => {
  const timing = timingFor('model_rescaled')
  return {
    cueStart: 214,
    cueEnd: 215,
    startMs: 872_000,
    endMs: 879_000,
    quote:
      'the pumping lemma is really just a counting argument — if the machine has n states and the string is longer than n, some state has to repeat',
    timing,
    precision: precisionOf(timing),
  }
})()

export default function HomePage() {
  const caps = capabilities()
  const missing = [
    !caps.youtube && 'YOUTUBE_API_KEY',
    !caps.gemini && 'GEMINI_API_KEY',
  ].filter(Boolean) as string[]

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-24">
      <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        {/* One mask reveal, on the one line that is the whole claim. */}
        <span className="vs-mask">
          <span>Understand every video.</span>
        </span>
      </h1>
      <p
        className="vs-enter mt-4 max-w-2xl text-balance text-lg text-muted"
        style={{ '--d': '140ms' } as React.CSSProperties}
      >
        VidSense turns a YouTube video into searchable, evidence-grounded knowledge — so you can ask
        questions, find the moment something was said, and see the words behind every answer.
      </p>

      <div className="vs-enter mt-8" style={{ '--d': '240ms' } as React.CSSProperties}>
        <AnalyzeForm autoFocus />
      </div>

      {missing.length > 0 && (
        <Notice tone="warn" title="Server not fully configured" className="mt-4">
          Missing {missing.join(' and ')}. Ingest will not work until it is set — see the README.
        </Notice>
      )}

      <section
        className="vs-enter mt-14"
        style={{ '--d': '360ms' } as React.CSSProperties}
        aria-labelledby="example-heading"
      >
        <h2 id="example-heading" className="text-sm font-medium text-muted">
          An answer looks like this
        </h2>
        <div className="mt-3">
          <ReceiptCard
            text="A string longer than the state count must revisit a state."
            lane="VIDEO"
            receipt={EXAMPLE}
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          An example, not a real analysis. The claim is separate from the words that support it, the
          lane says where those words came from, and the badge says how precisely the moment is
          known — here, an estimate rather than a measurement.
        </p>
      </section>

      <ol className="vs-reveal mt-16 grid gap-6 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.title}>
            <div className="mb-2 text-xs font-medium tabular-nums text-accent">0{i + 1}</div>
            <h2 className="font-medium">{step.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">{step.body}</p>
          </li>
        ))}
      </ol>

      <section className="vs-reveal mt-16 rounded-xl border border-line bg-surface-raised p-6 shadow-raised">
        <h2 className="font-medium">About the timestamps</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Transcript timing comes from a model, and models are not clocks. VidSense measures how far
          its timestamps can be trusted and labels every receipt with one of three answers. Where a
          quote cannot be placed reliably you get the quote and no jump link, rather than a link
          that lands in the wrong sentence.
        </p>

        {/* The badges themselves, from the component the product uses. The
            vocabulary is worth learning here rather than mid-answer. */}
        <ul className="mt-4 space-y-2.5 text-sm">
          {(
            [
              ['caption_track', 'The moment is known. The jump lands on the sentence.'],
              ['model_rescaled', 'An estimate with a measured error. The jump lands near it.'],
              ['model_raw', 'Never established. The quote stands; there is no jump.'],
            ] as const
          ).map(([source, meaning]) => (
            <li key={source} className="flex flex-wrap items-baseline gap-2">
              <PrecisionBadge timing={timingFor(source)} />
              <span className="text-muted">{meaning}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
