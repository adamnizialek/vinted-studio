/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// PWA jest realizowane recznie (public/manifest.webmanifest + public/sw.js),
// bez dodatkowych wtyczek — mniej zaleznosci, mniej niespodzianek przy buildzie.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Wzgledna sciezka bazowa => aplikacja dziala tez gdy jest serwowana z podkatalogu
  // (np. GitHub Pages / dowolny hosting statyczny).
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
