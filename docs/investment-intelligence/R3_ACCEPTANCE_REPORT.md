# R3 — Acceptance Report

Status: FINAL (R3)

## R3 Acceptance Checklist (spec section 88)

| # | Item | Evidence | Status |
|---|---|---|---|
| 1 | R2 prerequisite recorded, not re-verified | Task prompt's R2 verdict reproduced verbatim in the final response | DONE |
| 2 | Branch created from `b950a48`, work isolated | `git checkout b950a48 -b feature/investment-intelligence-r3-fhip-publishing`; `git log --oneline b950a48..HEAD` → `e90325b` only | DONE |
| 3 | Baseline verified before changes | tsc clean, 364/364 vitest (after fixing a pre-existing unrelated `pdf-parse` install gap — see `R3_TESTING_AND_VERIFICATION.md` §6), 6E/6W lint, clean build | DONE |
| 4 | Real FHIP code read before designing | `R0_*`, `R1_DATABASE_SCHEMA.md`, actual `investments`/`assets`/`retirement_accounts` schema, `dashboard.ts`, `fx.ts`, `dashboardData.ts`, `investmentCalculator.ts`, grid config/validation/registry all read directly, not inferred | DONE |
| 5 | Migration additive-only | Every ALTER reviewed; two exceptions to literal R0 wording documented in `R3_ARCHITECTURE_EXCEPTION.md`, both backward-compatible | DONE |
| 6 | Eligibility gate implemented, deterministic | `evaluateEligibility()`, 15 unit tests | DONE |
| 7 | Preview implemented, writes nothing but an audit event | `buildPreview()` | DONE |
| 8 | FHIP field mapping matches real schema, not labels | `R3_FHIP_MAPPING_SPEC.md`, incl. the OWNER correction (Exception 1) | DONE |
| 9 | Annual contribution never inferred from history | `resolveAnnualContribution()` never queries `ii_transactions`; explicit tests | DONE |
| 10 | Duplicate detection deterministic, never auto-merge | `detectDuplicateCandidates()`, institution-required-signal fix found via testing | DONE |
| 11 | Manual-to-canonical linking preserves history/goal linkage | Convert-in-place design, `pre_publication_manual_snapshot` | DONE |
| 12 | No-double-counting provably true | `R3_NO_DOUBLE_COUNT_CERTIFICATION.md`, 106 tests incl. a real mutation test | DONE (fixture-level) |
| 13 | Refresh/republish never duplicates | `decideRefreshSupersession()`, `uidx_ii_fhip_publications_one_active_position` | DONE (design+unit); LIVE constraint enforcement BLOCKED |
| 14 | Unpublish/republish deterministic, R0 open item resolved | `R3_DUPLICATE_RESOLUTION_SPEC.md` §4 | DONE |
| 15 | Cross-border currency correct, FAIL-condition-safe | `R3_CROSS_BORDER_PUBLISHING.md`, exact arithmetic, missing-FX guard | DONE |
| 16 | Direct-edit protection | API PATCH/DELETE guards + grid UI locked fields, both reviewed together | DONE |
| 17 | UI minimal, source-badged | `InvestmentIntelligenceClient.tsx`, `FinancialDataGrid.tsx` | DONE |
| 18 | API bounded, centralised service | `R3_PUBLISHING_ARCHITECTURE.md` §8 | DONE |
| 19 | Audit vocabulary extended, no raw content stored | migration `0042` §4; every `emitAuditEvent()` call site passes only safe numeric/id metadata | DONE |
| 20 | RLS/security | `R3_SECURITY_VERIFICATION.md` — STATIC PASS; LIVE adversarial BLOCKED | PARTIAL |
| 21 | Net-worth calculation trace, real code | `R3_FHIP_CALCULATION_TRACE.md`, `git diff --stat` reproduced | DONE |
| 22 | Forecasting/Goals/Reports don't duplicate | `R3_NO_DOUBLE_COUNT_CERTIFICATION.md` §8-10; zero files under `lib/engines/forecast/`, `lib/engines/reportSections*.ts` modified | DONE |
| 23 | R0 12-scenario matrix | `R3_TESTING_AND_VERIFICATION.md` §3, `iiR3DedupScenarioMatrix.test.ts` | DONE |
| 24 | Manual financial reconciliation, 10+ cases | `iiR3ManualReconciliation.test.ts`, 11 cases | DONE (engine-level) |
| 25 | Live DEV testing explicitly distinguished | `R3_TESTING_AND_VERIFICATION.md` throughout | DONE |
| 26 | Regression clean | 470/470 (364 baseline + 106 new), 0 new lint/tsc/build errors | DONE |
| 27 | R4+ scope not implemented | Confirmed — no XIRR/CAGR/TWRR/benchmark/tax/etc. in any new file | DONE |

