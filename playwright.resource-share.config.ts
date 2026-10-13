import { defineConfig } from '@playwright/test';

// Standalone config for tests/e2e/resource-share-mobile.spec.ts: PUBLIC pages
// only (no login, no .env.local, no webServer). Start the app yourself, then:
//   RESOURCE_SHARE_BASE_URL=http://localhost:3989 RESOURCE_SHARE_SLUG=<slug> \
//     npx playwright test -c playwright.resource-share.config.ts
// Start the dev server with APP_BASE_URL set to the same origin so the shared
// canonical URL points at the server under test.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /resource-share-mobile\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: 'list',
});
