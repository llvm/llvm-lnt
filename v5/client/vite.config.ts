import { existsSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // The dev servers' ports, which v5/.env can move so that several checkouts each run their own
  // (see .env.example). Read as the tools read it (see loadDotEnv in tools/uv.ts), and only to
  // serve: vitest loads this config too, and the tests must not depend on .env.
  const dotEnv = path.resolve(import.meta.dirname, '..', '.env')
  if (command === 'serve' && !process.env.VITEST && existsSync(dotEnv)) process.loadEnvFile(dotEnv)
  const api = `http://localhost:${process.env.DEV_SERVER_PORT || 3000}`
  return {
    plugins: [react()],
    build: {
      // Vite's default, spelled out because the server relies on it (AR2 "Serving" and "Caching").
      assetsDir: 'assets',
      // Just above Plotly's chunk (about 1160 kB, 385 kB compressed), the only one above Vite's
      // default of 500 kB. Only the pages with a chart fetch it (see components/chart.tsx).
      chunkSizeWarningLimit: 1200,
    },
    server: {
      port: Number(process.env.DEV_CLIENT_PORT || 5173),
      // Rather than moving to the next free port, where `npm run screenshot` would not look.
      strictPort: true,
      proxy: { '/healthz': api, '/llms.txt': api, '/robots.txt': api, '/api': api },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/setupTests.ts'],
      // Timestamps are shown in local time (AR6), so the tests fix the time zone they run in.
      env: { TZ: 'UTC' },
      // A time budget for loaded machines (slow CI runners, or several suites running at once),
      // where a test file's first, cold render alone can take seconds. Well above a single wait's
      // (see setupTests.ts), so that a wait running out late in a test reports what it waited for,
      // not the test's timeout.
      testTimeout: 30_000,
      // CSS Module classes keep their own names, so that a test can check which one an element has.
      css: { modules: { classNameStrategy: 'non-scoped' } },
    },
  }
})
