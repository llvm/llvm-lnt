import { defineConfig, devices } from '@playwright/test'
import { BASE_URL } from './global-setup.ts'

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
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
