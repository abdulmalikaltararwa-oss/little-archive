import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// A small smoke suite for the React interface. It runs the production build's demo page, so it needs no
// server and no account, and it refuses any request that leaves the page's own origin. The full browser
// suite against a real server is tests/e2e in the repository root; porting it to this interface is listed
// in ui/README.md.
const PORT = Number(process.env.LA_UI_SMOKE_PORT) || 5184;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  outputDir: '../test-results/smoke',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: `http://127.0.0.1:${PORT}/demo.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { LA_UI_PORT: String(PORT) },
  },
});
