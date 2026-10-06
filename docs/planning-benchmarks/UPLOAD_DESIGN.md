# Planning Benchmarks - staged upload: design (F5)

Prepared 06/10/2026 on branch `fix/po-review-resources-data-20261006`. Admin Architecture Standard v1.0 (`docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md`) and `AGENTS.md` were read in full before this design.

Evidence labels used in this file: **code-complete**, **unit-tested**, **PGlite-verified** (an isolated in-memory Postgres replaying the real migrations), **DEV-verified**, **DEV-browser-verified**. Nothing in this work is DEV-verified: migration `0275` has not been applied anywhere and waits on the Product Owner (section 12).

---

## 1. The finding and the question it raises

PO finding F5: "There is no upload option to update this information anywhere in the app". True today: `/admin/benchmarks` has read-only tabs plus Validate / Activate / Retire, the insert routes (`POST /api/admin/benchmarks/{sources,datasets,cohorts,values,target-ranges}`) are called by no screen, there is no update or delete route, and `values` / `target-ranges` have no unique key (schema document `IMPORT_SCHEMA_AND_PARAMETER_MAP_2026-10-03.md` sections 2 and 2.5). The written answer on cadence and feeds is `REFRESH_CADENCE_AND_FEEDS.md` (recommendation: manual, staged, authorised uploads; no value-writing feed). This design builds the upload that answer assumes.

The critical fact that shapes everything: **a benchmark value is live for the Financial Twin the moment it is inserted.** `lib/services/twinBenchmarkRetrieval.ts` reads `benchmark_values` and `benchmark_target_ranges` without looking at dataset status or at `effective_to`, and keeps one row per statistic (last row wins). So a naive "upload inserts rows" would (a) publish unreviewed numbers to every household and (b) make a refreshed figure undetermined next to the old one.

## 2. Options considered

| Option | What it is | Verdict |
|---|---|---|
| A. Direct insert | A file upload that calls the existing insert routes | Rejected. Live on insert, no preview, no review, no audit, duplicates on a second click, no supersede. Exactly the hazard in section 1. |
| B. Stage, preview, explicit Activate (recommended) | Rows land in staging tables owned by the upload; a preview shows a diff against the live values; a separately authorised Activate copies them live in one database transaction and end-dates what they replace | **Chosen.** Same shape the repo already uses for Market Index Data (stage, validate, approve, publish), so reviewers and tests are familiar. |
| C. Replace-in-place (delete old rows, insert new) | Keep the live tables free of history by deleting superseded rows | Rejected. `financial_twin_metric_results.benchmark_value_id` (and `target_range_id`) point at the live rows from immutable Twin run history (migration 0011); deleting would either fail on the foreign key or erase evidence. History must stay. |
| D. Automated feed | A scheduled job pulls numbers from publishers | Rejected here, per `REFRESH_CADENCE_AND_FEEDS.md` section 6 (almost all sources are spreadsheets or PDFs, licence questions open, and wrong figures would reach households). |

## 3. Recommendation: stage then activate

```
file -> inspect (shared ingest library) -> parse -> validate -> STAGE (staging tables, nothing live)
     -> preview: counts + diff against live values -> [discard]  or  [Activate, confirmation dialog]
Activate (one transaction, one SECURITY DEFINER RPC):
     re-check authorisation, digest, freshness, dataset + source readiness, conflicts
     -> end-date superseded live rows (effective_to) -> insert new rows -> activate the dataset
     -> audit rows -> mark the batch activated
```

### 3.1 Reuse (nothing re-invented)

