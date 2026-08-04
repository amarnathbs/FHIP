import { defineConfig } from '@playwright/test';

// Next.js's dev-server process loads .env.local automatically, but the
// Playwright test runner is a separate Node process that does not — any
// spec that talks to Supabase directly (service-role admin grants, etc.)
// needs it loaded explicitly here.
process.loadEnvFile('.env.local');

export default defineConfig({
  testDir: './tests/e2e',
  // Serialized: several specs sign up real Supabase users and persist
  // shared storageState files, which race under full parallelism.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // Next.js dev-mode (Turbopack) can take 15-20s+ to compile+render a
  // data-heavy page like /dashboard on first hit under load — the default
  // 5s expect timeout is tuned for production-speed apps, not dev compiles.
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
  },
});
