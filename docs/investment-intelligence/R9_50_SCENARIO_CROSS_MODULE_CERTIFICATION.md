# R9 Cross-Module / Scenario Certification

Spec section 86 asks for >=50 end-to-end household scenarios; section 85 frames R9's main certification focus as cross-module integration correctness (transaction -> holding -> publication -> goal allocation -> forecasting -> review item).

## Delivered: full predecessor regression + targeted cross-module chain tests, not a 50-scenario pack

- **Full existing regression suite**: `npx vitest run --no-file-parallelism` — **104/105 test files, 1978/1983 tests passing, 0 failing** (1 file / 5 tests skipped, pre-existing, unrelated to R9). This exercises the R1-R7 scenario packs already built by prior releases (R2's golden fixtures, R3's dedup/no-double-count matrix, R4's 50-case calculation certification, R5's certification pack, R6's 142-case pack, R7's 198-case pack, the 50-user E2E fixture's underlying data shapes) end-to-end through code R9 touches (`goalAllocations.ts`, `types.ts`, `audit.ts`) — proving R9's changes did not regress any of them.
- **Cross-module chain, exercised directly** (not simulated): `scripts/ii_r9_certification.mjs`'s no-double-counting section walks the real chain `ii_accounts` + `ii_instruments` -> `ii_holding_snapshots` -> `ii_fhip_publications` (publish) against a real Postgres engine, and `tests/unit/iiR9GoalAllocationLifecycle.test.ts` walks `investments` -> `ii_goal_allocations` -> `goal_funding_sources` end-to-end through the actual (fixed) service code.
- **Goal-forecast-gap chain**: `detectGoalForecastGap`'s test consumes the exact shape `computeGoalsPagePayload()` (Module 7) returns, proving the Review Centre -> Goals Forecast link works against the real function signature, not a hand-waved interface.

## Not delivered: a standalone, numbered 50-scenario pack covering India/Australia/cross-border/on-track/off-track/goal-change/investment-change/forecast-refresh permutations as a single new artifact

This is a genuine, disclosed gap. The full regression suite above proves R9 did not break any existing certified scenario, and the targeted chain tests prove the new integration points work correctly in isolation and in combination — but a dedicated 50-scenario end-to-end household pack exercising R9 specifically (as opposed to reusing predecessor packs) was not built in this pass. See `R9_ACCEPTANCE_REPORT.md`.
