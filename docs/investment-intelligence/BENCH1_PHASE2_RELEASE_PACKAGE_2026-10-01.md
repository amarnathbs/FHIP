# BENCH-1 Phase 2 - Release package and remaining external dependencies

Status: **prepared, not requested.** Nothing here authorises production data publication or scheduled ingestion; those need the external dependencies in section 4 and the PO's explicit approval. Branch `feat/bench1-phase2-benchmark-upload-ingestion-20261001` (not pushed, not merged).

## 1. Exact changes

| Area | Files |
|---|---|
| Migration | `supabase/migrations/0239_bench1_phase2_benchmark_data_governance.sql` (additive; no shared CHECK dropped/recreated; revokes the 0232 single-step upload RPC from `authenticated`; tightens the 0232 feed RPC with the entitlement gate; replaces the series read policy with the entitlement gate) |
| Apply/verify/rollback | `scripts/bench1_phase2_po_apply_0239.sql`; PGlite proof `scripts/bench1_phase2_0239_pglite_verification.mjs` (results `scripts/bench1-phase2-0239-pglite-results.json`) |
| Services | `lib/services/investment-intelligence/benchmarkData/**` (guards, entitlements, uploadService, publishService, demand, routeSupport, apiTypes, `fileIngest/**`, `ingestion/**`), `benchmarkAccess.ts` |
| Consumers (gate only; certified R4/R5 arithmetic untouched) | `analyticsRepository.ts`, `r5Repository.ts`, `benchmarkCoverage.ts`, `holdingsRepository.ts`, `overviewSummary.ts`, `investmentIntelligenceReportData.ts` |
| API | `app/api/admin/investment-intelligence/benchmark-data/**` (19 handlers), the superseded POST of `.../market-index-data/route.ts` (410), `app/api/investment-intelligence/cron/benchmark-ingestion/route.ts` (OFF) |
| Admin UI/nav | `components/admin/BenchmarkDataClient.tsx` + `components/admin/benchmarkData/**`, pages `.../market-index-data` and `.../benchmark-data`, `lib/admin/adminNav.ts`, `app/api/admin/me/route.ts` |
| Docs | this folder; `docs/admin/BENCHMARK_DATA_ADMIN_CAPABILITIES.md`; root `SOURCE_DECISION.md` |
| Removed | the unconnected `pc6/csvBenchmarkImporter.ts` and its test (its `public_open`-only gate wrongly excluded legitimate entitlements and trusted a label; superseded by the one pipeline) |

## 2. Configuration (all default OFF / unset)

| Setting | Where | Default | Purpose |
|---|---|---|---|
| `ii_reference_job_control.benchmark_ingestion_global` | DB | enabled = false | master kill switch |
| `ii_reference_job_control.benchmark_ingestion_write` | DB | enabled = false | write kill switch (off = dry run) |
| `BENCHMARK_INGESTION_ENABLED` | env | unset | third switch, enforced by the cron route |
| `BENCHMARK_INGESTION_PROJECT_REF` | env | unset | the only Supabase project ref this runtime may ingest into |
| `CRON_SECRET` | env | existing | job authentication (already used by the other cron routes) |
| Capability columns (4 new) | `admin_users` | false for everyone | granted one admin at a time |

No `pg_cron` schedule, Vault secret or Amplify variable is created by this change. Do not reuse a production origin for a DEV job: the project-ref guard refuses.

## 3. Verification checklist for the first real DEV rollout (PO present)

1. Apply 0239 to DEV with the apply script; run its verify block (expected values are in the comments).
2. Grant yourself catalogue + approver capabilities; seed the draft catalogue (optional); verify one entry against the owner's page.
3. Obtain a **permitted real file** for one benchmark that a held scheme declares (e.g. NIFTY 100 TRI) - only after rights are in writing; create and approve the entitlement (ingest, storage, calculation, display; export only if granted).
4. Stage, review the preview, publish with a second administrator; confirm the ledger row (`ii_reference_import_batches`, `benchmark_level`) and the job record.
5. Propose, approve the mapping for a held scheme; open **Performance, SIP Intelligence, Overview, X-Ray and Holdings** as the owning user: each must show the benchmark with its TRI label, the as-of date and a real comparison (Holdings column, Performance blended/active return, SIP excess return with the cash-flow-matched simulation, X-Ray coverage sentence, Overview coverage count). Open the monthly report: the benchmark appears only if the entitlement grants report/export.
6. Revoke the entitlement: the same screens must immediately show the honest blocked state; no 0%.
7. Correct one level through correction mode; confirm a new revision and the recompute; roll it back.
8. Record every DEV write in a new mutation ledger and delete rehearsal data through Jobs > Rollback.

## 4. Remaining external dependencies (precise)

| # | Dependency | Owner | Blocks |
|---|---|---|---|
| E1 | Written permission or a licence from NSE Indices (8 of 11 required identities) covering storage, calculation, customer display and report export of index levels; plus the documented access method and any automation right | NSE Indices / an authorised vendor | All data publication, source readiness |
| E2 | Same from BSE Index Services (BSE 100, BSE 500, BSE 250 SmallCap TRI) | BSE Index Services | The 3 BSE-owned benchmarks |
| E3 | A decision on gold/silver price sources and a blended-benchmark definition (SBI Multi Asset; HDFC Gold FoF) | Product Owner | Those two schemes |
| E4 | Human visit to the AMFI benchmark lists and the owners' index pages (unreachable from this environment) to verify official identifiers, base/launch/TRI-start dates and cross-check the 22 declared benchmarks | Product Owner | Catalogue verification |
| E5 | Current SID/KIM for UTI MNC, ICICI Dividend Yield, Kotak Mid Cap; scheme-master linkage for the ICICI Corporate Bond ISIN | Product Owner / AMCs | 4 mappings |
| E6 | Decision to apply 0232 + 0239 to DEV, then production; capability grants; the migration number re-scan before merge | Product Owner | Everything live |
| E7 | An exchange holiday calendar (operator-supplied or licensed) | Product Owner | Exact gap detection |

## 5. Rollback

Section "ROLLBACK" of `scripts/bench1_phase2_po_apply_0239.sql`; capability revocation; kill switches (already off). Code rollback = do not merge/revert the branch.
