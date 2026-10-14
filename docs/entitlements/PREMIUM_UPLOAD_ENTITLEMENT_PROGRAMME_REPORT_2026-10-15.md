# Premium Upload Entitlement -- programme report (15-10-2026)

Verdict wording earned: **READY FOR PO MERGE AND PRODUCTION VERIFICATION.** Not "production verified", not "TERMINAL FULL PASS": there is no
production evidence, and the Premium extraction -> review -> Apply journey per domain was not re-run live. See "What is and is not proved".

* Base: `origin/main` `af2d330`. Branch: `feat/premium-upload-entitlement-20261014`. Code-only release: no migration, no SQL to apply, no Amplify variable.
* Capability: `lib/entitlements/financialDataImport.ts` (`resolveFinancialImportAccess`, `refuseUnlessFinancialImportAllowed`, `assertFinancialImportAllowed`,
  `refuseUnlessImportRunMayStart`, `financialImportAccessView`); client-safe contract `financialDataImportContract.ts`; inventory
  `financialImportInventory.ts`; developer reference `PREMIUM_UPLOAD_ENTITLEMENT.md`; operator pack `docs/ops/po_apply_premium_upload_entitlement/`.

## Inventory (exact counts; the matrix is committed and test-synchronised)

* 28 gated routes: 13 admission + 15 run-start. 13 review / apply / delete routes deliberately not gated. 7 Admin / system route families exempt. 14 manual-entry route families that must stay Free.
* No signed upload credentials exist anywhere (uploads are server-mediated); the storage policies give authenticated users SELECT only on the customer buckets (both asserted by CI).
* Discovery agreed across four methods: static search (`git grep` ingestion signals over `app/api`), route-manifest comparison (585 route/page files at `af2d330` and at HEAD, none added or removed; production build manifest 589 app paths), API inspection (every route enumerated, POST/PUT/PATCH reviewed), and runtime navigation (browser, six import surfaces).

## Findings fixed in this programme

1. Every customer upload / import / reprocess path was open to Free (28 routes). Now gated at the route (before the body) and, for FDH and AIE, again at the service layer.
2. `POST /api/investment-intelligence/source-documents/[id]/parse` (fixture importer) let any authenticated user write a JSON statement into Investment Intelligence; now Premium.
3. The production build caught a real regression of my own (server entitlement reader reached a client bundle through `lib/aie/db/repository.ts` -> `lib/pc5/discard.ts`); fixed by `lib/aie/intakeAdmission.ts`.
4. Billing return-from-checkout had no "activating" state; added (no early unlock; plan still comes only from the verified webhook).

## Tests

* New: 369 tests in 5 files (capability 45, CI contract 55, routes 215, services and downgrade lifecycle 13, UI 41). All pass.
* Negative controls, executed (not assumed): nine real mutations each made the suite fail (guard removed from an admission route: 6 failures; from a run-start route: 5; service assert removed: 5; capability fails open on a read error: 35; trusts a missing row: 15; panel draws a form before the server answers: 3; an Admin route requires Premium: 2; a manual route requires Premium: 2; a brand-new ungated upload route: 1). Results: `evidence/negative_controls_mutation_results_2026-10-15.json`.
* Whole suite on the final tree: 735 files; 27 failed files / 30 failed tests, **all also failing on a clean checkout of `af2d330`** (timeouts under load and environment-bound suites: benchmark data, planning benchmark, resources, admin analytics, etc.). Six more files that failed in that full run (`benchmarkDataFile*`) failed only through a vitest temp-directory ENOENT race and pass in isolation (twice). Before the legacy-test fix the same run had 59 failed files / 171 tests; the difference was tests that exercise uploads for other reasons and now run as an entitled customer through `tests/support/premiumImportEntitlementMock.ts`.
* `npx tsc --noEmit`: clean on the final tree (a baseline `canonicalCertResidueAllSql` error that appears in some runs is not mine; it also occurs on `af2d330`). ESLint on every touched file: clean. Production build: PASS (Turbopack, exit 0; placeholder public Supabase env supplied because prerender needs it).

## What is and is not proved

| Claim | Evidence class |
|---|---|
| Free is refused 403 `PREMIUM_REQUIRED` on 28/28 routes before the body, with zero rows / objects / downstream calls | UNIT-TESTED (215 route tests) and **DEV-verified** (real DEV, counters unchanged) |
| Premium is not refused and nothing breaks | UNIT-TESTED, **DEV-verified** (0/28 refused, no 5xx), one real admission with the Premium stamp |
| Entitlement outage fails closed (503, not Free) | UNIT-TESTED |
| Downgrade policy (first run + in-flight continue; retry / forced re-parse / unknown refused; credential not honoured after a downgrade) | UNIT-TESTED on a stateful fake; **not exercised on DEV** |
| Premium parser -> review -> Apply per domain | Not re-run live (parsers untouched). AU investment needs an AU Premium fixture that DEV lacks |
| Admin / manual-entry / canonical-data exemptions | UNIT/CI-TESTED (contract checks 3, 4, 6, 8) |
| Free / Premium UI (six surfaces, phone width) | UNIT-TESTED (SSR) and browser-verified against DEV data |
| Production behaviour | **NOT VERIFIED** (PO pack prepared) |

## Defects / risks (honest)

* P0: 0. P1: 0.
* P2: a Free user can still create an empty document **row** by calling PostgREST with their own JWT (self-insert RLS on `fdh_statement_uploads`, `aie_document_intake`, `ii_source_documents`). It has no stored bytes, so nothing can be parsed, queued or sent to a provider from it. Closing it needs a database policy requiring Premium (a migration); not done.
* P3: client-side lock-impression analytics are not implemented (no analytics sink in the codebase); server decision events are structured, PII-free log lines.
* P3: one entitlement read per guard (an FDH upload runs three); about 160 ms each from a remote machine to DEV, network dominated. Re-measure on production; a request-scoped memo is possible but was not added because it weakens "upgrade / downgrade effective on the next request".
* Insurance has no customer upload UI on main; its AIE intake API is gated. Recorded as not active, not as a pass.

## Coordination

* AI-access programme (`feat/ai-premium-wide-access-*`) overlaps these files (both programmes touch them, one small hunk each): the four AIE intake routes, `aie/investment-intelligence/intake/[intakeId]/process`, the `process` routes of bank-pdf / investment / liability / payslip / retirement, the `upload` routes of investment / liability / retirement, `investment-intelligence/source-documents/[id]/process`, the five import panels, and six legacy tests (`aieMalwareGateUnreachableExtraction`, `aieOwnerBeforeUploadRoutes`, `aieStatementDraftConfirmRoundTrip`, `m12aFdhBankAccuracyCorpus`, `m12aFdhBankIntakeGate`, `m12bInsuranceAccuracyCorpus`). Textual merge only; semantics are layered (mine = may this user start a new import; theirs = may a chargeable AI call happen).
* No overlap with the Resources bulk-upload, Module 11 integration, promo hardening or benchmark-entitlement branches.
