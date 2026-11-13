import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../../../playwright.config.mjs';

if (!process.env.LA_E2E_OLLAMA_URL || !process.env.LA_E2E_OLLAMA_MODEL) {
  throw new Error('The separate AI browser gate requires an explicitly configured loopback model.');
}

export default defineConfig({
  ...base,
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: '*.spec.mjs',
  testIgnore: [],
  timeout: 5 * 60_000,
  globalTimeout: 7 * 60_000,
  outputDir: fileURLToPath(new URL('../../../test-results/ai', import.meta.url)),
  reporter: [
    ['list'],
    ['junit', { outputFile: fileURLToPath(new URL('../../../test-results/ai-results.xml', import.meta.url)) }],
  ],
  projects: base.projects.filter(project => project.name === 'chromium'),
});
