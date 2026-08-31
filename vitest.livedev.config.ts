// Separate vitest project for LIVE hosted-DEV certification suites.
//
// Deliberately NOT part of `vitest.config.ts`'s `tests/unit/**` include: these
// suites require real network access and real DEV Supabase credentials
// (`.env.local`), so they must never join the offline unit-test baseline.
// Run explicitly:  npx vitest run --config vitest.livedev.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live-dev/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
