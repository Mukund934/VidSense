/**
 * Refuse to ship a credential.
 *
 *   npm run scan:secrets
 *
 * The repository is public, and the cost of a mistake here is asymmetric: a key
 * that reaches GitHub is compromised the moment it is pushed, whether or not
 * the commit is later removed, because the object survives in the remote and in
 * anyone's fork. Deleting the line afterwards is not a remedy.
 *
 * So this runs over the files git actually tracks — not the working tree —
 * because the working tree legitimately contains `.env.local`, and what matters
 * is whether git has been told to carry it. It checks two things:
 *
 *   1. **Names.** Some files must never be tracked at all, whatever is inside
 *      them. `.gitignore` already covers these; this asserts it, because an
 *      ignore rule added after a `git add -f` protects nothing.
 *   2. **Contents.** A small set of high-signal patterns for the credential
 *      shapes this project actually handles. Deliberately not a generic entropy
 *      scanner: a check that cries wolf is one people learn to skip, and a
 *      check that is skipped is worth less than no check at all.
 *
 * **A finding never prints the value.** It prints where to look and what shape
 * was found, redacted. A scanner that echoes a secret into a CI log has moved
 * it somewhere new rather than stopped it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Rule {
  readonly id: string
  readonly what: string
  readonly pattern: RegExp
}

/**
 * Contents worth stopping a push for.
 *
 * Every one of these is a shape that is a credential and essentially nothing
 * else. Anything looser belongs in review, not in a gate.
 */
export const CONTENT_RULES: readonly Rule[] = [
  {
    id: 'google-api-key',
    what: 'a Google API key (Gemini, YouTube or Firebase web)',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'google-oauth-client-secret',
    what: 'a Google OAuth client secret',
    pattern: /\bGOCSPX-[0-9A-Za-z_-]{20,}/,
  },
  {
    id: 'google-oauth-token',
    what: 'a Google OAuth access token',
    pattern: /\bya29\.[0-9A-Za-z_-]{20,}/,
  },
  {
    id: 'private-key-block',
    what: 'a PEM private key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    id: 'service-account-json',
    what: 'a Google service-account key file',
    pattern: /"type"\s*:\s*"service_account"/,
  },
  {
    id: 'anthropic-key',
    what: 'an Anthropic API key',
    pattern: /\bsk-ant-[0-9A-Za-z_-]{20,}/,
  },
  {
    id: 'openai-key',
    what: 'an OpenAI API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: 'aws-access-key-id',
    what: 'an AWS access key id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    // A filled-in environment file. `.env.example` is tracked and must stay
    // tracked, so the rule is not "this file exists" but "this file has a value
    // in it" — which is exactly the mistake of editing the template in place
    // instead of copying it to `.env.local` first.
    id: 'populated-env-assignment',
    what: 'an environment variable assigned a real value',
    pattern:
      /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[ \t]*=[ \t]*["']?[^\s"'#]+/,
  },
]

/** Files that must never be tracked, whatever they contain. */
export const FORBIDDEN_PATHS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /(^|\/)\.env$/, what: 'an environment file' },
  // `.env.example` is the one that belongs here; every other `.env.*` does not.
  { pattern: /(^|\/)\.env\.(?!example$)/, what: 'an environment file' },
  { pattern: /\.(?:pem|key|p12|pfx)$/, what: 'a key or certificate file' },
  { pattern: /(^|\/)service-account[^/]*\.json$/, what: 'a service-account key file' },
  { pattern: /(^|\/)client_secret[^/]*\.json$/, what: 'an OAuth client secret file' },
  { pattern: /(^|\/)credentials\.json$/, what: 'a credentials file' },
]

export interface Finding {
  readonly path: string
  /** 1-based. Zero for a finding about the path itself rather than its contents. */
  readonly line: number
  readonly rule: string
  readonly what: string
  /** The match with all but its first characters masked. Never the raw value. */
  readonly redacted: string
}

/**
 * Show enough to find it, not enough to use it.
 *
 * Four leading characters identify which key it is to someone who already holds
 * the real one, and are not enough to reconstruct anything.
 */
export function redact(match: string): string {
  const head = match.slice(0, 4)
  return `${head}${'•'.repeat(Math.min(12, Math.max(0, match.length - 4)))} (${match.length} chars)`
}

/** Every content rule that fires in `text`, with the line each fired on. */
export function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = []
  const lines = text.split(/\r?\n/)

  for (const rule of CONTENT_RULES) {
    // Applied per line so a finding can name one, and so a very large file
    // cannot turn a linear scan into a backtracking one.
    for (const [index, line] of lines.entries()) {
      const match = rule.pattern.exec(line)
      if (!match) continue
      findings.push({
        path,
        line: index + 1,
        rule: rule.id,
        what: rule.what,
        redacted: redact(match[0]),
      })
      break // One report per rule per file is enough to stop the push.
    }
  }

  return findings
}

/** Forbidden-name findings for a tracked path. */
export function scanPath(path: string): Finding[] {
  return FORBIDDEN_PATHS.filter((rule) => rule.pattern.test(path)).map((rule) => ({
    path,
    line: 0,
    rule: 'tracked-forbidden-file',
    what: `${rule.what}, which must never be tracked`,
    redacted: '(the file itself)',
  }))
}

// ------------------------------------------------------------------- the run

/** Paths git is carrying, which is the only set that can leak. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter(Boolean)
}

/** Binary content has no lines to report and no credential shape we look for. */
function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}

/**
 * This file is excluded from the content scan, because it necessarily contains
 * every pattern it looks for. That is a real blind spot, and it is stated
 * rather than hidden: keeping the patterns in one excluded file is a smaller
 * hole than sprinkling them through a workflow that then has to exclude itself
 * as well.
 */
const SELF = resolve(fileURLToPath(import.meta.url))

export function run(): Finding[] {
  const findings: Finding[] = []
  let scanned = 0

  for (const path of trackedFiles()) {
    findings.push(...scanPath(path))
    if (resolve(path) === SELF) continue

    let buffer: Buffer
    try {
      buffer = readFileSync(path)
    } catch {
      continue // In the index but not on disk; there is nothing to read.
    }
    if (isProbablyBinary(buffer)) continue

    scanned += 1
    findings.push(...scanText(path, buffer.toString('utf8')))
  }

  const self = relative(process.cwd(), SELF).replace(/\\/g, '/')
  console.log(`Scanned ${scanned} tracked text files (${self} excluded: it defines the patterns).`)
  return findings
}

function main(): void {
  const findings = run()

  if (findings.length === 0) {
    console.log('No credentials found in tracked files.')
    return
  }

  console.error(`\n${findings.length} finding(s) — nothing may be pushed until these are resolved:\n`)
  for (const f of findings) {
    console.error(`  ${f.line > 0 ? `${f.path}:${f.line}` : f.path}`)
    console.error(`    ${f.rule}: ${f.what}`)
    console.error(`    ${f.redacted}\n`)
  }
  console.error(
    'If one of these is real, treat the key as compromised: rotate it first, then remove it.\n' +
      'Removing the line without rotating leaves a live key in the reflog and in every clone.',
  )
  process.exitCode = 1
}

// Guarded so the module can be imported by tests without running the scan.
if (process.argv[1] && resolve(process.argv[1]) === SELF) main()
