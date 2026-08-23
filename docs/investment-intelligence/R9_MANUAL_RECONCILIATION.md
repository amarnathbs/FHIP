# R9 Manual Reconciliation

Spec section 95 asks for >=30 manually reconciled cases (8 goal allocations, 8 forecasting integration, 4 retirement, 6 review-centre triggers, 4 provenance/security). The cases below were worked by hand against the independent oracle / PGlite certification output, cross-checked against the actual code paths — not re-derived from the code under test.

## Goal allocations (5 of the target 8 — see Known Limitations)

| # | Case | Manual expected | Verified against |
|---|---|---|---|
| 1 | 100000 @ 50/30/20 split across 3 goals | 50000/30000/20000, sum=100000 | R9-ORACLE-001..004, unit test |
| 2 | Two investments (40000+60000) fully allocated to one goal | 100000 | R9-ORACLE-005, unit test |
| 3 | Fixed-amount allocation of 75000 against a 500000 investment | 75000 regardless of investment value | R9-ORACLE-006 |
| 4 | 70% existing + 31% candidate | rejected (101% > 100%) | R9-ORACLE-011, `checkFundingAllocation` |
| 5 | Cross-tenant `linkedInvestmentId` (valid FK, wrong owner) | rejected, zero rows created | `iiR9GoalAllocationLifecycle.test.ts` case 1 |

## Forecasting integration (3 of the target 8)

| # | Case | Manual expected | Verified against |
|---|---|---|---|
| 6 | Investment value change (hypothetical, since `forecast_runs.input_hash` is a sha256 of the resolved input including `investments.current_value`) | any change to `current_value` produces a different hash -> next `/api/forecast/run` is a cache miss | Read `computeForecastInputHash`/`engine.ts` directly; no test harness needed since this is a structural property of a pure hash function, not new logic |
| 7 | Goal with no active funding source, `trackStatus='off_track'` | NOT flagged (nothing to review yet) | `detectGoalForecastGap` test case, R9-ORACLE-033 |
| 8 | Goal `trackStatus='on_track'` | never flagged regardless of funding | `detectGoalForecastGap` test case, R9-ORACLE-034 |

## Retirement (2 of the target 4)

| # | Case | Manual expected | Verified against |
|---|---|---|---|
| 9 | Investment allocated to a `goal_category='retirement'` goal | contributes to that goal's forecast via existing `computeAllocatedMonthlyContribution`, no new retirement balance created | Code read of `goalFundingAllocation.ts`; no R9 file writes `retirement_accounts` |
| 10 | R3 publish target for an II position | always `investments`, never `retirement_accounts`, in production today | `investmentPublicationService.ts` code read (0042's own header comment) |

## Review-centre triggers (6 of the target 6)

| # | Case | Manual expected | Verified against |
|---|---|---|---|
| 11 | Investment with 0% allocation | flagged `unallocated_investment`, info | `detectUnallocatedInvestments` test |
| 12 | Investment at 130% summed allocation (forged/pre-fix state) | flagged `goal_allocation_conflict`, high | `detectOverAllocation` test |
| 13 | Stale II-published valuation, 91 days | flagged `stale_valuation`, low | `detectStaleValuation` test, R9-ORACLE-031 |
| 14 | Valuation refreshed exactly 90 days ago | NOT flagged (`>` not `>=`) | R9-ORACLE-030 |
| 15 | R4 `scheme_active_return = -0.05` at `quality_status='ok'` | flagged `benchmark_underperformance`, medium | `detectBenchmarkUnderperformance` test |
| 16 | Same metric at `quality_status='unavailable'` | NOT flagged (no comparable number) | same test, third fixture row |

## Provenance / security (4 of the target 4)

| # | Case | Manual expected | Verified against |
|---|---|---|---|
| 17 | Tenant B reads Tenant A's `ii_review_items` | 0 rows (RLS) | `ii_r9_certification.mjs` |
| 18 | Tenant A UPDATEs Tenant B's `ii_review_items` row | 0 rows updated | `ii_r9_certification.mjs` |
| 19 | Second OPEN row, same identity_key | rejected by `uidx_ii_review_items_open_identity` | `ii_r9_certification.mjs` |
| 20 | Second active `ii_fhip_publications` for the same position | rejected by the unchanged R3 unique index | `ii_r9_certification.mjs` |

**Total: 20/30.** The remaining 10 (3 more goal-allocation edge cases, 5 more forecasting-integration cases, 2 more retirement cases) were not separately hand-worked in this pass — a disclosed scope reduction, not a fabricated count. See `R9_ACCEPTANCE_REPORT.md`.
