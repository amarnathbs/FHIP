# BENCH-1 Phase 2 - Operator runbook (Benchmark Data)

Audience: the Product Owner and any administrator granted a benchmark capability. Surface: **Admin > Benchmark Data** (`/admin/investment-intelligence/market-index-data`, alias `/admin/investment-intelligence/benchmark-data`). Everything below is code-complete and PGlite-verified; none of it has been run against DEV or production (see the main report for evidence labels).

## 1. Who can do what (six separately named capabilities)

| Capability (admin_users column) | Can | Cannot |
|---|---|---|
| View (PC6 `can_view_reference_data_quality`, or any capability below) | See overview, jobs, previews, errors, templates, help | Anything that changes data |
| Upload (`can_upload_market_index_data`) | Stage + validate a file; cancel own job | Publish, correct, approve |
| Publish (`can_publish_benchmark_data`) | Approve + publish NEW history | Publish corrections, roll back, stage |
| Correct (`can_correct_benchmark_data`) | Publish CORRECTIONS; roll back an import | Publish new history, stage |
| Catalogue (`can_manage_benchmark_catalogue`) | Catalogue entries, mapping proposals/review, DRAFT entitlements, ingestion mode | Approve an entitlement, publish |
| Entitlement approver (`can_approve_benchmark_entitlements`) | Approve / revoke entitlements | Propose one |

Capabilities are granted ONE ADMIN AT A TIME by the Product Owner (`update admin_users set <column> = true where user_id = '<uuid>'`); migration 0241 grants nobody anything. The same administrator may hold several, but staging and publishing by the same person needs an explicit self-publish acknowledgement and is recorded (`self_published`).

## 2. The order of work for a new benchmark (nothing publishes out of order)

1. **Catalogue entry** (Catalogue tab): exact official name, owner, variant (price / total return / net total return), currency, asset class, base/launch/history-start dates only where verified on the owner page, evidence reference + retrieval date. It is a DRAFT until a catalogue admin **verifies** it (all evidence fields are required by a database CHECK). Editing a verified entry returns it to draft; its variant can never change (create a new key instead).
2. **Entitlement record** (Entitlements tab): what FHIP may DO with this series, right by right - manual ingest, automation, storage, calculation, customer display, report/export - with the data-date scope, the term, and what happens after expiry (retain / delete / unknown). A public-use permission needs a document URL, the document date and the retrieval date; a commercial licence needs a contract reference. An entitlement approver approves it. **A file upload does not establish permission, and neither does the coarse `licence_status` label**; with no approved record every right is false.
3. **Upload** (Upload tab): see section 3.
4. **Mapping** (Mappings tab): propose each held scheme's declared benchmark with the scheme document as evidence; a catalogue admin approves. A benchmark CHANGE is a new effective-dated row; approve with "close the previous mapping" - history keeps its meaning. Overlapping PRIMARY mappings are refused by the database.
5. Consumers (Performance, SIP Intelligence, Overview, X-Ray, Holdings, reports) pick the data up automatically: engine inputs are content-addressed, so new or corrected levels change the input fingerprint and results recompute. A benchmark without calculation + display entitlement shows an honest "no entitlement" state, never 0%.

## 3. Upload a history file

1. Choose the shape: **single** (`date,value`), **multi-benchmark** (`benchmark_key,date,value`) or a **recognised provider export** (e.g. `Date, Total Returns Index`). Arbitrary columns are never inferred - choose them explicitly.
2. Choose the existing benchmark(s); the form shows the catalogue's variant and currency and they must match your selections.
3. Fill in source owner and the original source URL or delivery reference; select the entitlement record; choose history class (live / backtested); a correction needs the correction capability and a reason of at least 20 characters.
4. Choose the date format explicitly (DD/MM vs MM/DD is never guessed) and the number locale. For XLSX, **choose the sheet**; formula cells in the date/value/key columns are rejected; hidden rows and other sheets are disclosed.
5. **Preview** shows: earliest/latest date, total/valid/invalid rows with row numbers and reasons, identical rows that will be skipped, new rows, proposed corrections with before/after, gaps and warnings, per-benchmark eligibility, and the exact publication scope. Download the validation errors as CSV (formula-injection safe).
6. Hard errors block publication - there is **no partial publish**. Warnings that need review (large moves, weekend rows, suspected rebasing, coverage gaps, hidden rows included) must be ticked explicitly. Large real moves are flagged, never rejected; missing dates are never filled or interpolated.
7. A publisher confirms. The server re-checks capability, entitlement (revocation/expiry/scope), file checksum, staging digest, previewed counts and the current series; it then publishes **atomically** (all rows or none). The same file cannot be published twice. If the series changed since the preview you get "stale - upload again".
8. **Corrections** keep the old level as a revision (`ii_reference_corrections` holds before/after, actor and reason). **Rollback** (correction capability, reason >= 20 characters) restores the previous levels or retracts the rows (soft: nothing is deleted); it refuses if a later import already revised those rows.

