import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Security-rules suite. Requires the Firestore emulator — run via `npm run test:rules`,
// which starts one for the duration of the run.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
