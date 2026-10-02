# BENCH-1 Phase 2 - Public information, scheme mapping, Admin historical upload and recurring updates

Branch `feat/bench1-phase2-benchmark-upload-ingestion-20261001` (built on `feat/india-mf-investment-report-20261001`, whose newest head `15cf745` is merged). Not pushed, not merged. Prepared 2026-10-01. Spec: `BENCH1_PHASE2_MISSION_SPEC_2026-10-01.md`.

## 0. Evidence labels (read first)

| Label | Meaning |
|---|---|
| **code-complete** | Written, linted, type-checked, unit-tested here |
| **PGlite-verified** | Migration replayed (all 0001..0240 on main plus 0232 and 0241) on a real Postgres engine and exercised with negative controls. NOT the hosted database |
| **DEV-verified** | Exercised against the real DEV project. **Nothing in this work is DEV-verified.** |
| **production-verified** | **Nothing in this work is production-verified.** |

Plainly: migrations **0232 and 0241 are not applied to DEV or production** (no DDL path exists in this environment; the DEV PostgREST listing has no SQL-execution RPC). **No benchmark data was published anywhere.** No DEV or production write was made (ledger: `BENCH1_PHASE2_DEV_MUTATION_LEDGER_2026-10-01.md`). No provider was contacted, nothing was purchased, no licence approval was invented.

## 1. Verdicts (separate, as the spec requires)

| Verdict | Result | Why |
|---|---|---|
| **Technical implementation** | **PASS (code-complete + PGlite-verified), with two stated limits** | One staged upload pipeline (CSV/XLSX, three shapes), per-right entitlement gate (DB + TS), atomic idempotent publish with corrections/rollback, mapping governance, selective-history demand, ingestion orchestrator with kill switches/leases/watermarks, consumer gating, Admin UI/API. 196 PGlite checks, 3,668 passing unit tests across the touched families (17 pre-existing unrelated failures), 110 named negative controls. Limits: the Admin UI was never opened in a browser (no running app/DEV session; 360px layout unverified); the provider-export header sets are from public conventions, not a live download |
| **Source / data readiness** | **BLOCKED** | No public source grants FHIP's intended use; NSE Indices, BSE Index Services and CRISIL terms restrict personal/non-commercial use and prohibit automated collection/storage/redistribution; no price or licence terms are public. 0 of 11 required benchmark series exist. AMFI's own pages were unreachable. Detail: `SOURCE_DECISION.md` |
| **Live DEV end-to-end** | **NOT PERFORMED (blocked)** | Needs 0232+0241 applied to DEV (PO action) and a permitted real file (needs rights). A PO run script and checklist are provided (release package, section 3) |
| **Production activation and verification** | **NOT PERFORMED, not requested** | Out of authority; release package prepared |
| **Overall BENCH-1** | **NOT FULL PASS** | Required comparisons remain unavailable (no data, no rights) and the recurring/manual operating controls are code-proved but not operated live. Technical work is ready to be used the day rights exist |

## 2. Baseline verified against the repository and environments

* BENCH-1 was merged earlier (a314f79); DEV and production each hold **0** rows in `ii_benchmarks`, `ii_benchmark_series`, `ii_instrument_benchmarks` and `ii_benchmark_category_defaults` (re-verified 2026-10-01 by read-only GET). The 14 synthetic DEV rows were already removed (ledger in the evidence folder of the earlier mission).
* PC6 provides substantial schema: effective-dated mapping (0043), `licence_status` summary and provenance columns (0155), `ii_reference_import_batches` / `ii_reference_corrections` / `ii_reference_job_control` ledgers. These are **reused**: every publish writes one `ii_reference_import_batches` row (`benchmark_level`) so the PC6 Admin "import batches" panel shows uploads; every corrected or restored level writes `ii_reference_corrections`; the kill switches are `ii_reference_job_control` rows.
* The financial-planning `benchmark_datasets` / `lib/services/benchmarkGovernance.ts` system is untouched.
* **The `csvBenchmarkImporter` gate was investigated** (it was never connected to a route): it published only for `licence_status = 'public_open'`. That (a) wrongly excluded legitimate commercial entitlements (`licensed_held`) and (b) wrongly treated a label as proof of rights. It also wrote series with a bare `insert`, no staging, no entitlement scope, no audit. It is **removed** and superseded by the one pipeline; its parsing rules (strict decimals, no future dates, plain dates) are covered by the new validator's tests.

