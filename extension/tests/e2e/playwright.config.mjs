import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  testDir:fileURLToPath(new URL('.', import.meta.url)),
  testMatch:'*.spec.mjs',
  fullyParallel:false,
  workers:1,
  retries:0,
  timeout:120_000,
  expect:{timeout:15_000},
  forbidOnly:Boolean(process.env.CI),
  outputDir:fileURLToPath(new URL('../../../test-results/extension', import.meta.url)),
  reporter:[['list'], ['junit', {
    outputFile:fileURLToPath(new URL('../../../test-results/extension-results.xml', import.meta.url)),
  }]],
  // Credentials are generated for each disposable run. Do not retain browser
  // profiles, authentication state, request traces, or videos in CI artifacts.
  use:{trace:'off', video:'off', screenshot:'off'},
});
