import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * M3 (Phase 4) — an explicit runner for the `tests/live-dev/` suites.
 *
 * WHY THIS FILE EXISTS. `vitest.config.ts` sets
 * `include: ['tests/unit/**\/*.test.ts']`, so every file under
 * `tests/live-dev/` is DORMANT under `npm test`. That is deliberate — these
 * suites talk to a real database and must never run by accident in CI or on
 * a developer's `npm test` — but it had a real cost, recorded as coverage
 * gap **CG-1** in `II_PC4_POST_CLOSURE_REGRESSION_CONTRACT_2026-09-15.md`:
 *
 *   "vitest.config.ts:5 restricts runs to tests/unit/**; all 9
 *    tests/live-dev/*.test.ts are dormant under `npm test`" — and four PC4
 *    invariants (INV-06 CAS/Folio overlap, INV-10 read-side immutability,
 *    INV-14 cross-user isolation, INV-17 wrong-password atomicity) are
 *    covered ONLY there. "A later phase that runs `npm test` and sees green
 *    has NOT regression-tested those four."
 *
 * Before this file, running them meant hand-assembling a config or a
 * one-off `--dir` invocation, which is exactly the friction that makes a
 * reviewer skip the step. Now it is one documented command:
 *
 *   npx vitest run --config vitest.live-dev.config.ts
 *
 * THIS CONFIG DOES NOT MAKE ANYTHING RUN BY ITSELF. Every suite it can reach
 * carries its own opt-in environment gate (e.g.
 * `AIE_M3_LIVE_DISPATCH_PROOF=1`) and its own hard production guard. Pointing
 * vitest at this config without setting a suite's gate runs zero tests in
 * that suite, by design — two independent locks, not one.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live-dev/**/*.test.ts'],
    // Live-DEV suites create real rows, real storage objects and real auth
    // users against one shared project. Running them in parallel would let
    // two suites interleave their setup and teardown against the same data,
    // so they run one file at a time.
    fileParallelism: false,
    // A real network round trip to a hosted project is slower than an
    // in-process assertion; the unit default would flake on latency alone.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