## 3. Held-scheme inventory and the scheme-to-benchmark matrix (deliverable 1)

Read-only inventory of DEV and PRODUCTION (`scripts/bench1_held_scheme_inventory.mjs`, GET only; privacy-safe; outputs in `docs/investment-intelligence/bench1_phase2/inventory/`): 57 held rows, of which 35 are DEV test fixtures; **22 real scheme rows / 20 families**, all Indian mutual funds in INR, all unmapped. Plans/options/ISINs are never merged (Direct and Regular HDFC Large Cap/Flexi Cap are separate rows sharing a family key for grouping only). Full matrix: `BENCH1_PHASE2_SCHEME_BENCHMARK_MATRIX_2026-10-01.md` (+ CSV). Result: **11 distinct single-index benchmark identities** (8 NSE, 3 BSE; all TRI) plus 2 unsupported (composite SBI Multi Asset; gold-price HDFC FoF). It is exactly what held schemes declare, not a generic list.

## 4. Sources (deliverable 2)

`SOURCE_DECISION.md` (root) holds the factual matrix with explicit unknowns; raw research and the fetch log: `docs/investment-intelligence/bench1_phase2/source_research/`. Headline: public information gives each scheme's **declared benchmark** (SID/KIM/factsheet/addenda) but **not** a licence to store, compute with, display or export index **levels**. A failed AMFI fetch (ECONNREFUSED on every attempt, three tools) is recorded as a failure, not as unavailability; a successful NSE/BSE/CRISIL read is not a licence. No CAPTCHA evasion, scraping around blocks, undocumented endpoints or mirrors were used.

## 5. Catalogue and mapping evidence (deliverable 3)

* Evidence for all 22 rows: `docs/investment-intelligence/bench1_phase2/mapping_evidence/` (document URLs, document dates, retrieval dates, excerpts, change history): 19 `verified_scheme_document` (2 of those are composite/non-index benchmarks and therefore unsupported), 3 `factsheet_only` (one stale, 2022).
* Benchmark **changes found** (effective-dated mappings are needed): SBI Multi Asset 2023-10-31; ICICI Corporate Bond 2024-03-12; ICICI Dividend Yield 2022-01-01; Franklin Mid 2018; DSP Large Cap 2026-05-16 (not held).
* Governance in the database: catalogue entry = DRAFT until a named admin verifies it (CHECK requires official name, owner, variant, currency, asset class, evidence, retrieval date, verifier); a verified variant is immutable; mappings start as **proposals with evidence**; only deterministic, high-confidence, evidenced, unambiguous primary matches to a **verified** catalogue entry may auto-publish (service role only); everything else needs a catalogue admin; overlapping PRIMARY mappings are refused by a database trigger; a benchmark change closes the previous mapping at the day before (history keeps its meaning).
* Seed: `docs/admin/po_apply_bench1_phase2/03_seed_catalogue_and_mapping_proposals.sql` (generated; DRAFT catalogue entries + PROPOSALS through the governed RPCs; verifies and approves nothing). Catalogue manifest: `bench1_phase2/catalogue_manifest.json`. **Owners are inferred** from index names (no scheme document names an owner); official identifiers, base and launch dates are left null - not verified (owner pages unreachable from here).
* Refresh triggers (first discovery of a held scheme, monthly, on benchmark-change evidence): the proposal/review workflow and `auto_publish_benchmark_mapping` are built; the scheduled discovery job is not (it needs permitted sources for scheme documents; recorded as open).

## 6. Admin upload workflow (deliverables 4-5)

Integrated into the existing Admin surface (same URL as the India page, nav group renamed **Market Index Data**; alias route added); no second portal. Six separately named capabilities (`docs/admin/BENCHMARK_DATA_ADMIN_CAPABILITIES.md`); none granted by migration. Single pipeline stage -> validate -> approve -> publish:

* **Formats/shapes:** CSV and XLSX; `date,value`; `benchmark_key,date,value`; registered provider exports; explicit column mapping, never inferred. XLSX: explicit sheet, hidden rows/sheets disclosed, formula cells in required columns rejected, Excel 1900/1904 date systems. Purpose-built strict XLSX reader (the installed `xlsx` 0.18.5 is unmaintained on npm with known CVEs; no dependency was added).
* **Validation:** type and magic-byte sniffing, MIME mismatch, byte/row limits, zip-bomb limits (entries, uncompressed size, ratio, lying headers caught at inflate), encoding, delimiter, explicit date formats, timestamps refused, strict locale-aware decimals, 6-decimal precision, no future dates, exact benchmark/variant/currency, in-file duplicates, existing/conflicting rows, gaps, weekend rows, large moves (flagged, not rejected), suspected rebasing; **nothing is synthesised or interpolated**.
* **Preview** shows benchmark/source, earliest/latest, total/valid/invalid rows with row numbers, identical rows to skip, new rows, corrections with before/after, gaps/warnings, per-benchmark eligibility, exact publication scope. **Hard errors block publication; no partial publish** (reviewed partial publication deferred: Admin Standard does not define it).
* **Staging is server-side** (`ii_benchmark_import_jobs/_rows/_errors`); the browser preview is never the authority. Approval is bound to file checksum, staging digest, previewed counts, entitlement, actor and time; the database re-validates capability, entitlement (revocation/expiry/scope), digest, counts and the current series, serialises per benchmark, and publishes atomically. Idempotent: the same file cannot publish twice; a second concurrent import is refused as stale. Same-person stage+publish needs an explicit recorded acknowledgement.
* **Corrections/rollback:** separate capability and reason; the old level is kept as a revision (`revision_no`, `ii_reference_corrections`); rollback restores or soft-retracts (nothing deleted; refused when later revisions exist). Error CSV is formula-injection safe. Raw files are never stored; staged copies expire (14 days unpublished / 90 days published).
* **Templates and help:** `BENCH1_PHASE2_UPLOAD_TEMPLATES_AND_INSTRUCTIONS_2026-10-01.md`.

## 7. Entitlement gate (deliverable 6)

Actual enums inspected (0155): `licence_status in ('public_open','licence_required','licensed_held','unknown')`. **No value was invented.** The coarse label is demoted to a summary and is consulted by nothing. The authority is `ii_benchmark_entitlements`: one row per grant with separate rights - manual ingest, automation, storage, calculation, customer display, report/export - plus data-date scope, term, post-expiry retention (retain/delete/unknown, with calculation/display carve-outs), exact variant and currency, evidence (a public-use permission needs URL + document date + retrieval date), approval by a separate capability (proposer self-approval needs explicit acknowledgement) and revocation. `benchmark_right_allowed()` (SQL) and `rightAllowed()` (TS mirror) are the single predicate used by: the CSV publish RPC (ingest + storage, entitlement pinned by id), the feed RPC and orchestrator (automation + storage), the **series row-level security** (calculation: an unentitled series is invisible to ordinary readers), and the consumer loaders (calculation + display for screens; + export for reports). Unknown/blocked/expired/out-of-scope fail closed; revocation or expiry between staging and publication is refused; post-expiry retention is honoured without blanket deletion. The 0232 single-step RPC (attestation checkbox) is revoked from `authenticated`; the 0232 feed RPC now needs the automation + storage rights; the old POST route answers 410. **Deliberate consequence for the India report:** Nifty 50 / Sensex header values now need an approved entitlement before customers see them (they previously relied on the attestation alone). Date-scope on reads is applied in the application layer (the DB row gate is benchmark-level).

## 8. Selective-history demand and coverage (deliverable 8)

`ii_benchmark_history_demand` stores per-benchmark aggregates once (global, no user columns): earliest date by the engines' own rules (investor rule = first transaction; engine rule = earliest NAV on file, both minus the engines' 10-day alignment lookback), latest expected session, bounded by mapping-effective periods, expanding when older transactions/mappings appear, never a full-universe backfill. Report: `BENCH1_PHASE2_COVERAGE_AND_GAP_REPORT_2026-10-01.md` (0% covered today; 11 of 19 production schemes need levels back to 2006-03-24 under the engine rule).

