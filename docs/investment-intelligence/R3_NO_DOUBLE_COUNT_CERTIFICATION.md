# R3 — No-Double-Count Certification

Status: FINAL (R3). This document exists specifically to answer the 13 questions spec section 78 requires, plainly and directly, each backed by a real file/function/test — not asserted confidence.

## 1. What is the economic source of truth for a published investment?

The certified `ii_holding_snapshots` row (immutable, one per account/instrument/as-of-date) via the current `ii_portfolio_truth_status` determination for that `(account_id, instrument_id)`. Once published, the **projection** into `investments` is what FHIP's calculation engines read — but the underlying economic fact is always traceable back to the certified snapshot via `ii_fhip_publications.canonical_position_id`.

## 2. How does a canonical position reach FHIP?

`ii_holding_snapshots` → `InvestmentPublicationService.publishPosition()` (`lib/services/investment-intelligence/investmentPublicationService.ts`) → one INSERT or UPDATE on `investments` (WRITE 1) → one INSERT on `ii_fhip_publications` (WRITE 2, pointing `published_row_id` at the investments row). Full trace: `R3_FHIP_CALCULATION_TRACE.md`.

## 3. Which table/value is included in net worth?

`investments.current_value` (in its own `currency_code`), read by `lib/services/dashboardData.ts`'s `loadDashboard()` (`.eq('is_active', true)` filter) and summed by `lib/engines/dashboard.ts`'s `computeDashboard()` into `totalInvestments`, which contributes to `netWorth = totalAssets + totalInvestments + totalRetirement - totalLiabilities`. This is the **only** value ever included — `ii_holding_snapshots.value` and `ii_fhip_publications.published_value` are never independently summed into any net-worth calculation; they exist purely as the source-of-truth and audit record the `investments` row was derived from.

## 4. Which duplicate value is excluded, and how?

When a manual row is confirmed as the same economic investment as a certified position, the manual row's **own prior value** is excluded by being overwritten in place (the row's `current_value` becomes the certified figure; the original manual figure survives only in `pre_publication_manual_snapshot`, which `computeDashboard()` never reads). There is never a second `investments` row for the same position — nothing to "exclude" at read time, because nothing extra was ever written.

## 5. How is manual/imported duplication handled?

Deterministic signal-matching (`detectDuplicateCandidates()` — owner + category + institution, or owner + category + approximate-value when institution is unknown; see `R3_DUPLICATE_RESOLUTION_SPEC.md`) surfaces candidates; a candidate is **never** auto-merged. The user's confirmation ("this is the same investment") drives a convert-in-place UPDATE (section 3 of the duplicate-resolution doc); the user's confirmation ("this is a new investment") drives a plain INSERT with no linkage to any existing row. An unconfirmed request refuses to publish at all (`REQUIRES_REVIEW`/409).

## 6. How is refresh handled?

A new certified snapshot for an already-published position: `refreshPosition()` compares `as_of_date`/certification timestamp via `decideRefreshSupersession()` (never lets an older statement replace a newer active value — `REJECT_OLDER`), updates the **same** `investments.id` row's `current_value` in place, marks the previously-active `ii_fhip_publications` row `superseded`, and inserts a new `ii_fhip_publications` row (new immutable snapshot → new `canonical_position_id`) as the sole active one. `uidx_ii_fhip_publications_one_active_position` makes "two publications active for one position" impossible at the DB level regardless of application-code correctness.

## 7. How is unpublish handled?

`unpublishPosition()` sets the `ii_fhip_publications` row's `status='unpublished'` and either restores the target row to its captured pre-link manual state (linked case) or archives it (`is_active=false`, brand-new case) — in both cases, the row is excluded from `computeDashboard()`'s query before the calculation runs. Canonical II data (`ii_holding_snapshots`, `ii_transactions`, source documents) is never deleted.

## 8. How do Goals avoid duplication?

