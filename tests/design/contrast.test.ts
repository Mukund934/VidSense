import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The palette, checked against WCAG AA.
 *
 * This exists because the contrast was measured once, in a browser, and found
 * three real failures: the precision badges at 11px sat between 3.8 and 4.5,
 * and — worse — the product's primary call to action was white on a light
 * accent in dark mode at 2.5:1. A measurement taken once is a measurement that
 * rots, and every one of those was introduced by somebody adjusting a colour
 * they had every reason to think was fine.
 *
 * The precision badges are the pair that matters most. The badge *is* the
 * product's claim about how far a timestamp can be trusted, so a reader who
 * cannot make it out is left with a bare number and no idea what it is worth.
 *
 * Parsed from the stylesheet rather than duplicated here, so this cannot pass
 * against a palette the application does not use.
 */

const CSS = readFileSync('app/globals.css', 'utf8')

// --------------------------------------------------------------- colour math

/** oklch(L C H) → linear sRGB, per the Oklab specification. */
function oklchToLinearRgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

/** WCAG relative luminance. Linear sRGB is already what the formula wants. */
function luminance(token: string): number {
  const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(token)
  if (!match) throw new Error(`not an oklch colour: ${token}`)

  const [r, g, b] = oklchToLinearRgb(Number(match[1]), Number(match[2]), Number(match[3]))
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b)
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// ------------------------------------------------------------------- parsing

/**
 * The two palettes, read out of the stylesheet.
 *
 * Light is everything before the dark media query; dark is the overrides inside
 * it, layered on top — which is exactly how the cascade resolves them.
 */
function palettes(): { light: Record<string, string>; dark: Record<string, string> } {
  const darkAt = CSS.indexOf('@media (prefers-color-scheme: dark)')
  expect(darkAt, 'the dark override block').toBeGreaterThan(-1)

  const read = (source: string) => {
    const found: Record<string, string> = {}
    for (const [, name, value] of source.matchAll(/(--color-[\w-]+):\s*(oklch\([^)]*\))/g)) {
      found[name!] = value!
    }
    return found
  }

  const light = read(CSS.slice(0, darkAt))
  return { light, dark: { ...light, ...read(CSS.slice(darkAt)) } }
}

const { light, dark } = palettes()

/**
 * Every foreground that lands on a background the product actually puts it on.
 *
 * `small` is the WCAG 4.5:1 bar. Nothing here is large text: the badges are
 * 11px and the body is 14–15px.
 */
const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ['body text', '--color-ink', '--color-surface'],
  ['body text on a card', '--color-ink', '--color-surface-raised'],
  ['secondary text', '--color-muted', '--color-surface'],
  ['secondary text on a card', '--color-muted', '--color-surface-raised'],
  ['a link', '--color-accent', '--color-surface'],
  ['a link on a card', '--color-accent', '--color-surface-raised'],
  ['a question bubble', '--color-ink', '--color-accent-soft'],
  ['a primary button', '--color-on-accent', '--color-accent'],
  ['a primary button, hovered', '--color-on-accent', '--color-accent-hover'],
  ['a destructive button', '--color-on-accent', '--color-approx'],
  ['the exact badge', '--color-exact', '--color-exact-soft'],
  ['the approximate badge', '--color-approx', '--color-approx-soft'],
  ['the unlocated badge', '--color-unlocated', '--color-unlocated-soft'],
  ['an error message', '--color-approx', '--color-surface'],
  ['a warning panel', '--color-ink', '--color-approx-soft'],
  ['a success panel', '--color-ink', '--color-exact-soft'],
]

const AA_SMALL = 4.5

describe('the colour maths', () => {
  it('agrees with the values everyone knows', () => {
    // Without this the whole file could be measuring nothing and still pass.
    expect(contrast('oklch(1 0 0)', 'oklch(0 0 0)')).toBeCloseTo(21, 0)
    expect(contrast('oklch(1 0 0)', 'oklch(1 0 0)')).toBeCloseTo(1, 2)
  })

  it('reads both palettes out of the stylesheet', () => {
    expect(Object.keys(light).length).toBeGreaterThan(12)
    // If the dark block ever stops overriding, every dark assertion below would
    // silently re-test the light palette and pass.
    expect(dark['--color-surface']).not.toBe(light['--color-surface'])
    expect(dark['--color-on-accent']).not.toBe(light['--color-on-accent'])
  })
})

for (const [scheme, palette] of [
  ['light', light],
  ['dark', dark],
] as const) {
  describe(`${scheme} palette clears WCAG AA`, () => {
    it.each(PAIRS)('%s', (_label, fg, bg) => {
      const a = palette[fg]
      const b = palette[bg]
      expect(a, `${fg} is defined`).toBeTruthy()
      expect(b, `${bg} is defined`).toBeTruthy()
      expect(contrast(a!, b!)).toBeGreaterThanOrEqual(AA_SMALL)
    })
  })
}
