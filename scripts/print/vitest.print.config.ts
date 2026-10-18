import { defineConfig } from 'vitest/config';
import path from 'path';

// Runs only the print-fixture generators (not part of the normal unit suite).
export default defineConfig({
  test: { environment: 'node', include: ['scripts/print/**/*.vitest.ts'], testTimeout: 120000 },
  resolve: { alias: { '@': path.resolve(__dirname, '..', '..') } },
});