R3 makes **zero changes** to `ii_goal_allocations`, `goal_funding_sources`, or `goalFundingAllocation.ts` (confirmed: no such files appear in this release's diff). Because linking converts the manual row in place (`investments.id` unchanged), any existing `goal_funding_sources.linked_investment_id` reference continues to point at a valid row with the newly-certified value — Goals sees an updated value on the same funding source, never a second funding source, never additional economic value. `checkFundingAllocation()`'s existing 100%-cap logic is inherited unchanged.

## 9. How does Forecasting avoid duplication?

`investmentCalculator.ts`/`netWorthCalculator.ts` read `investments.current_value`/`annual_contribution`/`master_item_key`/`currency_code` — the exact same table `computeDashboard()` sums. R3 writes into these columns and nowhere else; there is no second, Investment-Intelligence-specific injection point into any forecast calculator (confirmed: zero files under `lib/engines/forecast/` are modified in this release). `annual_contribution` is never inferred from `ii_transactions` SIP history (section 19's critical rule, enforced by `resolveAnnualContribution()` never querying transactions at all) — so a position appearing in Forecasting carries only a user-confirmed forward plan, never a historically-inflated one, and it is read exactly once (via the one `investments` row), never twice.

## 10. How do Reports avoid duplication?

`lib/engines/reportSections.ts`/`reportSectionsPremium.ts` are unmodified in this release and consume `computeDashboard()`'s output (or the same `investments` table) exactly as Dashboard does — see question 3. Because there is only ever one active `investments` row per economic position, Reports cannot double-count what Dashboard doesn't.

## 11. What is the cross-border currency mechanism?

`investments.currency_code` is written **unconverted** from the certified snapshot's own currency; `computeDashboard()`'s existing `reportingValue()`/`convertToReportingCurrency()` (`lib/engines/fx.ts`) converts to the household's reporting currency at read/aggregation time only, in memory, never persisted back over the source figure. Full detail: `R3_CROSS_BORDER_PUBLISHING.md`.

## 12. Which DB/service constraints prevent duplication?

- `uidx_ii_fhip_publications_one_active_position` — partial unique index on `ii_fhip_publications(account_id, instrument_id) where status='published'` (migration `0042`). The primary, DB-enforced guarantee.
- `unique(canonical_position_id)` on `ii_fhip_publications` (migration `0034`, unchanged) — prevents two publications for the literal same snapshot.
- `uidx_investments_user_master_manual` — partial unique index preventing duplicate MANUAL rows per category (migration `0042`, the relaxed/corrected form of the original constraint — see `R3_ARCHITECTURE_EXCEPTION.md`).
- Idempotency-key pre-check in `publishPosition()` — application-level defense-in-depth in front of the DB constraint.
- Convert-in-place linking (never a second INSERT for a confirmed duplicate).
- `is_active=false` archive-before-read semantics (unchanged from pre-R3 `registry.ts`).

## 13. What tests prove it?

- `tests/unit/iiR3PublicationLogic.test.ts` (59 tests) — every decision function in isolation, including the DD-005/DD-032 distinguishing duplicate-detection rule and the exact financial-impact arithmetic (`+20,000`, never `+520,000`).
- `tests/unit/iiR3NetWorthCertification.test.ts` (19 tests) — NW-001 through NW-008 and FIN-001/002/003/004/010 run through the REAL, unmodified `computeDashboard()`, including a mutation test that reproduces the exact FAIL condition the spec names (`1,020,000`) and confirms it differs from the correct result (`520,000`).
- `tests/unit/iiR3DedupScenarioMatrix.test.ts` (17 tests) — all 12 R0 scenarios.
- `tests/unit/iiR3ManualReconciliation.test.ts` (11 tests) — 10+ hand-worked before/after cases against the real engine.
- All 470 tests (364 pre-existing + 106 new) pass.
- **LIVE-DEV proof (2026-08-20, after migration `0042` was applied to DEV — see `R3_ACCEPTANCE_REPORT.md` section 0 and `scripts/r3_closure_live_tests.mjs`)**: the exact spec-section-31 critical duplicate scenario was reproduced against the real database — a real manual `investments` row (500,000, ABC Mutual Fund) plus a real certified Investment Intelligence position (520,000, same fund) for the same real household, run through the actual `preview` → `publish` (confirm-link) API. A direct service-role query of `investments` and `ii_fhip_publications` afterward confirmed **exactly one active row at exactly 520,000** — not 1,020,000, not two rows. Idempotent retry (same request twice) and genuine concurrency (`Promise.all`, two simultaneous requests) both independently confirmed via direct DB query to still result in exactly one active row and one `published` publication. Refresh, unpublish, and republish were also each live-verified end to end, closing the DB-level-constraint-enforcement gap this document previously disclosed as unverifiable — two real defects (a refresh-ordering bug that violated the one-active-publication constraint, and a silent-update-failure bug in the unpublish-restore path) were found and fixed specifically because this pass insisted on genuine live execution.
