import coreWebVitals from 'eslint-config-next/core-web-vitals'

/**
 * Next's recommended rules plus its accessibility set.
 *
 * The a11y rules are the reason a linter is here at all: they catch the class
 * of mistake that is invisible in a screenshot and immediately obvious to
 * anyone using a keyboard or a screen reader.
 *
 * Everything tracked is linted. `src/`, `scripts/` and `tests/` were left out
 * of the npm script at first on the grounds that the typechecker and the suite
 * already cover them — which is true of types and untrue of everything else a
 * linter finds. They pass clean, so including them costs a second and closes
 * the gap. `docs/` stays out because it is private and not shipped.
 */
export default [
  { ignores: ['.next/**', 'node_modules/**', 'docs/**', 'tmp/**', 'next-env.d.ts'] },
  ...coreWebVitals,
]
