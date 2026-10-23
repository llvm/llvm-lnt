import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  globalSetup: './global-setup.ts',
  forbidOnly: !!process.env.CI,
  // A flaky test is a bug to fix, not to retry until it passes.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    // The Nginx of the stack `npm run test:e2e` runs the tests against (see global-setup.ts),
    // whose certificate is a throwaway one.
    baseURL: process.env.PROXY_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
