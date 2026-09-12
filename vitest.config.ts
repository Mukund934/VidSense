import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

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
    // jsdom leaves a handful of DOM methods unimplemented. Shimmed here so a
    // component never has to carry a guard that exists only for the tests.
    setupFiles: ['./tests/support/dom-shims.ts'],
    // The default suite runs fully offline. Anything needing the emulator lives
    // in vitest.emulator.config.ts, so `npm test` never depends on a service.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/rules/**', 'tests/emulator/**'],
  },
})