| Concern | Reused from |
|---|---|
| File safety: extension and content sniffing, size, ZIP and XML limits, macro refusal, UTF-8/UTF-16 decoding | `lib/services/investment-intelligence/benchmarkData/fileIngest` (`inspectUpload`, `parseCsvText`, `listWorkbookSheets`, `readWorksheet`, `csvToTable`, `xlsxToTable`) - the same inspector Market Index Data uses |
| Explicit sheet choice, header row 1, formula cells rejected, hidden rows disclosed | the same library (`readUploadToTable` rules; the sheet is never chosen for the operator) |
| Formula-injection neutralising for every generated cell | `neutraliseCsvCell` from the same library |
| Admin route envelope, error mapping, never forwarding raw database text | `adminRoute`, `safeDbError`, `bad`, `ok` (`lib/services/adminAuth.ts`, `lib/api`) and the Wave 5 result-state helpers used by this page (`lib/resources/admin/resultState`) |
| Capability mechanism | the `admin_users.can_*` column + `is_*()` predicate + guard pattern of migrations 0232 / 0241 and `benchmarkData/guards.ts` |
| Atomic RPC + immutable audit pattern | `admin_transition_benchmark_source` (0125) and `publish_benchmark_import` (0241) |
| Activation readiness rules | `validateDatasetForActivation` (`lib/services/benchmarkGovernance.ts`): re-expressed once in SQL (single authority at Activate) with a test that pins every rule and message to the TypeScript original |
| Natural-key CSV contract, units rule, provenance fields | `scripts/planning-benchmarks/*` and `docs/planning-benchmarks/first_load/*` (a converter script turns those files into upload files) |

New code is limited to what no existing library covers: the benchmark-specific column schema, the diff, the three staging tables, the RPCs, the routes and the screen.

## 4. What an upload may contain

One file = one kind, one target dataset. Three kinds, one template each (CSV and XLSX, both produced from the single schema in `lib/planning-benchmarks/uploadSchema.ts`):

| Kind | Writes to | Natural key | Supersede rule |
|---|---|---|---|
| `values` | `benchmark_values` | metric + cohort (blank = country-wide) + statistic type | a live row for the same key held by the same dataset name (any version) is end-dated when the figure differs, left alone when identical |
| `target_ranges` | `benchmark_target_ranges` | metric + country + life stage + household type + band tier | the group (metric + country + life stage + household type) is replaced as a set: changed or missing tiers are end-dated, identical tiers are left alone |
| `cohorts` | `benchmark_cohorts` | cohort code (already unique) | new cohorts are inserted, identical ones skipped, a cohort whose attributes differ is a **blocking conflict** (cohorts have no update route and no effective dates) |

Out of scope, by design (Standard s14): creating sources, datasets or metric definitions (they stay on the existing screens and routes; an upload names an existing dataset by name and version), editing or deleting anything, and any automated feed.

Template rules (all from one schema): header on row 1, the first column is `template_version` (the version marker, a value such as `FHIP-PB-VALUES-1`, checked on every row so a template from a different generation is refused), required and optional columns declared once with type, closed enum and a plain-language description, `unit` must equal the metric's unit, closed enums for statistic type, direction and evidence level, dates written year-first with dashes inside the file (the one place the app uses that order, because it is the database order; day-first `dd/mm/yyyy` and `dd-mm-yyyy` are also accepted and an Excel date cell is accepted), numbers are plain (no thousands separators, percent points not fractions), provenance columns (release, observation period, source file, source locator, retrieval date) are required for values so every live figure can be traced. The template's example rows name a dataset that does not exist, so an unedited template can never stage.

All user-visible text (page copy, help, messages, previews, history) is day-first (`dd/mm/yyyy`); no year-first date is ever shown to a person.

## 5. Security and capability model (Standard s2, s3, s4, s5, s13)

Two new, separately named capabilities, backed by two new `admin_users` columns (default false, never granted by the migration):

| Capability (UI flag) | Column | Authorises |
|---|---|---|
| `planningBenchmarkUpload` | `can_upload_planning_benchmarks` | download templates, stage a file, view previews and history, discard a batch **it staged** |
| `planningBenchmarkActivate` | `can_activate_planning_benchmarks` | Activate a staged batch, discard any staged batch |

Neither implies the other, neither is implied by Super Admin (`admin_users` row existence), by the Market Index capabilities or by anything else (s2, s3). Read access to the Upload area and the history is the union of the two (read only, like the Market Index `view`). Separation of duties (s5): the person who staged a batch may activate it only if they also hold the activate capability **and** tick an explicit self-activation acknowledgement, which is recorded on the batch (`self_activated`). Whether to grant both to one person is a Product Owner decision.

Four layers, each enforced independently:

