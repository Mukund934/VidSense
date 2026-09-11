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
 *   4. **The emulator's output must go to a file, never to a pipe.** `runTests`
 *      blocks the event loop, so nothing would drain a pipe while the suites
 *      run; the buffer fills and the emulator blocks on its next write. See the
 *      note at the spawn.
 *   5. **A bound port is not a ready emulator.** The first data request after
 *      startup is measurably slow, so `warmUp` makes it here rather than inside
 *      a test's hook.
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
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const VITEST = 'vitest run --config vitest.emulator.config.ts'
const STARTUP_TIMEOUT_MS = 60_000
// The first data request against a cold emulator is slow; see `warmUp`.
const WARMUP_TIMEOUT_MS = 90_000
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

/**
 * Make the emulator answer one real request before any test does.
 *
 * Binding the port is not the same as being ready to serve: the emulator
 * answers `GET /` immediately, and its first *data* request has been measured
 * here at between 1.6s and 13.6s while the JVM warms up. Whoever makes that
 * request pays for it, and the default is a suite's `beforeEach` — which has a
 * 30s budget it is already sharing with the Admin SDK's credential discovery.
 *
 * So the cost is paid here instead, where waiting is the correct behaviour and
 * the budget is generous. A throwaway project id is used so the warm-up can
 * never clear data a test cares about.
 */
async function warmUp(host: string, port: number): Promise<void> {
  const probe = 'vidsense-warmup'
  try {
    await fetch(
      `http://${host}:${port}/emulator/v1/projects/${probe}/databases/(default)/documents`,
      { method: 'DELETE', signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS) },
    )
  } catch {
    // Not fatal. If the emulator is genuinely unwell the suites will say so,
    // with a better error than anything that could be invented here.
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
    // Cheap when it is already warm, and a reused emulator may have been
    // started a second ago by someone else.
    await warmUp(host, port)
    process.exit(runTests())
  }

  console.log(`Starting a Firestore emulator on ${host}:${port}.`)

  // The emulator's output goes to a file rather than to a pipe, and the reason
  // is not tidiness.
  //
  // `runTests` uses `spawnSync`, which blocks this process's event loop for the
  // whole of the test run. A piped child's `'data'` handlers cannot run while
  // that is happening, so nothing drains the pipe; the OS buffer fills, and the
  // emulator's next write to stdout **blocks forever**. The emulator is chatty
  // — the rules suite alone logs a stack of PERMISSION_DENIED lines — so it
  // reliably wedged partway through, and every request after that point hung.
  //
  // The symptom was 14 tests in the last suite to run failing on a 30s hook
  // timeout, taking the run from 20s to 438s, while each suite passed on its
  // own. A file descriptor cannot fill, so the emulator cannot be blocked by
  // what this process happens to be doing.
  const logPath = join(mkdtempSync(join(tmpdir(), 'vidsense-emulator-')), 'firestore.log')
  const logFd = openSync(logPath, 'a')

  const emulator = spawn('java', ['-jar', emulatorJar(), `--host=${host}`, `--port=${port}`], {
    stdio: ['ignore', logFd, logFd],
  })

  let spawnError: Error | undefined
  emulator.on('error', (err) => {
    spawnError = err
  })

  /** The emulator's own account of itself, for when it will not start. */
  const emulatorLog = (): string => {
    try {
      return readFileSync(logPath, 'utf8').trim()
    } catch {
      return ''
    }
  }

  if (!(await waitUntilRunning(host, port, emulator))) {
    stop(emulator)
    closeSync(logFd)
    console.error(
      spawnError
        ? `Could not start java: ${spawnError.message}`
        : `The Firestore emulator did not answer on ${host}:${port} within ` +
            `${STARTUP_TIMEOUT_MS / 1000}s.`,
    )
    const log = emulatorLog()
    if (log) console.error(`\n--- emulator output ---\n${log}`)
    process.exit(1)
  }

  await warmUp(host, port)

  let status = 1
  try {
    status = runTests()
  } finally {
    stop(emulator)
    closeSync(logFd)
  }
  if (status !== 0) console.error(`\nThe emulator's own log is at ${logPath}`)
  process.exit(status)
}

void main()
