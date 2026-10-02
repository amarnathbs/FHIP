# Nifty 50 / BSE Sensex first historical upload - offline verification (2026-10-02)

Branch: `chore/index-first-upload-verification-20261002` (worktree `D:\FHIP\.claude\worktrees\index-first-upload`), cut from `origin/main` `d755cfb`; one code commit `f1e4c35` (this report is committed alongside it). Nothing pushed, nothing merged, no database touched, no migration applied, no provider contacted, no credential used.

Environment actually used: local Node (tsx/vitest) only. **No DEV or production database was reachable, and nobody can sign in unattended, so every DB-dependent step below is NOT PERFORMED.** Whether 0232 and 0241 are applied on DEV / production was **not verified by me**; I only verified the migration files exist on main (`0232_market_index_data_upload_and_feed.sql`, `0241_bench1_phase2_benchmark_data_governance.sql`, unique numbers, 0232 precedes 0241 and 0241 guards on 0232).

## Six verdicts

| # | Step | Verdict |
|---|---|---|
| 1 | File validation | **PASS offline for the 2-decimal cleaned copies; the supplied-precision files FAIL as-is** (hard error `VALUE_TOO_PRECISE` on 3,710 / 5,033 rows, so the real pipeline would refuse publication of the whole file). DB-dependent counts (existing rows, conflicts) NOT PERFORMED. |
| 2 | Source accuracy and calendar completeness | **OPEN - NOT PERFORMED.** No permitted public page was readable (NSE page timed out, BSE 403, niftyindices timed out, asiaindex empty, two Wikipedia pages silent). Saturday 2025-02-01 special-session status is **unverified**. Internal inconsistencies between the two files are flagged. |
| 3 | Entitlement readiness | **MISSING / BLOCKED.** No entitlement was created, proposed or drafted; existing records on the databases were not read. A download, a yfinance run or yahoo.com as "evidence" is not a usage right. |
| 4 | DEV canonical publication | **NOT PERFORMED** (no DB path, no signed-in session, entitlement missing). |
| 5 | Live UI / report integration | **NOT PERFORMED** (no browser session, nothing published). Code-level wiring analysed; one real defect found and fixed (below). |
| 6 | Production readiness | **NOT READY.** Blockers: entitlement missing, supplied files fail the precision rule, accuracy/calendar open, DEV journey not run, catalogue identities still draft/unverified. |

## 1. File validation (shared importer, run in-process)

