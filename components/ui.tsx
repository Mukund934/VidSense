import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'

/**
 * The pieces every screen was rebuilding.
 *
 * Before this file the product had eight buttons, and eight class strings that
 * agreed on the accent colour and on nothing else — different radii, different
 * hover, three spellings of the disabled state and no pressed state anywhere.
 * That is the kind of inconsistency nobody can name while looking at it and
 * everybody feels.
 *
 * No `'use client'` here on purpose: nothing holds state, so these render on the
 * server for a static page and get pulled into the bundle only where a caller
 * is already a client component.
 */

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------- button

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent text-on-accent shadow-raised enabled:hover:bg-accent-hover enabled:hover:shadow-lifted',
  secondary:
    'border border-line bg-surface-raised text-ink enabled:hover:border-line-strong enabled:hover:bg-accent-soft',
  quiet: 'text-muted enabled:hover:bg-accent-soft enabled:hover:text-ink',
  danger: 'bg-approx text-on-accent shadow-raised enabled:hover:brightness-110',
}

const SIZE: Record<Size, string> = {
  sm: 'gap-1.5 rounded-md px-2.5 py-1.5 text-xs',
  md: 'gap-2 rounded-lg px-4 py-2 text-sm',
  lg: 'gap-2 rounded-lg px-5 py-3 text-base',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** Swaps the label for a spinner and blocks the click. Not the same as disabled. */
  loading?: boolean
  /** Shown beside the spinner so the wait says what it is waiting for. */
  loadingLabel?: string
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      // A screen reader should learn the control is busy at the same moment a
      // sighted user sees the spinner, not when the result finally arrives.
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center font-medium',
        'transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--dur-instant)] ease-[var(--ease-out)]',
        // The press. One pixel of travel is enough to feel and too little to
        // notice, which is exactly the point of it.
        'enabled:active:translate-y-px enabled:active:shadow-none',
        'disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner />}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cx('h-3.5 w-3.5 shrink-0 animate-spin', className)}
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.5" />
      <path
        d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

// --------------------------------------------------------------------- notice

type Tone = 'info' | 'warn' | 'good'

const TONE: Record<Tone, string> = {
  info: 'border-line bg-surface-raised',
  warn: 'border-approx/40 bg-approx-soft',
  good: 'border-exact/40 bg-exact-soft',
}

/**
 * Something the product needs to say about its own state.
 *
 * `role="status"` rather than `alert` by default: most of these describe a
 * degraded capability the user can live with, and an assertive announcement
 * interrupts whatever they were reading to say so.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  className,
  assertive = false,
}: {
  tone?: Tone
  title?: string
  children?: ReactNode
  className?: string
  assertive?: boolean
}) {
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      className={cx('vs-enter rounded-lg border px-4 py-3 text-sm', TONE[tone], className)}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cx('leading-relaxed', title && 'mt-1')}>{children}</div>}
    </div>
  )
}

// ----------------------------------------------------------------- skeletons

/**
 * A placeholder shaped like the thing it is standing in for.
 *
 * Text that says "Loading…" tells the reader to wait. A shape tells them what
 * they are waiting for and stops the layout jumping when it arrives.
 */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={cx('vs-skeleton', className)} style={style} />
}

/** Widths taper so the block reads as prose rather than as a bar chart. */
const LINE_WIDTHS = ['100%', '96%', '88%', '92%', '78%']

export function SkeletonLines({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cx('space-y-2', className)}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-3" style={{ width: LINE_WIDTHS[i % LINE_WIDTHS.length] }} />
      ))}
    </div>
  )
}

/** The answer is being written. Read out once, then left alone. */
export function Thinking({ label = 'Reading the transcript' }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 px-2 text-sm text-muted" aria-live="polite">
      <span className="vs-think flex gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {label}
    </p>
  )
}

// ------------------------------------------------------------------ empty state

/** Nothing here yet, said in a way that offers the next move. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="vs-enter rounded-xl border border-line bg-surface-raised px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-sm text-sm text-muted">{children}</div>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}
