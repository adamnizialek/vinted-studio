import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// Tests run in Node with fake-indexeddb polyfilling IndexedDB (see src/test/setup.ts),
// so Dexie-backed code can be exercised headlessly. Pure logic needs no polyfill.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'functions/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
})
