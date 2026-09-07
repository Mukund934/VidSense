/**
 * Stand-in for the `server-only` package.
 *
 * That package exists to fail the build if server code is pulled into a client
 * bundle. Under Vitest we *are* the server, and its client-condition export
 * throws on import, so the guard has to be replaced rather than satisfied.
 *
 * Aliased in vitest.config.ts. Nothing else should import this.
 */
export {}
