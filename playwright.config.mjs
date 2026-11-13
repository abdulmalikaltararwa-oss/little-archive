import { defineConfig, devices } from '@playwright/test';

// run.mjs supplies a fresh, real server. Refuse to use an existing personal instance.
if (!process.env.LA_E2E_BASE_URL || !process.env.LA_E2E_OWNER_PASSWORD || !process.env.LA_E2E_DATA_DIR) {
  throw new Error('Run browser tests with npm run test:e2e so an isolated library is created.');
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  testIgnore: '**/ai/**',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  globalTimeout: 8 * 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['junit', { outputFile: 'test-results/browser-results.xml' }],
  ],
  outputDir: 'test-results/browser',
  use: {
    baseURL: process.env.LA_E2E_BASE_URL,
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    // Authentication values must never enter uploaded traces or screenshots.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 1000 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } } },
  ],
});
