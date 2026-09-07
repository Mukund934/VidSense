import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // The default suite runs fully offline. Anything needing the emulator lives
    // in vitest.emulator.config.ts, so `npm test` never depends on a service.
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/rules/**', 'tests/emulator/**'],
  },
})
