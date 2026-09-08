import coreWebVitals from 'eslint-config-next/core-web-vitals'

/**
 * Next's recommended rules plus its accessibility set.
 *
 * The a11y rules are the reason a linter is here at all: they catch the class
 * of mistake that is invisible in a screenshot and immediately obvious to
 * anyone using a keyboard or a screen reader.
 *
 * `docs/` is excluded because it is private and not shipped; `src/` and
 * `tests/` are covered by `npm run typecheck` and the suite.
 */
export default [
  { ignores: ['.next/**', 'node_modules/**', 'docs/**', 'tmp/**', 'next-env.d.ts'] },
  ...coreWebVitals,
]
