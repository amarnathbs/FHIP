import { defineConfig } from '@playwright/test';

// Canonical-cert FINAL pass: run fdh14-ui-accessibility-smoke.spec.ts against the harness's own
// DEV-only dev server (scripts/canonical_cert/dev_server.mjs --range C, port 3973), which already
// strips PRODUCTION_* keys. No webServer here -- we do not want Playwright starting a second,
// unscoped `npm run dev` on :3000.
process.loadEnvFile('.env.local');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /fdh14-ui-accessibility-smoke\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    baseURL: process.env.FDH14_BASE_URL || 'http://127.0.0.1:3973',
    trace: 'on-first-retry',
  },
});
