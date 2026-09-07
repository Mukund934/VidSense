/**
 * Feasibility experiment runner.
 *
 *   npm run experiment            # everything that can run with what is configured
 *   npm run experiment -- O5      # one experiment
 *   npm run experiment -- oauth-url
 *
 * Nothing here is part of the application. These scripts exist to replace
 * assumptions in docs/ARCHITECTURE.md with measurements, and they are safe to
 * delete once every question is answered.
 */

import { type ExperimentResult, loadEnv, report } from './lib.js'
import { c1Drift, clipSupport, o5TokenBilling } from './gemini.js'
import { c1Alignment, c1Windowed } from './alignment.js'
import { o3BatchCeiling, o4CaptionsList, oauthUrl } from './youtube.js'

const EXPERIMENTS: Record<string, () => Promise<ExperimentResult> | ExperimentResult> = {
  O5: o5TokenBilling,
  clip: clipSupport,
  C1: c1Drift,
  'C1-align': c1Alignment,
  'C1-window': c1Windowed,
  O3: o3BatchCeiling,
  O4: o4CaptionsList,
  'oauth-url': oauthUrl,
}

async function main(): Promise<void> {
  loadEnv()

  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const names = requested.length ? requested : Object.keys(EXPERIMENTS)

  const unknown = names.filter((n) => !(n in EXPERIMENTS))
  if (unknown.length) {
    console.error(`Unknown experiment(s): ${unknown.join(', ')}`)
    console.error(`Available: ${Object.keys(EXPERIMENTS).join(', ')}`)
    process.exitCode = 2
    return
  }

  console.log(`VidSense feasibility experiments — running: ${names.join(', ')}`)

  const results: ExperimentResult[] = []
  for (const name of names) {
    try {
      results.push(await EXPERIMENTS[name]!())
    } catch (err) {
      results.push({
        id: name,
        question: '(threw)',
        verdict: 'INCONCLUSIVE',
        finding: `Experiment threw: ${err instanceof Error ? err.message : String(err)}`,
        evidence: {},
        ranAt: new Date().toISOString(),
      })
    }
  }

  for (const r of results) report(r)

  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `\nSummary: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`,
  )

  const blockedOnes = results.filter((r) => r.verdict === 'BLOCKED')
  if (blockedOnes.length) {
    console.log('\nBlocked — these need credentials before they can answer anything:')
    for (const r of blockedOnes) console.log(`  [${r.id}] ${r.finding}`)
  }
}

void main()
