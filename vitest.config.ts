import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // The default suite runs fully offline. Rules tests need the emulator and
    // live in their own config so `npm test` never depends on a running service.
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/rules/**'],
  },
})
