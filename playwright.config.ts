import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never' }]],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3000',
        headless: true,
        ignoreHTTPSErrors: true,
      },
    },
  ],
  use: {
    actionTimeout: 0,
    trace: 'retain-on-failure',
  },
});