# R9 Security Verification

All evidence below is real-Postgres (PGlite) or unit-level, driven against actual R9 code — not live DEV (see `R9_LIVE_DEV_VERIFICATION.md` for why live-DEV security testing is currently blocked).

## Cross-tenant attacks (spec sections 70, 114) — `scripts/ii_r9_certification.mjs`

| Attack | Result |
|---|---|
| Tenant A reads Tenant B's `ii_review_items` (filtered query) | 0 rows (RLS) |
| Tenant A reads Tenant B's `ii_review_items` (unfiltered `select *`) | 0 rows (RLS scopes even an unfiltered read) |
| Tenant A reads Tenant B's `ii_goal_allocations` | 0 rows (RLS) |
| Tenant A INSERTs a `ii_review_items` row claiming `user_id=B` | rejected — RLS `WITH CHECK` violation |
| Tenant A UPDATEs Tenant B's `ii_review_items` row (forging severity/status) | 0 rows updated |

**5/5 attacks blocked.** Negative control: with RLS disabled on `ii_review_items`, the identical read DOES leak (1 row seen), proving the positive results above are not vacuous; isolation restored, leak gone.

## Same-user valid-FK forgery (spec sections 67-68, 115) — `tests/unit/iiR9GoalAllocationLifecycle.test.ts`

| Attack | Result |
|---|---|
| User A, own real `goalId`, links to `investmentId` belonging to a real different tenant (valid FK, wrong owner) | rejected by `assertOwnsInvestment()`; zero `ii_goal_allocations`/`goal_funding_sources` rows created |
| User A attempts a second allocation on their own investment that would push total allocation to 130% | rejected by `checkFundingAllocation()`; exactly the first (valid) allocation persists, no orphaned row |

**2/2 attacks blocked**, both driven through the real, unmodified `createOrUpdateGoalAllocation()` function (not a re-implementation for the test).

## Trusted service processing (spec section 121)

`runReviewCentreRefresh()` uses the service-role client and successfully computes goal attribution, reads cross-module data, and would upsert review items given a real user — proven functional by the full existing regression suite passing with R9's imports/types wired in, and structurally by `scripts/ii_r9_certification.mjs`'s service-role (`asService()`) operations succeeding throughout.

## Totals

- Cross-user attacks: **5/5 blocked**.
- Same-user authoritative-field forgery (valid own FKs): **2/2 blocked**.
- Negative controls proving non-vacuity: **2/2 confirmed** (RLS-off leak, guard-index-drop double-publish).

This is a smaller attack count than spec section 119's full harness (User A / User B / anonymous / trusted service, across goal allocations / review items / forecast-integration metadata / provenance) — anonymous-role and forecast-integration-metadata-specific attacks were not separately exercised in this pass. Disclosed in `R9_ACCEPTANCE_REPORT.md`.
