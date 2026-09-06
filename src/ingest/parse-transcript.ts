/**
 * Parse a transcript a user pasted or uploaded.
 *
 * This is the fallback that needs no provider, no quota and no policy argument:
 * the user already has the text, and we turn it into cues. It accepts the three
 * formats people actually have — WebVTT, SRT, and plain text with timestamps —
 * and detects which by inspection rather than by asking.
 */

export interface ParsedCue {
  startMs: number
  endMs: number
  text: string
}

export type TranscriptFormat = 'vtt' | 'srt' | 'timestamped_text' | 'unknown'

/** `00:01:02,345` / `00:01:02.345` / `01:02.345` / `1:02` */
function parseClock(value: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1] ?? 0)
  const min = Number(m[2])
  const sec = Number(m[3])
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0
  if (min > 59 || sec > 59) return null
  return ((h * 60 + min) * 60 + sec) * 1000 + frac
}

export function detectFormat(raw: string): TranscriptFormat {
  const text = raw.trimStart()
  if (/^WEBVTT/i.test(text)) return 'vtt'
  if (/^\d+\s*\r?\n\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/m.test(text)) return 'srt'
  if (/-->/.test(text)) return 'vtt'
  if (/(?:^|\n)\s*[[(]?\d{1,2}:\d{2}(?::\d{2})?[\])]?/.test(text)) return 'timestamped_text'
  return 'unknown'
}

/** Cue blocks separated by a `-->` timing line. Covers both VTT and SRT. */
function parseCueBlocks(raw: string): ParsedCue[] {
  const cues: ParsedCue[] = []
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n{2,}/)

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue

    const timingIndex = lines.findIndex((l) => l.includes('-->'))
    if (timingIndex === -1) continue

    const timing = lines[timingIndex]!
    const [rawStart, rawEnd] = timing.split('-->').map((s) => s.trim())
    if (!rawStart || !rawEnd) continue

    const startMs = parseClock(rawStart.split(/\s+/)[0] ?? '')
    // VTT cue settings (align, position) trail the end time; take the first token.
    const endMs = parseClock(rawEnd.split(/\s+/)[0] ?? '')
    if (startMs === null || endMs === null) continue

    const text = lines
      .slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '') // strip VTT inline tags
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue

    cues.push({ startMs, endMs: Math.max(endMs, startMs), text })
  }
  return cues
}

/**
 * Plain text where each line begins with a timestamp. The end of one cue is the
 * start of the next; the final cue gets a nominal duration.
 */
function parseTimestampedText(raw: string): ParsedCue[] {
  const marked: Array<{ startMs: number; text: string }> = []

  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^\s*[[(]?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\])]?\s*[-–—:]?\s*(.*)$/.exec(line)
    if (!m) continue
    const startMs = parseClock(m[1]!)
    const text = (m[2] ?? '').replace(/\s+/g, ' ').trim()
    if (startMs === null || !text) continue
    marked.push({ startMs, text })
  }

  const TAIL_MS = 5_000
  return marked.map((cur, i) => {
    const next = marked[i + 1]
    return {
      startMs: cur.startMs,
      endMs: next ? Math.max(next.startMs, cur.startMs) : cur.startMs + TAIL_MS,
      text: cur.text,
    }
  })
}

export interface ParseOutcome {
  format: TranscriptFormat
  cues: ParsedCue[]
}

/**
 * Parse a pasted transcript. Returns zero cues rather than throwing when nothing
 * is recognisable — the caller reports that as "no transcript", which is a normal
 * outcome and already has a designed screen.
 */
export function parseTranscriptText(raw: string): ParseOutcome {
  if (!raw || !raw.trim()) return { format: 'unknown', cues: [] }

  const format = detectFormat(raw)
  let cues: ParsedCue[]

  switch (format) {
    case 'vtt':
    case 'srt':
      cues = parseCueBlocks(raw)
      break
    case 'timestamped_text':
      cues = parseTimestampedText(raw)
      break
    default:
      cues = []
  }

  // Ordering is not guaranteed by the input; downstream interval logic requires it.
  cues.sort((a, b) => a.startMs - b.startMs)
  return { format, cues }
}
