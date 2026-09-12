/**
 * Production smoke test.
 *
 * Run against a deployment to answer the only question that matters after a
 * deploy: is this thing actually working, or does it merely return 200 on the
 * home page? Everything checked here has failed at least once in some
 * deployment of some product, and every one of them is invisible from the
 * Vercel dashboard.
 *
 *   npx tsx scripts/smoke.ts https://vidsense.example
 *
 * Deliberately makes no authenticated call and never analyses a video: an
 * ingest costs real provider quota out of a budget shared by every user, and a
 * smoke test that spends the day's allowance is a smoke test that causes the
 * outage it is looking for.
 *
 * Exits non-zero on the first failure, so it can gate a release.
 */

const MUST_HAVE_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
]

interface Check {
  readonly name: string
  run(base: string): Promise<string>
}

const checks: Check[] = [
  {
    name: 'health reports a configured deployment',
    async run(base) {
      const res = await fetch(`${base}/api/health`)
      const body = (await res.json()) as {
        ok?: boolean
        required?: Record<string, boolean>
        model?: string | null
      }
      if (res.status !== 200 || !body.ok) {
        const missing = Object.entries(body.required ?? {})
          .filter(([, present]) => !present)
          .map(([name]) => name)
        throw new Error(
          `HTTP ${res.status}${missing.length ? ` — not configured: ${missing.join(', ')}` : ''}`,
        )
      }
      return `model ${body.model}`
    },
  },
  {
    name: 'the landing page renders its own copy',
    async run(base) {
      const res = await fetch(base)
      const html = await res.text()
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      // Something specific, not merely non-empty: a platform error page is also
      // a 200 with a body.
      if (!html.includes('Understand every video')) throw new Error('the hero copy is missing')
      return `${html.length.toLocaleString()} bytes`
    },
  },
  {
    name: 'every security header is present',
    async run(base) {
      const res = await fetch(base)
      const missing = MUST_HAVE_HEADERS.filter((name) => !res.headers.get(name))
      if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`)
      return MUST_HAVE_HEADERS.length + ' headers'
    },
  },
  {
    name: 'the policy carries a per-request nonce',
    async run(base) {
      // Two requests, because a nonce that never changes is not a nonce, and a
      // build that lost the proxy still emits a policy.
      const nonce = async () => {
        const csp = (await fetch(base)).headers.get('content-security-policy') ?? ''
        return /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1]
      }
      const [a, b] = [await nonce(), await nonce()]
      if (!a) throw new Error('no nonce in the policy')
      if (a === b) throw new Error('the same nonce twice — the proxy is not running per request')
      return 'fresh each request'
    },
  },
  {
    name: 'Next.js stamped the nonce onto its scripts',
    async run(base) {
      // The failure this catches is silent and total: a policy with a nonce and
      // scripts without one is a page that renders and never hydrates.
      const html = await (await fetch(base)).text()
      const scripts = html.match(/<script/g)?.length ?? 0
      const nonced = html.match(/<script[^>]*nonce=/g)?.length ?? 0
      if (scripts === 0) throw new Error('no scripts at all — is this the real app?')
      if (nonced < scripts) throw new Error(`${scripts - nonced} of ${scripts} scripts have no nonce`)
      return `${nonced}/${scripts}`
    },
  },
  {
    name: 'a bad video id is a 404, not a crash',
    async run(base) {
      const res = await fetch(`${base}/v/not-a-real-id`)
      if (res.status !== 404) throw new Error(`HTTP ${res.status}`)
      if (!(await res.text()).includes('There is nothing here')) {
        throw new Error('the 404 page did not render')
      }
      return 'renders'
    },
  },
  {
    name: 'the maintenance sweep refuses an unauthenticated caller',
    async run(base) {
      const res = await fetch(`${base}/api/maintenance/sweep`)
      // 503 means CRON_SECRET was never set, which is its own failure — the
      // retention window will not be enforced.
      if (res.status === 503) throw new Error('CRON_SECRET is not set on this deployment')
      if (res.status !== 401) throw new Error(`HTTP ${res.status}, expected 401`)
      return 'refuses'
    },
  },
  {
    name: 'robots keeps crawlers out of the parts that cost money',
    async run(base) {
      const body = await (await fetch(`${base}/robots.txt`)).text()
      // A deployment that does not know its own public URL disallows
      // everything, which is the right answer for a preview and for localhost.
      if (/^Disallow:\s*\/\s*$/m.test(body)) return 'disallows everything (not publicly hosted)'
      for (const path of ['/api/', '/v/']) {
        if (!body.includes(path)) throw new Error(`${path} is not disallowed`)
      }
      return 'disallows /api/ and /v/'
    },
  },
  {
    name: 'no secret is reachable from the browser bundle',
    async run(base) {
      // The one mistake with no way back: a server key given a NEXT_PUBLIC_
      // name is compiled into the HTML and is public the moment it deploys.
      const html = await (await fetch(base)).text()
      for (const name of ['GEMINI_API_KEY', 'YOUTUBE_API_KEY', 'FIREBASE_SERVICE_ACCOUNT']) {
        if (html.includes(name)) throw new Error(`${name} appears in the page source`)
      }
      if (/AIza[0-9A-Za-z_-]{35}/.test(html)) {
        // The Firebase web key is publishable and is not here — it is only in
        // the client bundle, which is a different file. Anything shaped like a
        // Google key in the document is worth stopping for.
        throw new Error('something shaped like a Google API key is in the page source')
      }
      return 'clean'
    },
  },
]

async function main(): Promise<void> {
  const base = process.argv[2]?.replace(/\/+$/, '')
  if (!base) {
    console.error('usage: npx tsx scripts/smoke.ts https://your-deployment')
    process.exit(2)
  }

  console.log(`Smoke testing ${base}\n`)
  let failed = 0

  for (const check of checks) {
    try {
      const detail = await check.run(base)
      console.log(`  PASS  ${check.name}${detail ? ` — ${detail}` : ''}`)
    } catch (err) {
      failed += 1
      console.log(`  FAIL  ${check.name} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(
    `\n${checks.length - failed}/${checks.length} passed.` +
      (failed === 0
        ? ' The deployment is serving correctly.\n\nStill to do by hand: sign in with Google, analyse one short video, ask one question, and check the receipt jumps.'
        : ' Do not announce this deployment.'),
  )
  process.exit(failed === 0 ? 0 : 1)
}

void main()