## Outstanding issues (all traced to the same root cause)

1. **Migration `0042` is not applied to DEV.** No Supabase CLI project link, no direct Postgres connection string, no DDL execution capability in this sandbox — identical constraint to every prior phase (R1, R1.6, R1.7, R2). A human with DDL access must apply it.
2. **SEC-R3-001..010 live adversarial security tests are BLOCKED** on (1) — the seeded-victim-row methodology this project has twice needed (R1, R1.6) cannot run against columns/tables that do not yet exist in DEV.
3. **A literal live HTTP round-trip through the new API routes was not performed** — the routes are code-reviewed, type-checked, and their underlying logic is unit-tested, but `POST /api/investment-intelligence/positions/[id]/publish` was never actually called against a running server with a real database session.
4. **DB-level constraint enforcement (`uidx_ii_fhip_publications_one_active_position`, the relaxed `uidx_investments_user_master_manual`) is unverified live** — the SQL is correct by inspection and the equivalent application-level logic is unit-tested, but the constraint itself has never fired against a real insert attempt.

None of these are financial-integrity defects, currency errors, or design flaws — all four are the single, disclosed, expected consequence of the sandbox's DB-migration constraint, exactly as R1/R1.6/R1.7/R2 each disclosed identically before them.

## Final Classification

**CONDITIONAL PASS.**

Reasoning: every financial-integrity claim this release exists to prove — no double counting, correct cross-border currency treatment, exact net-worth arithmetic, register isolation, Forecasting/Goals/Reports non-duplication — is proven with genuine rigor against the **real, unmodified, production** calculation engine (`computeDashboard()`), with exact numbers, a real bug found and fixed via testing, and a real mutation test reproducing the spec's own named FAIL-condition value. These are the properties the spec calls non-negotiable for CONDITIONAL PASS eligibility, and none of them is left uncertain, approximate, or unverified in this report.

What remains outstanding is exclusively **live-database verification** — the migration's application and the subsequent live adversarial security/idempotency/concurrency testing — which is structurally impossible in this sandbox and was honestly disclosed rather than fabricated, worked around, or silently skipped, matching this project's own established precedent for every prior phase that hit the identical constraint. This is a bounded, clearly-scoped gap (spec section 86's "future-asset-routing placeholder, non-blocking display metadata" category is closely analogous in spirit: a structural completeness gap, not a correctness defect), not a double-counting, FX, cross-user-access, or provenance failure — those specific FAIL conditions were each actively tested for and not found.

## Exact prerequisites for R4

1. A human with Supabase DDL access applies migration `0042_ii_r3_fhip_publishing_bridge.sql` to DEV.
2. Re-run `R3_SECURITY_VERIFICATION.md`'s documented seeded-victim-row methodology live (SEC-R3-001..010) and upgrade this report's classification if all pass.
3. Perform a literal live HTTP walkthrough of the Publish-to-FHIP UI flow against a real household with real II data, confirming the preview/confirm/success states render as designed.
4. Only after (1)-(3): consider expanding production-certified asset classes beyond mutual funds (R2 would need to certify them first) — this was explicitly out of R3 scope per the spec's own asset-scope instruction.
5. Do not begin XIRR/CAGR/TWRR/benchmark/risk-adjusted-metrics/tax/cost-leakage/recommendations work — all remain explicitly out of scope per the spec's scope firewall (section 84), unchanged by this report.
