import { precisionLabel, precisionOf, type Timing } from '@/domain/timing'

/**
 * How much this timestamp can be trusted, said out loud.
 *
 * The badge exists because precision is a product claim, not a technical
 * detail. A user deciding whether to click a jump link deserves to know
 * whether it will land on the sentence or merely near it, and the only place
 * that can be communicated is next to the number itself.
 */
export function PrecisionBadge({ timing }: { timing: Timing }) {
  const precision = precisionOf(timing)
  const styles = {
    exact: 'border-exact/40 bg-exact-soft text-exact',
    approximate: 'border-approx/40 bg-approx-soft text-approx',
    unlocated: 'border-unlocated/40 bg-unlocated-soft text-unlocated',
  }[precision]

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles}`}
      title={
        precision === 'exact'
          ? 'This timestamp comes from an authoritative source.'
          : precision === 'approximate'
            ? 'Timing is estimated. The jump link lands near this moment, not on it.'
            : 'Timing could not be established, so no jump link is offered.'
      }
    >
      {precisionLabel(timing)}
    </span>
  )
}

const LANE_STYLE: Record<string, string> = {
  VIDEO: 'border-accent/40 bg-accent-soft text-accent',
  VIEWERS: 'border-approx/40 bg-approx-soft text-approx',
  EXTERNAL: 'border-line bg-surface text-muted',
  INFERENCE: 'border-unlocated/40 bg-unlocated-soft text-unlocated',
}

const LANE_TITLE: Record<string, string> = {
  VIDEO: 'Said in the video.',
  VIEWERS: 'Said by viewers in the comments, not by the video.',
  EXTERNAL: 'From a source outside the video.',
  INFERENCE: "VidSense's own reasoning, not something the video says.",
}

/**
 * Which lane a claim belongs to.
 *
 * Kept visually distinct because blending "the video said this" with "a
 * commenter said this" is the failure mode of every AI video summary, and it
 * is a failure the reader cannot detect once it has happened.
 */
export function LaneBadge({ lane }: { lane: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${
        LANE_STYLE[lane] ?? LANE_STYLE.EXTERNAL
      }`}
      title={LANE_TITLE[lane] ?? ''}
    >
      {lane}
    </span>
  )
}
