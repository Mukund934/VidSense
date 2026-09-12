import 'server-only'

/**
 * What the server says about itself.
 *
 * VidSense had no logging at all, which is survivable while the only operator
 * is watching a terminal and untenable the moment it is deployed: every
 * degraded mode in the product is designed to be silent to the user, so a
 * provider outage, an exhausted quota and a Firestore failure all look
 * identical from outside — like the product working slightly less well.
 *
 * One line of JSON per event, to stdout. Every hosting platform this could run
 * on collects stdout and parses JSON lines, so this needs no vendor, no agent,
 * no dependency and no configuration — which keeps it inside the free-first
 * constraint rather than being the first thing to break it.
 *
 * **What must never appear here.** A key, a session cookie, a question, a
 * transcript, a comment, or a title. The rule is structural rather than a
 * filter: callers pass a small record of scalars they chose, and a uid is
 * passed as `uidHash` rather than as itself. A log that quietly accumulates
 * user content is a second copy of the database with none of its rules.
 */

export type Level = 'info' | 'warn' | 'error'

/** Scalars only. An object here is how a transcript ends up in a log line. */
export type Fields = Record<string, string | number | boolean | null | undefined>

/**
 * A short, stable, non-reversible handle for one identity.
 *
 * Enough to see that one visitor caused forty refusals; not enough to look them
 * up. FNV-1a rather than a real hash because this is a grouping key and not a
 * security boundary — and because pulling in `node:crypto` for it would make
 * this module unusable anywhere that is not Node.
 */
export function uidHash(uid: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < uid.length; i += 1) {
    h ^= uid.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Quiet during tests, so a suite that exercises failure paths stays readable. */
function enabled(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.VITEST === undefined
}

function emit(level: Level, event: string, fields: Fields): void {
  if (!enabled()) return

  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    event,
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) line[key] = value
  }

  const text = JSON.stringify(line)
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

export const log = {
  info: (event: string, fields: Fields = {}) => emit('info', event, fields),
  warn: (event: string, fields: Fields = {}) => emit('warn', event, fields),
  error: (event: string, fields: Fields = {}) => emit('error', event, fields),
}

/**
 * An error, reduced to something safe to print.
 *
 * The message is kept because it is usually the whole diagnosis, and truncated
 * because a provider can return a kilobyte of HTML in one. The stack is not
 * kept: it carries absolute paths and adds nothing a name and a message do not.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300)
  return String(err).slice(0, 300)
}