Method: a tsx harness (kept outside the repo; files read read-only from `C:\Users\user\Downloads\index_history\`, never copied) called the same pure functions the admin pipeline uses - `readUploadToTable` (inspection, UTF-8, delimiter, header) then `validateUpload` from `lib/services/investment-intelligence/benchmarkData/fileIngest` (`VALIDATOR_VERSION bench1-file-validator-v1`) with the exact form parameters an operator would choose: shape single, mode new_history, key `IN_NIFTY_50_PRI` / `IN_SENSEX_PRI`, variant price, INR, date `YYYY-MM-DD`, locale plain, today 2026-10-02, catalogue = the 0232/0241 seed values (price, INR, active), **existing published rows = empty (assumption, DB not read)**.

Note: the mission text names `benchmarkData/file/*`; the real directory is `benchmarkData/fileIngest/`.

SHA-256 and sizes:

| File | Bytes | SHA-256 |
|---|---|---|
| Nifty50_admin_upload.csv (supplied) | 123,707 | `2b949afbab5cbcb32136e87e0aa5622f870ed70b84ac7f2721621ebc5586a44d` |
| Nifty50_admin_upload_cleaned.csv | 90,951 | `b78325d91afc7ae689eab1d17003fe2b1ba7ec88dafb49d832520511750ef9a1` |
| Sensex_admin_upload.csv (supplied) | 164,922 | `97bf1b4adc2e548d931cf8ff2b3cc058c80b56295605657ea41fda9bf36996d2` |
| Sensex_admin_upload_cleaned.csv | 121,963 | `02425251a3f7839eac140fc42dfbe631e85e9188aa1c66ea299e3ba588d73af5` |

(The cleaned hashes match `cleaned/manifest.json`.) Both inputs: ASCII, CRLF, header exactly `date,value`, ISO dates, ascending, no duplicate dates (4,672 / 6,157 unique), no future date.

Results (assuming nothing already published):

| File | rows | valid | invalid | staged new | hard errors | warnings / acks required |
|---|---|---|---|---|---|---|
| Nifty supplied | 4,672 | 962 | 3,710 | 962 | 3,710 (`VALUE_TOO_PRECISE`, "At most 6 decimal places are accepted", first at row 2) | 11 large-move, coverage-gap listing capped at 100 (392 gaps, an artefact of the rejected rows) |
| Nifty cleaned | 4,672 | 4,672 | 0 | 4,672 | 0 | `WEEKEND_ROW` x1 (2025-02-01, kept, flagged), `LARGE_MOVE` x3; acks required: `large_moves`, `weekend_rows` |
| Sensex supplied | 6,157 | 1,124 | 5,033 | 1,124 | 5,033 (`VALUE_TOO_PRECISE`) | 18 large-move, coverage-gap listing capped at 100 (359 gaps) |
| Sensex cleaned | 6,157 | 6,157 | 0 | 6,157 | 0 | `LARGE_MOVE` x4; ack required: `large_moves` |

identical / correction / conflict counts cannot be computed without the DB (all rows classify `new` against an empty series). Coverage per importer (cleaned): Nifty 2007-09-17 to 2026-10-01; Sensex 2001-10-03 to 2026-10-01; no weekday gap above the importer's 3-weekday threshold except the two Sensex/Nifty ones in the calendar findings below.

### Storage precision convention (the decision the real pipeline makes)
- Storage is `numeric(18,6)` (`ii_benchmark_series.value`, `ii_benchmark_import_rows.value`, staged rows rounded `round(value, 6)` by `stage_benchmark_import_rows`); the importer accepts **at most 6 decimals** and rejects more (`numberParsing.ts`, `MAX_DECIMALS = 6`; trailing zeros beyond 6 are tolerated). Display convention: `Intl.NumberFormat('en-IN')` with exactly 2 decimals in the India MF report header.
- **The supplied float-precision files are therefore not accepted as-is**: 3,710 of 4,672 Nifty rows and 5,033 of 6,157 Sensex rows carry 8-12 decimals, including the Saturday row (`23482.150390625`, which the mission text quotes as approx. 23482.150391). Any hard error stops publication of the whole file (the pipeline never publishes a valid subset silently). The pipeline is not mishandling them; it is applying its documented rule. I did **not** change the rule: silently rounding PO data inside the importer would break the "no silent change to supplied values" principle.
- Evidence that the extra digits are binary-float artefacts, not information: for **every** row of both files `supplied == Math.fround(cleaned)` (4,672 / 4,672 and 6,157 / 6,157), `round(supplied, 2) == cleaned` for every row, and the maximum absolute difference is 0.00078 (Nifty) / 0.00375 (Sensex). The cleaned 2-decimal copies are the files the pipeline will accept and the values the provider quotes; the PO must choose that explicitly. The mission instruction "preserve supplied numeric precision" cannot be honoured literally by the schema (6 decimals); rounding a float32 artefact to 6 decimals (`4494.649902`) would store false precision.

### Flags (cleaned data; none interpolated, nothing dropped)
- **Weekend row:** Nifty 2025-02-01 (Saturday) only. Sensex has no weekend rows and **no 2025-02-01 row**.
- **Large moves (>10%, importer):** Nifty 2008-10-24 (-12.2%), 2009-05-18 (+17.74%), 2020-03-23 (-12.98%); Sensex 2004-05-17 (-11.14%), 2008-10-24 (-10.96%), 2009-05-18 (+17.34%), 2020-03-23 (-13.15%). Further 7-10% moves (my own scan) cluster on 2008-01-21, 2008-10, 2020-03/04. The dates coincide with well-known market stress episodes, but that is a plausibility observation, **not** an official-value check.
- **Rebasing / scale change:** none flagged (no day-over-day ratio above 5 or below 0.2; Nifty range 2,524.20-26,328.55, Sensex 2,754.95-85,836.12).
- **Suspected missing sessions (provider gaps):** weekdays present in one file and absent from the other, which two exchanges with a shared holiday list should rarely show. Nifty only: 2008-01-01, 2014-12-26, 2014-12-29, 2020-01-01, 2021-05-07, 2024-01-01 (+ Sat 2025-02-01). Sensex only: 2011-05-31, 2011-07-14, 2011-11-24, 2011-12-26, 2012-05-21, 2012-08-28, 2014-01-01, 2014-02-17, 2015-04-15, 2016-08-12, 2018-01-01. Each is a candidate missing session in the other file; none has been confirmed against an exchange record. The importer's own 4-weekday gap check found nothing in the cleaned files; my 3-weekday scan found 2014-10-01 -> 2014-10-07 (both files) and 2014-12-24 -> 2014-12-30 (Sensex).
- **Weekdays absent from both files in the Nifty period (2007-09-17 to 2026-10-01):** 287 (per year 4-20; e.g. 2008: 17, 2009: 20, 2019: 20). Ordinary exchange holidays are expected here but no official holiday list could be read, so completeness is unproven. Clusters of three or more consecutive weekdays: 2009-04-03..14, 2009-12-25..2010-01-01, 2014-10-02..06, 2016-04-14..19, 2020-04-02..14, 2023-03-30..04-07, 2025-04-10..18, 2026-03-26..04-03.
- **Possible missing special sessions:** no Saturday/Sunday rows exist other than Nifty 2025-02-01, so any Budget-Saturday, weekend Muhurat or disaster-recovery-drill Saturday session in 2001-2026 is absent from both files; I could not check an official list, so this is unassessed.

## 2. Catalogue identities (migration 0232 seed, as modified by 0241)

Both rows exist only by seed; **no existing catalogue record was read from any database** (cannot). Repo-derived expected state:

| Column | IN_NIFTY_50_PRI | IN_SENSEX_PRI |
|---|---|---|
| benchmark_label | Nifty 50 (price index close) | BSE Sensex (price index close) |
| benchmark_category / country_code | index / IN | index / IN |
| return_type (0043 class) / return_variant (0241, backfilled `PRI -> price`) | PRI / price | PRI / price |
| frequency / currency_code | business_daily / INR | business_daily / INR |
| licence_status (coarse, grants nothing) | unknown | unknown |
| lifecycle_status (0155 default) | active | active |
| catalogue_status (0241 default) | **draft** | **draft** |
| official_name, owner_name, official_identifier, asset_class, base_date, base_value, launch_date, history_start_date, evidence_ref, evidence_retrieved_at, verified_by/at | all NULL | all NULL |

`ii_benchmarks_verified_complete` (CHECK) would require, to set `catalogue_status = 'verified'`: `official_name`, `owner_name`, `return_variant`, `currency_code`, `asset_class`, `evidence_ref`, `evidence_retrieved_at`, `verified_by`, `verified_at` all non-null (verification is done by `can_manage_benchmark_catalogue` through the catalogue verify route). The variant of a verified benchmark is immutable. The rows are not mapped in `ii_instrument_benchmarks`, so no fund comparison changes.

Authoritative evidence still needed (not obtainable here): the index owner's own page / methodology giving the exact official name, owner/administrator, identifier, base date/value and launch date. Public pages tried once each: `niftyindices.com/indices/equity/broad-based-indices/nifty-50` (timeout), `asiaindex.co.in/indices/equity/sp-bse-sensex` (empty content). The scheme-matrix document lists owners for some indices, but the BENCH-1 report labels owners as inferred; I assert nothing about the owners or official names. The importer does not require `verified` to stage/publish (it requires active + exact variant + currency); verification is a recommended governance step, not a database gate.

Variant identity: both are price-return (PRI) series, **not TRI**, INR, India. They must not be attached to Nifty 50 TRI / Sensex TRI keys, futures, or any fund mapping; the pipeline refuses a variant or currency mismatch (`VARIANT_MISMATCH`, `CURRENCY_MISMATCH`).

## 3. Source and entitlement

Recorded source facts (from the mission, not independently evidenced): Yahoo Finance via yfinance; tickers `^NSEI` (Nifty 50), `^BSESN` (BSE Sensex); original filenames above; return variant price (Close); currency INR; actual coverage as above; retrieval timestamp **unknown** (none evidenced).

Entitlement: the authoritative gate is `ii_benchmark_entitlements` (per-right, migration 0241; kinds `public_use_permission` / `commercial_licence`; a public-use permission requires evidence URL, document date and retrieval date; publication needs approved, in-term rights `ingest_manual` + `storage` for the exact benchmark/variant/currency and data-date range, bound by id at staging and re-checked at publication; row-level security needs `calculation`; consumers need `customer_display`, `report_export`). **Status: MISSING.** The repo itself records the prior position: the `ii_benchmarks.licence_status` comment (0155) states NSE/NIFTY and BSE/SENSEX index levels are licence_required (BLOCKER PO-PC6-1), and 0232 shipped the daily feed disabled because NSE and BSE restrict automated scraping and redistribution. I did not create, propose, approve or suggest wording for any entitlement and did not weaken the gate. Blocked action: **publication of both files (and any automation)**; staging/preview can be completed but `eligible` will be false and `canPublish` false.

## 4. Calendar and accuracy checks

- Official-source comparison (first/last, ordinary, volatile, special-session dates): **NOT PERFORMED.** Attempts (one read each, no workaround): `nseindia.com/resources/exchange-communication-holidays` - timeout; `bseindia.com/static/markets/marketinfo/listholi.aspx` - HTTP 403; `niftyindices.com` - timeout; `asiaindex.co.in` - no content. `en.wikipedia.org/wiki/2025_Union_budget_of_India` and `.../Union_budget_of_India` were read once: **neither states** whether NSE/BSE traded on Saturday 2025-02-01. Result: whether 2025-02-01 was an official special session on NSE and on BSE is **unverified**; accuracy certification stays OPEN. The importer correctly keeps the row (weekend rows are flagged, never deleted); the Sensex file's lack of a row for that date is a discrepancy to resolve against the exchange record, not to fill by invention.
- Internal consistency (verified): every row reconciles between supplied and cleaned copies at 2 dp; first/last dates match the mission; tolerance recorded for supplied vs cleaned: <= 0.0038 index points.

## 5. Mandatory disclosures

- **Nifty begins 2007-09-17**: no Nifty price history before that date is supplied; this does **not** satisfy the March 2006 history requirement (the engines' historical floor is `HISTORICAL_FLOOR_DATE = 2006-04-01`; the matrix documents 2006-03-24 as the earliest-date rule for the TRI benchmarks). Sensex begins 2001-10-03 (that does cover 2006).
- **Neither file is TRI.** They are Close price-index values; loading them completes none of the 11 declared TRI benchmarks and does not advance overall BENCH-1.
- **Daily feed remains disabled** (job `market_index_daily_close` seeded `enabled=false` by 0232; the cron route additionally needs `MARKET_INDEX_FEED_ENABLED=true`, which is not set in `amplify.yml`; 0241 now also requires approved `automation` + `storage` rights). No Yahoo cron or provider was registered.

## 6. Downstream wiring (code analysis; nothing displayed because nothing is published)

There is **no India market-summary or historical-chart feature in the repository** (searched `app`, `lib`, `components`; none exist). The mission's chart/market-summary checks therefore have nothing to verify. The only customer-facing consumer of these two series is the **India Mutual Fund Investment Report header** (`indiaMfReportData.ts` -> `loadIndexCloses` -> `indiaMfReport.resolveIndexQuote` -> `IndiaMfInvestmentReportSection`, in the premium/monthly report for any user with INR mutual-fund folios).

What would change on screen once published AND entitled: the header shows `BSE Sensex <value, en-IN, 2 decimals> as at DD-MM-YYYY` and `Nifty 50 ...` using the latest non-superseded close on or before the report's valuation date (generation day), e.g. 71,909.70 and 22,421.95 as at 01-10-2026 from the cleaned files. Otherwise it shows "not available". Reports already generated are snapshots and do not change. Gaps against the mission's display wishes (not fixed; a copy decision for the PO): the header label says only "BSE Sensex" / "Nifty 50" - it does not say "price index" or "index points". The market date (not the retrieval date) is what is shown.

Readers and their entitlement control:
- `ii_benchmark_series` row-level security (0241): ordinary users see a benchmark's non-superseded rows only with an approved in-term `calculation` right; admins with any benchmark capability see all (DB layer, all readers).
- India MF report header reader: **was gated only by that row-level security (calculation)** - see the defect below; now also requires display + export and data-date scope.
- BENCH-1 comparison consumers (Holdings, X-Ray coverage, Performance R4, SIP R5, Overview, report chapters via `benchmarkAccess.ts`): entitlement-gated, but these two keys are **not mapped to any fund**, so they never appear there.
- Admin "Market Index Data" GET: capability holders only (`can_upload_market_index_data`).
- Daily feed RPC: service role, needs `automation` + `storage`.

Cache/recompute: the report header is computed per report generation (no cache of its own); no invalidation step is needed for a published close to appear in the next report.

## 7. Defect found and fixed (commit `f1e4c35`)

`marketIndex/indexCloseReader.ts` (the India MF report header reader) did not check `customer_display` or `report_export`, nor the entitlement's data-date scope; the BENCH-1 report states these values "need an approved entitlement before customers see them", but a **calculation-only** entitlement would have exposed them in a customer report. Fix: read `benchmark_entitled_actions` via `loadBenchmarkAccess`, require the `export` need (calculation + display + export, same as the other report loaders), clamp to `[data_from, data_to]`, and fail closed (null = "not available") on a failed lookup, a client without `rpc`, or no entitlement. Tests: new `tests/unit/indexCloseReaderEntitlement.test.ts` (9 tests; **8 fail with the fix reverted**, shown by a negative-control run); `tests/unit/indiaMfReportIntegration.test.ts` fixtures were updated to model an approved entitlement.

Not fixed / out of scope: the importer precision rule (by design, see section 1); a pre-existing `tsc` error in `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)` (untouched file); the Admin "Market Index Data" ledger panel reads `ii_market_index_batches` (0232), which the 0241 pipeline does not write (it writes `ii_reference_import_batches` and `ii_benchmark_import_jobs`), so uploads through the new pipeline may not appear in that older panel - unverified without a browser.

Tests run (targeted): `indexCloseReaderEntitlement`, `indiaMfReportIntegration`, `benchmarkDataConsumers` (40 passed), `indiaMfReport` (28 passed). `eslint` clean on the three touched files. `tsc --noEmit`: one error, the pre-existing one above. `git checkout -- scripts/` run.

Admin Standard mapping: no capability added; read-path hardening so the report consumer honours the display/export rights derived from 0241 entitlements. Clauses: section 2 (separately named rights), section 4 (DB layer already enforced; this adds the application layer), section 13 (fail closed). No exception requested.

## 8. Production publication package (PLAN ONLY - nothing executed; production needs separate PO authorisation)

Prerequisite stated plainly: **an approved entitlement for each index (ingest_manual + storage at minimum; calculation + customer_display + report_export for the report header) is MISSING.** It must be evidenced by a real document (owner/provider written terms or licence) reviewed by the PO's own process. A yahoo.com link is not such evidence and the publication gate must not be loosened. Until it exists, steps 6 onward must not run.

1. Verify the database state (PO, read-only): migrations 0232 and 0241 present in `schema_migrations`; `ii_benchmarks` has both keys; capabilities `can_upload_market_index_data`, `can_publish_benchmark_data`, `can_manage_benchmark_catalogue`, `can_approve_benchmark_entitlements` granted to named, separate people (stager and publisher different, otherwise an explicit self-publish acknowledgement is recorded); `ii_reference_job_control` rows disabled; `MARKET_INDEX_FEED_ENABLED` unset.
2. Decide the file: use the **cleaned 2-decimal** copies (the supplied copies hard-fail). Record SHA-256 above, original filenames, source "Yahoo Finance via yfinance", tickers, retrieval time unknown, variant price, INR.
3. Catalogue (own session, `can_manage_benchmark_catalogue`): add owner-evidenced official name/owner/identifier/asset class, evidence reference and date, then verify both records (recommended; not a database gate).
4. Entitlement (separate people): proposal and approval through the existing Benchmark Data Admin workflow, per index, exact variant price / INR, data range, term, post-expiry rules. Not drafted here.
5. Accuracy and calendar sign-off (before publishing): compare first/last, ordinary, volatile and special-session dates against the owner's own published values; settle 2025-02-01 for both exchanges; decide on the Sensex-only/Nifty-only dates in section 1.
6. Stage in Admin (stager): mode new_history, shape single, key, variant price, INR, history class live, date `YYYY-MM-DD`, number format plain. Expected preview if the series are empty: Nifty 4,672 new / 0 identical / 0 conflict; Sensex 6,157 new / 0 / 0; Nifty warnings: 1 weekend row, 3 large moves; Sensex: 4 large moves. If the numbers differ, stop and explain every difference.
7. Publish (publisher, separate session): acknowledge `large_moves` (both) and `weekend_rows` (Nifty), approve against the checksum and staging digest; publication is atomic and re-checks entitlement, conflicts and counts. Each file independently.
8. Verification queries (read-only): count and min/max per key in `ii_benchmark_series` (4,672 / 2007-09-17..2026-10-01 and 6,157 / 2001-10-03..2026-10-01, one row per date, `quality_status='ok'`, `revision_no=1`, `currency_code='INR'`); no rows under any TRI key; `ii_benchmark_import_jobs` status `published` with result counts, an `ii_reference_import_batches` row of kind `benchmark_level`, `ii_benchmark_governance_events` `import_job_published`; spot-compare 10 values to the cleaned file; then generate an India MF report for a test user and check the header shows the 01-10-2026 closes, and "not available" with the entitlement revoked.
9. Idempotency: repeat the same publish request - the RPC returns `already_published`, and a new staging of the same file for the same keys is refused (`23505`); confirm row counts, revisions and audit-event counts unchanged.
10. Rollback: `rollback_benchmark_import` (needs `can_correct_benchmark_data`, reason of 20+ characters) restores revisions rather than deleting; revoking the entitlement hides the series from readers at the database layer without deleting data. Record batch id and job id before and after.
11. Keep daily ingestion disabled; a daily source is configured and approved separately.

PO action items that need a signed-in session or DEV access: steps 1, 3, 4, 6-10, plus a browser run of the Admin UI at desktop and 360px width and a header check in a real report.
