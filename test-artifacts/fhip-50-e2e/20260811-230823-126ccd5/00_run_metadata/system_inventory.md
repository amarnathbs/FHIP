# FHIP 50-User E2E Harness — System Inventory

RUN_ID: `20260811-230823-126ccd5`
Generated: 2026-08-11 23:08 (local)

## Repository state

- Git branch: `test/fhip-50-user-e2e-harness` (created from `main`)
- Git commit at branch point: `126ccd5` — "Add temporary admin env-check diagnostic route"
- Node: v24.18.0
- npm: 11.16.0
- Next.js: 16.2.12
- React: 18.3.1
- @supabase/supabase-js: 2.112.0, @supabase/ssr: 0.12.4
- Playwright: 1.62.0
- Vitest: 4.1.10
- Package name/version: fhip@0.1.0

## Environment identity (safety gate — master prompt §1)

- **Local dev `.env.local` Supabase project**: `vqycarelcoijzwlpkpcz.supabase.co`
- **Live production project** (confirmed via AWS Amplify env vars and app.financialhealthplatform.com's session cookies this session): `twwpnltizhtjxhamyoxt.supabase.co`
- These are two **distinct** Supabase projects. The dev project is positively confirmed non-production.
- **Decision**: all fixture writes for this harness target the dev project (`vqycarelcoijzwlpkpcz`) only, via `.env.local`'s `SUPABASE_SERVICE_ROLE_KEY`. Production is never touched by this harness.
- Open item to verify in Phase 1/2: confirm the dev project's schema is current (all 28 migrations applied) before writing fixtures.

## Schema

- Migrations directory: `supabase/migrations/`, 28 files, latest `0028_retirement_timing_hierarchy.sql`.

## Versioned engine/calculation identifiers found in code

- `FORECAST_ENGINE_VERSION = 'forecast-1.6.0'` (`lib/engines/forecast/engine.ts:29`)
- (Score/DNA/Resilience/report-template versions to be captured during Phase 4/5/6 as each module is exercised — not all expose an explicit version constant the way the forecast engine does; this will be documented as a gap if so.)

## Existing test suite baseline (pre-fixture-work)

- `npx vitest run`: **12 test files, 110 tests, all passed**, 6.65s. Saved verbatim: `00_run_metadata/pre_existing_test_results.txt`.
- `tests/e2e/forecasting-engine.e2e.spec.ts` exists (Playwright) — not run in this pass (requires a live dev server + seeded data; will be exercised as part of this harness's own execution, not as a separate pre-flight step).

## Existing reusable test-harness infrastructure (do not rebuild from scratch)

Two prior 50-scenario cycles already built substantial, working harness code — this new effort should extend/generalize these rather than duplicate them, per master-prompt §26.3-4 ("reuse canonical services", "avoid one-off hardcoded logic"):

### `User tests/FHIP_50_Scenario_Test_Package/harness/` (AU-majority cycle, TC001-TC050 in that cycle's own numbering)
- `mappings.mjs` (185 lines) — category/frequency/country/owner enum mapping table
- `rowBuilders.mjs` (182 lines) — converts workbook rows into grid-entry payloads
- `runSuite.mjs` (260 lines) — orchestrates the UI-driven data entry per test case
- `reconcile.mjs` (255 lines) — expected-vs-actual reconciliation
- `report.mjs` (104 lines), `generateUserReportPdfs.mjs` (98 lines), `mdToPdf.mjs` (137 lines) — report generation/export

### `User tests/FHIP_India_Majority_50_Scenario_Test_Package/harness/` (India-majority cycle, TC051-TC100 in that cycle's numbering)
- Same shape as above plus: `gridConfigs.mjs`, `rowValues.mjs`, `runSuiteUI.mjs` (333 lines, real front-end UI-driven entry — the most current pattern), `refreshReconciliation.mjs` / `refreshReconciliationFast.mjs`, `removeRollupDuplicates.mjs`, `scanDuplicates.mjs`, `fillGaps.mjs`, `fixExpectedResultsOracle.mjs`, `patchRecordStatuses.mjs`

### Forecasting-specific
- `scripts/seedForecastingTestData.ts` (839 lines) — direct-to-DB seed script (not UI-driven), real-schema, already used for a 50-case forecasting E2E cycle
- `User tests/forecasting test/seed_forecasting_test_data.ts` (364 lines) — earlier/alternate version

**Total existing harness code found: ~4,150 lines** across these files. ~4,150 lines is the starting point, not the target — this new master prompt's scope (3 report types × 50, 1,500 historical snapshots, 25 back-tests, formal defect/reconciliation packaging) is materially larger than any single prior cycle.

## Key architectural facts carried forward from this session (already known, not re-derived)

- Canonical aggregation: `lib/services/dashboardData.ts` / `dashboard.ts`
- Score engine: `lib/engines/healthScore.ts` (absorbed resilience in Module 6)
- DNA engine: Module 5 classification engine
- Resilience: `lib/engines/resilience.ts` + `resilienceStress.ts`
- Goals: `lib/engines/goalMath.ts` + category calculators + `GoalFundingAllocationService`
- Forecasting: `lib/engines/forecast/engine.ts` (`forecast-1.6.0`) + per-category calculators (investment/debt/retirement/resilience/scenario-diff)
- Reports: `components/reports/ReportPreview.tsx` (Free + Full/Premium, shared print route), `components/forecast/ForecastReportContent.tsx` (Consolidated Forecasting Report), both rendered to PDF via `lib/services/reportPdfRenderer.ts` (Playwright headless Chromium against the app's own print routes)
- Admin/service-role client: `lib/supabase/admin.ts` `createAdminClient()` (just hardened this session to fail loudly instead of crashing silently)
- No formal "immutable historical snapshot addressable by arbitrary as-of-date" capability confirmed yet — `financial_snapshots` table exists (Module 3) but whether it supports the full 60-month/1,500-row historical reconciliation this master prompt requires needs verification in Phase 1/8. Flagged as an open architecture question, not assumed either way.

## Immediate next step (Phase 1)

Read `README`, `Test_Cases`, `Source_Field_Map`, and `Field_Coverage` sheets from the workbook in full; build/extend the workbook parser; produce `01_import/workbook_validation.xlsx` and `01_import/field_mapping.xlsx`.
