import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { redact, scanPath, scanText } from '../../scripts/scan-secrets'

/**
 * Every fixture here is assembled from fragments rather than written out.
 *
 * This file is itself a tracked file, so a literal key-shaped string in it
 * would be found by the very scan it is testing and would fail the repository
 * check for ever. Concatenating the pieces keeps the shape out of the source
 * while still producing the exact string at runtime. The last test in this file
 * asserts that this actually worked.
 */
const GOOGLE_KEY = `AIza${'Sy'}${'b'.repeat(33)}`
const PEM_HEADER = `-----BEGIN ${'PRIVATE KEY'}-----`
const SERVICE_ACCOUNT = `{"type": "service${'_account'}", "project_id": "x"}`
const ANTHROPIC_KEY = `sk-${'ant'}-api03-${'z'.repeat(24)}`
const AWS_ID = `AKIA${'ABCDEFGHIJKLMNOP'}`

function ruleIds(text: string): string[] {
  return scanText('fixture.txt', text).map((f) => f.rule)
}

describe('scanText', () => {
  it('finds a Google API key', () => {
    expect(ruleIds(`const key = "${GOOGLE_KEY}"`)).toContain('google-api-key')
  })

  it('finds a PEM private key block', () => {
    expect(ruleIds(PEM_HEADER)).toContain('private-key-block')
  })

  it('finds a service-account key file', () => {
    expect(ruleIds(SERVICE_ACCOUNT)).toContain('service-account-json')
  })

  it('finds an Anthropic key, which this project should never hold at all', () => {
    expect(ruleIds(ANTHROPIC_KEY)).toContain('anthropic-key')
  })

  it('finds an AWS access key id', () => {
    expect(ruleIds(AWS_ID)).toContain('aws-access-key-id')
  })

  it('reports the line the secret is on, not the file alone', () => {
    const text = ['first', 'second', `key=${GOOGLE_KEY}`].join('\n')
    const found = scanText('fixture.txt', text).find((f) => f.rule === 'google-api-key')
    expect(found?.line).toBe(3)
  })

  describe('environment assignments', () => {
    it('fires on a variable that has been given a value', () => {
      expect(ruleIds(`GEMINI_API_KEY=${'abc123'}`)).toContain('populated-env-assignment')
    })

    it('stays quiet on the empty template, which is tracked on purpose', () => {
      // This is `.env.example` verbatim in shape. If this ever fires, the
      // template stops being committable and the setup instructions break.
      const template = ['# comment', 'GEMINI_API_KEY=', 'YOUTUBE_API_KEY=', 'VERIFY_ANSWERS=0'].join(
        '\n',
      )
      expect(ruleIds(template)).not.toContain('populated-env-assignment')
    })

    it('stays quiet on an empty quoted value', () => {
      expect(ruleIds('MY_SECRET=""')).not.toContain('populated-env-assignment')
    })

    it('stays quiet on code that merely reads the variable', () => {
      expect(ruleIds('return process.env.GEMINI_API_KEY || undefined')).toEqual([])
    })

    it('stays quiet on prose that names the variable', () => {
      expect(ruleIds('Set GEMINI_API_KEY before running the experiments.')).toEqual([])
    })
  })

  it('says nothing about ordinary source', () => {
    expect(ruleIds('export function resolveReceipt(transcript, cueStart, cueEnd) {}')).toEqual([])
  })
})

describe('redact', () => {
  it('never returns the value it was given', () => {
    const shown = redact(GOOGLE_KEY)
    expect(shown).not.toContain(GOOGLE_KEY)
    expect(shown.startsWith('AIza')).toBe(true)
  })

  it('keeps at most four characters of the original', () => {
    // Enough to recognise which key it is when you hold the real one; not
    // enough to be a key.
    const shown = redact(GOOGLE_KEY)
    const kept = shown.split('•')[0] ?? ''
    expect(kept.length).toBeLessThanOrEqual(4)
  })

  it('reports the length, because that is how you tell two keys apart', () => {
    expect(redact(GOOGLE_KEY)).toContain(`(${GOOGLE_KEY.length} chars)`)
  })
})

describe('scanPath', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'config/.env.local',
    'server.pem',
    'certs/server.key',
    'service-account.json',
    'secrets/service-account-prod.json',
    'client_secret_1234.json',
    'credentials.json',
  ])('refuses to let %s be tracked', (path) => {
    expect(scanPath(path)).toHaveLength(1)
  })

  it.each(['.env.example', 'app/page.tsx', 'firestore.rules', 'docs/ARCHITECTURE.md'])(
    'leaves %s alone',
    (path) => {
      expect(scanPath(path)).toEqual([])
    },
  )
})

describe('this test file', () => {
  it('contains nothing the scanner would flag', () => {
    // The fixtures above are built at runtime for exactly this reason. If this
    // fails, a literal secret shape has been written into the source and the
    // repository-wide scan is about to start failing on it.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    expect(scanText('this.test.ts', source)).toEqual([])
  })
})
