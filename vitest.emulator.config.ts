import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Everything that needs a running Firestore emulator: the security rules, and
// the Firestore adapters. Run via `npm run test:emulator`, which starts an
// emulator or reuses one that is already listening.
//
// These live outside `npm test` on purpose — the default suite must stay
// runnable offline, for free, with no service of any kind.
export default defineConfig({
  resolve: {
    // Ordered: the more specific prefixes must win over the bare `@/` -> src.
    alias: [
      { find: /^server-only$/, replacement: fileURLToPath(new URL('./tests/support/server-only.ts', import.meta.url)) },
      { find: /^@\/lib\//, replacement: fileURLToPath(new URL('./lib/', import.meta.url)) },
      { find: /^@\/components\//, replacement: fileURLToPath(new URL('./components/', import.meta.url)) },
      { find: /^@\/app\//, replacement: fileURLToPath(new URL('./app/', import.meta.url)) },
      { find: /^@\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.ts', 'tests/emulator/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