Limits (configurable): 5 MB, 20,000 rows, XLSX zip-bomb limits (entries, uncompressed size, compression ratio). Not accepted: PDF factsheets as daily data, XLSM/macros, encrypted files, non-UTF-8 text.

Retention: the raw uploaded file is **never stored**; only its SHA-256, size, name and the normalised validated rows. Unpublished staging expires after 14 days; staged copies for published jobs are purged after 90 days (`expire_benchmark_import_jobs()`, service role); the canonical rows and before/after evidence remain. Do not commit licensed data to the repository.

## 4. Manual-import mode and the pending-import task

Every benchmark starts as **manual import** (set per benchmark on the Ingestion tab, reason required). The overview lists a **pending-import task** per benchmark whose latest stored level is behind the expected latest session (publication lag, weekday-snapped; no exchange-holiday calendar is shipped, so up to 3 missing weekdays are tolerated as possible holidays and disclosed): `due` (behind), `overdue` (more than 3 weekdays behind), `never imported`, or history missing at the start. The task text always says "upload" and "nothing updates automatically" - a manual upload is never described as an automatic update.

## 5. Recurring ingestion (OFF)

Gates, all of which must hold per run, each failing closed: (1) route secret `x-cron-secret`; (2) `BENCHMARK_INGESTION_ENABLED=true` in the environment; (3) `BENCHMARK_INGESTION_PROJECT_REF` equal to the connected Supabase project ref (a DEV job cannot write production and vice versa); (4) global kill switch (`ii_reference_job_control.benchmark_ingestion_global`); (5) benchmark mode `automated` and `automation_enabled`; (6) an approved, in-term **automation + storage** entitlement; (7) not inside a backoff window; (8) the single-flight lease (10-minute TTL, expires if a runner dies); (9) write kill switch (`benchmark_ingestion_write`) - OFF means a dry run that writes nothing. Both switches and the environment flag ship OFF, **no pg_cron schedule exists**, and the adapter registry is empty. Do not create a schedule until a source's automation right is approved in writing.

Run kinds (`?run_kind=`): `daily` (after expected EOD publication; re-fetches the last 5 sessions to SEE corrections - differences are reported as conflicts, never silently applied), `late_retry` (bounded to 3 per day), `weekly_gap` (first gap run), `monthly_reconcile` (35-day lookback), `history_expansion` (newest-first chunks of at most 366 days toward the demand floor), `demand_refresh` (recomputes the global selective-history demand). Four values are recorded independently per benchmark: `last_attempt_at` (every attempt), `last_successful_run_at` (success only), `latest_valid_data_date` (from the stored series), `completeness_watermark` (gap-tolerant, never beyond the latest valid date). **HTTP 200 with none of the expected data is not success**; a run with no new rows is successful only if coverage is independently already complete. A 401/403/captcha/HTML page stops the run (one request, no retry, no route-around).

## 6. Disable / rollback

* Stop an administrator: set their capability column to false.
* Stop automation: leave the switches OFF (default) or set them off; set a benchmark to `manual_import`/`disabled`.
* Withdraw data rights: revoke the entitlement - ordinary readers lose the series immediately (row-level security), staged jobs are refused at publication.
* Undo a publish: Jobs > Rollback (correction capability).
* Undo the migration: `scripts/bench1_phase2_po_apply_0241.sql` rollback block (drops only 0241 objects; does not touch 0232).

## 7. Known limitations (honest)

No exchange holiday calendar; gap tolerance is a rule of thumb. XLSX reading is a purpose-built strict reader (no `xlsx` package, which is unmaintained on npm with known CVEs); the provider-export header sets are from public conventions and are **not verified against a live download**. Composite and non-index benchmarks (e.g. SBI Multi Asset; "domestic gold price") are not representable as one series and are shown unsupported. Date-range entitlement scope is enforced in the application read layer and at publication; the database row-level gate is benchmark-level.