1. **Database**: RLS on the three new tables (read for holders only, no insert / update / delete / truncate for `anon` or `authenticated`); every write is through a `SECURITY DEFINER` RPC that checks `auth.uid()` and the capability itself, has a pinned empty `search_path`, schema-qualified references, `EXECUTE` revoked from `PUBLIC` and `anon`, an explicit exception for an unauthorised caller (never an empty result). The two predicates are `is_planning_benchmark_uploader()` and `is_planning_benchmark_activator()`.
2. **API**: every route calls `requireAdmin()` (Super Admin row, country gate, 401 / 403) **and then** the named capability guard, on every verb, before reading the body. Routes run under the caller's own session client; the service-role client is not imported by any upload route (static test).
3. **Page**: `/admin/benchmarks/upload` redirects a caller without a capability; the Upload tab on `/admin/benchmarks` shows an explicit "you do not hold this permission" state, never an empty form.
4. **Navigation / UI**: the Upload tab and the Activate button are shown from `/api/admin/me` flags (`planningBenchmarkUpload`, `planningBenchmarkActivate`). UX only; layers 1 to 3 are the control.

Fail closed (s13): a role-resolution error, a missing column (migration not applied), a malformed body, an unknown enum or an unexpected RPC reply is an explicit error (a missing column is a 503 "not available", distinguishable from the 403 for a missing permission), never a default grant, an empty success or a partial write.

Data boundary (s9, s11): the tables hold global reference data only, no user data. The template download is static (no stored data is read), server-generated, formula-injection safe (every cell passes `neutraliseCsvCell`; a test asserts no generated cell can start a formula), with a non-identifying file name. No export of stored data is added.

## 6. State machine (one batch)

```
            stage ok                      Activate (all checks pass)
(no batch) ---------> STAGED ------------------------------------------> ACTIVATED   (terminal)
                         |  \
                         |   \ 14 days pass: shown as expired, Activate refused, may still be discarded
                         |    
                         +------ Discard (reason optional) ------------> DISCARDED   (terminal)
```

Idempotency and duplicate protection:

- Staging the same file (SHA-256 of the bytes + kind + dataset) while a batch for it is still STAGED returns that batch (no second batch).
- Staging a file whose hash was already ACTIVATED for that dataset is refused with the original batch and date (a partial unique index on `(file_sha256, kind, dataset_id) where status = 'activated'` is the database backstop).
- Activating an already activated batch returns the stored result and writes nothing (row lock then status check). Two simultaneous Activates serialise on the batch row and on a transaction-level advisory lock that also serialises any two activations, so two batches cannot end-date and insert the same key twice.
- Activate is bound to what the reviewer saw: it carries the SHA-256, the staging digest and the previewed counts; the RPC recomputes the digest from the **current** live tables and refuses with "stale" if live data changed since staging (re-stage to continue).

## 7. Tables (migration `0275`)

| Table | Purpose |
|---|---|
| `benchmark_upload_batches` | one row per staged file: kind, target dataset (id, name, version), file name, SHA-256, size, template version, status, counts, preview summary, staging digest, who staged and when, who activated and when, `self_activated`, who discarded and why, result, link to the `benchmark_update_runs` audit row, `expires_at` |
| `benchmark_upload_rows` | the validated rows of a batch with resolved ids, the classification (`new`, `changed`, `unchanged`, `conflict`) and the live row ids they would supersede; kept after activation as the audit trail (the raw file is never stored) |
| `benchmark_upload_events` | append-only event log (`staged`, `activated`, `discarded`) with the actor; update and delete are blocked by trigger (same discipline as `benchmark_update_runs`, 0125) |

