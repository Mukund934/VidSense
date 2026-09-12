import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serviceAccount } from '@/lib/server/deps'

/**
 * How the Admin SDK credential is read.
 *
 * Worth its own test because getting it wrong is invisible: the app boots
 * normally, signs nobody in and forgets everything, and every store is written
 * to degrade quietly when there is nowhere to put things. The variable is named
 * `..._PATH` and originally only read a file — which cannot work on a
 * serverless host, where there is nowhere to put one.
 */

const KEY = { type: 'service_account', project_id: 'vidsense-test', private_key: '-----X-----' }

afterEach(() => {
  delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH
})

function withValue(value: string | undefined) {
  if (value === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  else process.env.FIREBASE_SERVICE_ACCOUNT_PATH = value
  return serviceAccount()
}

describe('serviceAccount', () => {
  it('reads the JSON when the variable holds it', () => {
    // The only form that works on Vercel.
    expect(withValue(JSON.stringify(KEY))).toEqual(KEY)
  })

  it('reads the file when the variable holds a path', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vidsense-')), 'key.json')
    writeFileSync(path, JSON.stringify(KEY))
    expect(withValue(path)).toEqual(KEY)
  })

  it('tolerates the whitespace a pasted secret arrives with', () => {
    expect(withValue(`\n  ${JSON.stringify(KEY)}\n`)).toEqual(KEY)
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['a path to nothing', join(tmpdir(), 'vidsense-does-not-exist.json')],
    // Deliberately not a truncated service-account key: `npm run scan:secrets`
    // flags that shape wherever it appears, and a scanner taught to ignore it
    // in a test is a scanner that will ignore the real thing.
    ['malformed JSON', '{"project_id": "vidsense"'],
    ['JSON that is not an object', '{}"'],
  ])('returns null for %s rather than throwing', (_label, value) => {
    // A credential typo should cost the cache, not the product: every store
    // already degrades to "we did not save that".
    expect(withValue(value)).toBeNull()
  })
})
