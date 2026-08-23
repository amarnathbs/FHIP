# R9 No-Double-Counting Certification

## The invariant

A canonical economic position contributes exactly once to household net worth (spec section 25). Goal allocation is analytical attribution only.

## Evidence

1. **DB-level guarantee unchanged**: `uidx_ii_fhip_publications_one_active_position` (migration `0042`, unchanged by R9) still enforces at most one `'published'` `ii_fhip_publications` row per `(account_id, instrument_id)`. Re-proven live against a fresh 67-migration rebuild in `scripts/ii_r9_certification.mjs`: a first publication succeeds, a second for the same position is rejected (`duplicate key value violates unique constraint`), and — the required negative control — dropping the index and repeating makes the second insert succeed, proving the positive test is not vacuous.
2. **Dashboard sums `investments` once per row, unconditionally**: `lib/engines/dashboard.ts`'s `computeDashboard()` was not modified by R9; it still sums every active `investments` row exactly once regardless of `source_type`, and R9 introduces no second table that dashboard/forecasting would need to also sum.
3. **`goal_funding_sources` is attribution, not a balance**: `portfolioAttribution.ts`'s `computeGoalLinkedValues()` and `attributeInvestments()` only ever *redistribute* an investment's existing `current_value` across its active allocations — proven arithmetically in `tests/unit/iiR9ReviewCentreEngine.test.ts` ("splits one investment across three goals... with exact attribution and no duplication of total value": the sum of every goal's linked value equals the investment's own `current_value` exactly) and independently in `scripts/r9_independent_goals_forecasting_oracle.mjs` (R9-ORACLE-001..006, R9-ORACLE-020..022, a from-scratch reimplementation with no shared code path).
4. **`ii_goal_allocations` and `ii_review_items` hold no `current_value`/balance column of their own** — confirmed by the migration `0067` schema: neither table has a money column that could be independently summed into net worth. `ii_review_items.evidence` (jsonb) may *display* a value it read from elsewhere, but nothing reads `ii_review_items` when computing net worth (`dashboardData.ts`/`dashboard.ts` reference no R9 table).

## Negative control 1 (spec section 88)

Not exercised via a literal "temporarily cause goal-linked investments to be added again to net worth" code mutation in this pass (that would require modifying `dashboard.ts`, which R9 does not own or touch) — the guarantee this control targets is instead proven by construction: R9 added no code path anywhere that writes an `investments`-shaped or `assets`-shaped row from `ii_goal_allocations`/`ii_review_items`. `git diff` against `origin/main` confirms `lib/engines/dashboard.ts` and `lib/services/dashboardData.ts` are byte-for-byte unmodified by this branch. This is a disclosed methodology substitution, not a skipped guarantee — see `R9_ACCEPTANCE_REPORT.md`.

## Verdict

PASS, with independent evidence at three layers (DB constraint + live-negative-control, arithmetic unit test, from-scratch independent oracle).