## 9. Recurring ingestion and manual-import mode (deliverable 7)

Built, disabled by default, adapter registry empty: environment flag, project-ref guard (a DEV job cannot write production), job secret, global and write kill switches (DB-enforced again inside the feed RPC), per-benchmark mode/source switch, central entitlement, backoff, daily retry budget, single-flight lease with expiry, bounded resumable windows (daily with 5-session correction lookback, late retry, weekly gap, monthly reconcile, newest-first history expansion), provider rate limit, independent `last_attempt_at` / `last_successful_run_at` / `latest_valid_data_date` / `completeness_watermark` (clamped, gap-tolerant, no holiday calendar shipped - disclosed), HTTP 200 with no expected data is **not** success, a refusal (401/403/captcha/HTML) stops the run. **Manual-import mode** with an Admin **pending-import task** (due/overdue/never imported/history missing; wording always "upload", "nothing updates automatically"). No pg_cron schedule exists. Runbook: `BENCH1_PHASE2_RUNBOOK_2026-10-01.md`.

## 10. Five-screen consumption (deliverable 9) - code-level only

Reuses the certified R4/R5 engines; only the data loaders gained the entitlement gate. Fixture evidence (`tests/unit/benchmarkDataConsumers.test.ts`, 11 tests): entitled benchmark + effective mapping + series -> real TRI comparison (Holdings: exact key, TRI label, certified 10% point-to-point); entitlement absent / display missing / scope after window start / mapping ended -> honest blocked or history-incomplete states (never 0%); a corrected level changes the comparison (110 -> 111 = 11%); cache invalidation is content-addressed (the engine input fingerprints change when benchmark points are added, corrected or withheld); X-Ray coverage counts entitled mappings as mapped and un-entitled as blocked; Overview counts a mapping as coverage only when the benchmark is entitled **and** has published levels; reports/exports need the separate export right. SIP and Performance use the same loaders. **Not demonstrated:** a real-file journey on DEV through the five live screens, SIP cash-flow-matched simulation on real benchmark levels, and existing report exports with real data (all need data + rights). Fixtures prove code behaviour, not coverage or operation.

## 11. Tests (exact commands; the machine was loaded, so files were run singly or in groups)

| Check | Result |
|---|---|
| `node scripts/bench1_phase2_0241_pglite_verification.mjs` (real Postgres, chain 0001..0241 from empty, re-apply idempotent) | **196 passed, 0 failed** |
| `npx vitest run tests/unit/benchmarkDataFile*` (file ingest) | 8 files, **482 passed** |
| `.../benchmarkDataAdminRoutes.test.ts` (route x capability matrix, s5, s8, s11, s13, static) | **217 passed** |
| `.../benchmarkDataEntitlements.test.ts` / `benchmarkDataIngestion.test.ts` / `benchmarkDataConsumers.test.ts` | **21 / 42 / 11 passed** |
| `.../benchmarkDataUiLogic` + `ClientContract` + `ClientStates` | **57 + 10 + 12 passed** |
| Regression: `tests/unit/{pc6,pc7,ii,admin,market,benchmarkData,india,appNav,appCapability}*` (165 files) | 3,668 passed; **17 failures, all in `adminAnalyticsPhaseAMeRoute.test.ts`, pre-existing on `origin/main` (documented in the India report; not caused or fixed here)** |
| `eslint` on all touched files | 0 errors, 0 warnings |
| `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit -p .` | **1 error, pre-existing and unrelated** (`tests/unit/canonicalCertResidueAllSql.test.ts(127,75)`); **none in any touched file** (an earlier run's 7 errors in files I touched were fixed) |

Repository-walking tests time out at 5 s under parallel load (a known hazard); the full suite was not run (it rewrites checked-in `scripts/` artifacts); the run's artifact churn was reverted with `git checkout -- scripts/`.

**Negative controls (each rule broken one at a time, a NAMED test/check observed to FAIL, file restored byte-exactly):** file ingest 49/49 (`evidence/bench1_phase2/file_negative_controls.json`), TypeScript governance/entitlement/scheduling/route rules 33/33 (`core_negative_controls.json`), database rules 17/17 on PGlite (`db_negative_controls.json`), UI rules 11/11 (`ui_negative_controls.json`). A real defect was found by the PGlite run (an `AND`/`OR` precedence slip in the stale-preview guard) and fixed; two further controls initially showed redundant defences (watermark clamp, id-pinned entitlement) and the checks were strengthened until each control failed a named check.

## 12. Migrations and configuration (deliverable 10)

* New: `0241_bench1_phase2_benchmark_data_governance.sql` (additive; no shared CHECK dropped/recreated: variants live in a new `return_variant` column, the `licence_status`, `return_type`, batch-kind/status and audit-event lists are untouched). Depends on 0155 and 0232 (guards fail loudly). Own append-only audit log `ii_benchmark_governance_events`.
* **Collision scan (run three times, last this session):** all local and remote refs and every worktree under `D:\FHIP\.claude\worktrees`. Found above main's `0229`: `0230` (module 11.7), `0231` (admin premium grant, on main), `0232` (India index; this branch's base), `0236` (owner-before-upload, on main), `0237`/`0238` (premium promo/reminders, premium branch), `0240_networth_current_nav_remark` (on main). The work was first numbered 0239, **renumbered to `0241`** (above everything found) and the PO has **applied 0241 (and 0232) on DEV**, so the name is now permanent: a migration that has been applied anywhere is never renamed. Main's `iiNetWorthNavRemarkContracts` test (which asserted 0240 was the highest migration) was made robust instead (0240 exists, unique, no other file shares its number). Re-scan before merging; `0232` must apply before `0241`.
* Config: see the release package section 2 (all off by default).
* Merge notes: expect mechanical conflicts in `lib/admin/adminNav.ts` and `app/api/admin/me/route.ts` with the admin-premium-grant branch (both add capability fields: keep both).

