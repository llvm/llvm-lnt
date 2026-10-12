import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Just above Plotly's chunk (about 1160 kB, 385 kB compressed), the only one above Vite's
    // default of 500 kB. Only the pages with a chart fetch it (see components/chart.tsx).
    chunkSizeWarningLimit: 1200,
  },
  server: {
    proxy: {
      '/healthz': 'http://localhost:3000',
      '/llms.txt': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    // Timestamps are shown in local time (AR6), so the tests fix the time zone they run in.
    env: { TZ: 'UTC' },
    // CSS Module classes keep their own names, so that a test can check which one an element has.
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
})
