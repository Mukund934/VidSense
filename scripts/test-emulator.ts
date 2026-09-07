/**
 * Run the emulator-backed suites: security rules and Firestore adapters.
 *
 * Why this exists instead of a bare `firebase emulators:exec`:
 *
 *   1. **`emulators:exec` kills its own emulator on Windows.** The emulator
 *      starts cleanly — "started in standard edition", websocket up — and then
 *      dies with `3221225786` (`0xC000013A`, `STATUS_CONTROL_C_EXIT`) at the
 *      moment the CLI spawns the test script into the same console. It is a
 *      race: it passes often enough to look fine and fails often enough to be
 *      useless. So we do not use the CLI to run anything — we start the jar it
 *      already downloaded, wait for the port, run the tests, and kill it.
 *   2. **The CLI does not reap the emulator either.** A surviving java process
 *      makes the next run fail with "port taken", so a listener that is already
 *      up is reused rather than fought with.
 *   3. **The ports in `firebase.json` are deliberately not the Firebase
 *      defaults**, because the defaults collide with any other project's
 *      emulator suite on the same machine — and a collision on the *hub* port
 *      tears down the whole suite, Firestore included.
 *
 * Reuse is safe: every suite here clears the data it touches before it runs,
 * and the rules suite re-uploads the current `firestore.rules`, so a reused
 * emulator is never a stale one.
 *
 * One Windows detail worth keeping: the emulator is spawned **without**
 * `detached`. A detached spawn on Windows starts java and then loses it — the
 * process never binds the port and never prints a word — which looks exactly
 * like a hung emulator and is not one.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VITEST = 'vitest run --config vitest.emulator.config.ts'
const STARTUP_TIMEOUT_MS = 60_000
const POLL_MS = 300

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

/** The newest emulator jar the Firebase CLI has already downloaded. */
function emulatorJar(): string {
  const dir = join(homedir(), '.cache', 'firebase', 'emulators')
  const hint = 'Run: firebase setup:emulators:firestore'

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    throw new Error(`No emulator cache at ${dir}. ${hint}`)
  }

  const newest = names
    .filter((name) => /^cloud-firestore-emulator-v[\d.]+\.jar$/.test(name))
    .sort((a, b) => compareVersions(versionOf(a), versionOf(b)))
    .at(-1)

  if (!newest) throw new Error(`No Firestore emulator jar in ${dir}. ${hint}`)
  return join(dir, newest)
}

function versionOf(name: string): number[] {
  return (/v([\d.]+)\.jar$/.exec(name)?.[1] ?? '0').split('.').map(Number)
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Is something already serving the emulator on this port? */
async function isRunning(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

async function waitUntilRunning(host: string, port: number, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false
    if (await isRunning(host, port)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return false
}

/** Kill java and anything it spawned. */
function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGTERM')
}

function runTests(): number {
  // `shell: true` because `vitest` is a shim script on Windows.
  return spawnSync(VITEST, { stdio: 'inherit', shell: true }).status ?? 1
}

async function main(): Promise<void> {
  const { host, port } = firestoreEmulator()

  if (await isRunning(host, port)) {
    console.log(`Reusing the Firestore emulator already on ${host}:${port}.`)
    process.exit(runTests())
  }

  console.log(`Starting a Firestore emulator on ${host}:${port}.`)
  const emulator = spawn('java', ['-jar', emulatorJar(), `--host=${host}`, `--port=${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Held rather than streamed: the emulator is chatty on the happy path, and
  // its output is only worth showing when it fails to come up.
  let output = ''
  const collect = (chunk: Buffer): void => {
    output += chunk.toString()
  }
  emulator.stdout?.on('data', collect)
  emulator.stderr?.on('data', collect)

  let spawnError: Error | undefined
  emulator.on('error', (err) => {
    spawnError = err
  })

  if (!(await waitUntilRunning(host, port, emulator))) {
    stop(emulator)
    console.error(
      spawnError
        ? `Could not start java: ${spawnError.message}`
        : `The Firestore emulator did not answer on ${host}:${port} within ` +
            `${STARTUP_TIMEOUT_MS / 1000}s.`,
    )
    if (output.trim()) console.error(`\n--- emulator output ---\n${output.trim()}`)
    process.exit(1)
  }

  let status = 1
  try {
    status = runTests()
  } finally {
    stop(emulator)
  }
  process.exit(status)
}

void main()