## 13. Admin Architecture Standard compliance

Capabilities: six (view reuses PC6; upload reuses 0232; four new). Clauses and proving tests: `docs/admin/BENCHMARK_DATA_ADMIN_CAPABILITIES.md`. Exceptions requested under s16: **none**. Incidental finding not fixed (s14): 17 pre-existing failing tests in `adminAnalyticsPhaseAMeRoute.test.ts`.

## 14. What could not be verified (plainly)

DEV/production behaviour of any new code; the Admin UI in a browser (desktop and 360px); a real source file end-to-end; the five live screens with real benchmark data; NSE/BSE/CRISIL permissions and prices (unknown); AMFI benchmark lists (unreachable); provider-export header layouts against a live download; owner identities, official identifiers, base/launch/TRI-start dates for the 11 catalogue entries (owners inferred; left null); the exchange holiday calendar; a scheduled mapping-refresh job; the full unit suite (not run, by design).

## 15. What the PO must do or decide

1. **Rights (blocks all real data):** decide the source route and obtain written permission/licence for index levels (NSE Indices for 8 of the 11, BSE Index Services for 3); questions to ask are in `SOURCE_DECISION.md` section 6. Decide whether AMC-published scheme-vs-benchmark returns alone would be an acceptable interim product.
2. **Apply** 0232 then 0241 to DEV with `scripts/bench1_phase2_po_apply_0241.sql` (verify block included); re-scan migration numbers before any merge; production only after sign-off.
3. **Grant capabilities** deliberately, one admin at a time (suggest: yourself catalogue + entitlement approver; a second admin publisher).
4. **Verify the catalogue** against the owners' pages (owners are inferred; identifiers/dates unverified); optionally run the draft seed.
5. **Decide** the two unsupported schemes (a permitted gold/silver price series and a blended-benchmark definition) and whether to demand the narrower investor window first.
6. Provide current SID/KIM for UTI MNC, ICICI Dividend Yield, Kotak Mid Cap; scheme-master linkage for the ICICI Corporate Bond ISIN.
7. Note the **India report consequence**: Nifty 50 / Sensex header values stay hidden until an entitlement exists for them.
8. Do **not** enable ingestion or create any schedule until an automation right is approved in writing. Then run the live DEV walkthrough (release package section 3) and record its mutation ledger.