No existing table is altered, no shared CHECK constraint is dropped or widened (the repo's drop-and-recreate hazard is therefore not in play; the `benchmark_update_runs.event_type` check is left untouched and the existing value `DATASET_IMPORT` is reused for the activation audit row). No unique key is added to the live tables: that would fail on any DEV or production duplicates left by earlier loads, so duplicate protection is by classification plus the advisory lock instead (Decision U6).

## 8. RPC list (all `SECURITY DEFINER`, caller's own session)

| RPC | Capability | What it does |
|---|---|---|
| `stage_planning_benchmark_upload(p jsonb)` | upload | validates the rows again in the database, resolves natural keys to ids, classifies each row against live data, writes batch + rows + event atomically, returns the batch id and counts |
| `get_planning_benchmark_upload(p_batch uuid)` | upload or activate | returns the batch header, readiness errors (the dataset and source rules), blockers and the diff rows including live bands that would be removed |
| `activate_planning_benchmark_upload(p_batch uuid, p jsonb)` | activate | the atomic apply described in section 3 |
| `discard_planning_benchmark_upload(p_batch uuid, p_reason text)` | upload (own batch) or activate | marks the batch discarded |
| `is_planning_benchmark_uploader()`, `is_planning_benchmark_activator()` | n/a | the two capability predicates (also used by RLS) |

Activate's rule set (all inside the one transaction): capability; batch is STAGED and not expired; digest and counts match; recomputed classification matches the digest; no `conflict` row; the dataset exists and is not suspended, archived or superseded; the dataset's source is approved or active and has a citation and a period; the dataset has a source period, geography level and statistic coverage (the rules of `validateDatasetForActivation`, with the "at least one value" rule satisfied by the staged rows themselves, which is what lets a first load activate); every row's unit equals its metric's unit; values never create a second live row for a key held by a different dataset name (blocking conflict); self-activation needs the acknowledgement.

Effects: superseded live rows get `effective_to = current_date`; new rows get `effective_from` = the file's value or today (never in the future), `version` = previous version + 1 for a replacement, and `value_text` = a composed provenance string (release, observation period, source file and locator, retrieval date - the same disclosed use of `value_text` as the first load, because the live table has no provenance columns); the dataset becomes `active` if it was not (with `approved_by`, `approved_at`, `effective_from` and a review date one year ahead, as the existing Activate route does) and older versions of the same dataset name left with no live values are marked `superseded`; one `benchmark_update_runs` row (`DATASET_IMPORT`, approved, rows imported, batch id and counts in `validation_results`) so the existing "Update / audit log" tab shows it; one event row; the batch becomes ACTIVATED with its result.

## 9. The Twin read path: is a consumer filter needed? **Yes.**

Superseding by end-dating (`effective_to`) is only safe if the reader respects it, and `loadPeerBenchmark` / `loadHealthyRange` do not (schema document s2.5, P3). Deleting instead is impossible (option C, foreign keys from immutable Twin history). Therefore the smallest consumer filter is **included**: both queries gain one predicate, "no end date, or an end date after today" (`.or('effective_to.is.null,effective_to.gt.<today>')`).

Blast radius, stated plainly: this touches a **live Financial Twin read path**. For every row that exists today the filter changes nothing (no existing row has an `effective_to`; the routes and seed never set one). It only starts to exclude rows that the new Activate end-dates. I deliberately did **not** add the other P3 predicates: filtering on dataset status would blank every currently served figure whose dataset is still `draft` or `under_review` on DEV or production (today those figures are served regardless of status), and an `effective_from <= today` filter is replaced by a rule in validation (an upload may not carry a future start date). Deployment order matters: ship the filter before the first Activate that supersedes anything, otherwise an end-dated row would still be served beside its replacement. The tests include a negative control proving the unfiltered query would return the superseded row.

## 10. Test plan (what proves what)

| Layer | Proof | File |
|---|---|---|
| Schema / template | one schema drives CSV and XLSX; header row 1; version marker; XLSX round-trips through the repo's own reader; no generated cell starts a formula; unedited template cannot stage | `tests/unit/planningBenchmarkUploadSchema.test.ts` |
| Parse + validate | unit equals metric unit, closed enums, dates, numbers, required columns, duplicate keys, version marker, formula cells in XLSX, explicit sheet choice; first-load files convert and validate | `tests/unit/planningBenchmarkUploadValidation.test.ts` |
| Database (PGlite, real ledger replay) | capability gates for all four layers' database part (non-holder, admin without capability, anon, service role), staging classification, supersede, atomicity (a failure mid-apply leaves nothing), idempotency, stale digest, self-activation ack, dataset and source readiness, conflicts, append-only events, RLS | `tests/unit/planningBenchmarkUploadPglite.test.ts` |
| Migration hygiene | hand-run SQL is editor-safe; parts equal the migration; contract of tables, functions, capability columns | `tests/unit/planningBenchmarkUploadMigration.test.ts` |
| Routes | 401 / 403 / 503 / 422 / 413, direct API on every verb, capability separation (upload cannot activate), service-role client never imported, no raw database text | `tests/unit/planningBenchmarkUploadRoutes.test.ts` |
| Page + nav | direct-URL redirect, capability flags parse fail-closed, nav registry | `tests/unit/planningBenchmarkUploadPage.test.ts` |
| Consumer filter | superseded rows are not served; negative control | `tests/unit/twinBenchmarkRetrievalFilter.test.ts` |
| UI | day-first text only, confirmation wording, states | `tests/unit/planningBenchmarkUploadUi.test.ts` |

Every named negative control demonstrably fails something (the failure is named in the test title); see the report.

## 11. Trade-offs and known limits

- A refused Activate is returned to the caller but not logged as an event (the RPC raises, so its own transaction rolls back). The existing dataset Activate route logs rejected attempts from the route using the service-role client; the upload routes deliberately do not use that client. Recorded as a limitation, not hidden.
- Rejected files (validation failures) are not persisted, so there is no downloadable error CSV; the preview lists up to 200 issues with row numbers. Staged batches are the only persisted artefact.
- The raw uploaded file is never stored, only its hash and the validated rows.
- Staged batches expire after 14 days for Activate; there is no scheduled sweeper in v1 (expired batches stay visible as "expired" and can be discarded).
- The upload cannot create a dataset, source or metric definition; a new dataset version is still created with the existing `POST datasets` route (no screen yet). Proposals P2/P4/P5 of the schema document remain open.

## 12. Decisions (decided by the PO 07-10-2026: "go with your recommendations")

All seven are accepted as recommended. The code was checked against each on the integration branch `integrate/po-review-and-owner-fixes-20261007`.

- **U1 DECIDED.** `can_upload_planning_benchmarks` goes to the Benchmarks owner and `can_activate_planning_benchmarks` to a different named person. One person may hold both only with the recorded self-activation acknowledgement. Code: `activate_planning_benchmark_upload` refuses a self-activation without `self_activation_ack` (`PB_E_SELF`) and records `self_activated` on the batch and in the append-only event (PGlite-tested).
- **U2 DECIDED.** The consumer filter in the live Twin read path (section 9) is approved. **It must be deployed before the first Activate**, because the first Activate that supersedes a figure is what gives a row an `effective_to`. Code: `lib/services/twinBenchmarkRetrieval.ts`, tests `twinBenchmarkRetrievalFilter.test.ts`.
- **U3 DECIDED.** A successful Activate also activates the target dataset. Code matches: the RPC sets `data_status = 'active'` (keeping an earlier effective date and approver) and the result carries `dataset_status: 'active'` (PGlite test "a first load becomes live in one step, activates the dataset").
- **U4 DECIDED.** Day-first dates (`dd/mm/yyyy`, `dd-mm-yyyy`) are accepted in uploaded files, in addition to the database order and a real Excel date cell; month-first and two-digit years are refused. Code: `lib/planning-benchmarks/dates.ts` (`parseFileDateText`), test "parses day-first and database-order text, refuses month-first and two-digit years".
- **U5 DECIDED.** Band-set replacement: a tier missing from the new file is end-dated, shown in the preview and counted as `bands_removed`. Code: `pb_removed_band_ids` and the Activate update; PGlite test "replacing the set ... an unrestated tier removed".
- **U6 DECIDED.** No unique key on the live tables for now. Migration 0275 adds none; duplicate protection is by classification and the advisory lock.
- **U7 DECIDED (PO action).** Apply migration `0275` on DEV first (hand-over `docs/planning-benchmarks/po_apply_upload/`), then grant the capabilities, then the DEV certification can run.

---

## 13. Allowed values on the templates and the screen (PO request 07/10/2026)

The XLSX Read me sheet, a companion "Allowed values (CSV)" download and a collapsible panel on the Upload tab (Columns, Allowed datasets and metrics, Cohorts) all print the live lists read by `lib/planning-benchmarks/allowedValues.ts`, the same module the validator uses. The preview check also refuses a dataset that is not open for upload, an unlisted metric or cohort, and a target-range source that is not the dataset's own, naming the allowed values. Full account, counts and evidence: `TEMPLATE_ALLOWED_VALUES_REPORT.md`.
