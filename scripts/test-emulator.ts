/**
 * Run the emulator-backed suites: security rules and Firestore adapters.
 *
 * Why this exists instead of a bare `firebase emulators:exec`:
 *
 *   1. On Windows the CLI's shutdown does not reap the emulator's java process.
 *      The run succeeds, the process survives, and the *next* run dies with
 *      "port taken" — a failure whose message points nowhere near its cause.
 *   2. The emulator ports live in `firebase.json` and are deliberately not the
 *      Firebase defaults, because the defaults collide with any other project's
 *      emulator suite on the same machine. A collision on the *hub* port tears
 *      down the whole suite, Firestore included.
 *
 * So: if an emulator is already listening, reuse it. That turns the orphan from
 * a failure into a warm start. Reuse is safe because every suite here clears
 * the data it touches before it runs, and the rules suite re-uploads the current
 * `firestore.rules` — a reused emulator is never a stale one.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const VITEST = 'vitest run --config vitest.emulator.config.ts'

interface FirebaseConfig {
  emulators?: { firestore?: { host?: string; port?: number } }
}

function firestoreEmulator(): { host: string; port: number } {
  const config = JSON.parse(readFileSync('firebase.json', 'utf8')) as FirebaseConfig
  const port = config.emulators?.firestore?.port
  if (typeof port !== 'number') {
    throw new Error('firebase.json does not declare emulators.firestore.port')
  }
  return { host: config.emulators?.firestore?.host ?? '127.0.0.1', port }
}

/** Is something already serving the emulator on this port? */
async function isRunning(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/`, {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

function run(command: string): number {
  // `shell: true` because `firebase` and `vitest` are shim scripts on Windows.
  const result = spawnSync(command, { stdio: 'inherit', shell: true })
  return result.status ?? 1
}

async function main(): Promise<void> {
  const { host, port } = firestoreEmulator()

  if (await isRunning(host, port)) {
    console.log(`Reusing the Firestore emulator already on ${host}:${port}.`)
    process.exit(run(VITEST))
  }

  console.log(`Starting a Firestore emulator on ${host}:${port}.`)
  process.exit(run(`firebase emulators:exec --only firestore "${VITEST}"`))
}

void main()
