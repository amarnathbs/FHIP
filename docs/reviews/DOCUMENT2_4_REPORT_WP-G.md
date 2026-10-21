# Document2 (4) WP-G report: F15 bank-statement import as a background job (PO-D24-03)

Branch `feat/doc2-4-wp-g-bank-import-job-20261021`, base origin/main `9cce1cf` (contains WP-E). Truth table: `DOCUMENT2_4_TRUTH_WP-G.md`. PO-run SQL pack: `docs/reviews/po_apply_wp_g/`. Migrations: **0310** (job tables, lease functions) and **0311** (unique line index), both additive. Nothing pushed, nothing applied to production, nothing applied to DEV.

Evidence labels: UNIT-TESTED, PGLITE-VERIFIED (real Postgres engine, the repository's whole migration chain), DEV-verified (project vqycarelcoijzwlpkpcz only), **NOT PERFORMED** where stated. Nothing is PRODUCTION-VERIFIED.

## Verdict: F15 / PO-D24-03 = CONDITIONAL

The architecture is built, and proven on a real Postgres engine end to end (CSV 25 / 120 / 500 / 1,500 / 3,000 rows; an AI-read PDF of 120 and 1,500 lines; worker killed mid-run; duplicate admission; repeated polling; retry; browser-less backstop; two-user tenancy). What keeps it CONDITIONAL, stated plainly:

1. **The job has not been run on DEV** (NOT PERFORMED). DEV does not have migration 0310 and no agent has a way to run DDL on DEV. The DEV driver `scripts/doc2_4_wp_g_dev_run.ts` is written, type-checked and refuses to run until 0310 is there. You apply `02` and `03` on DEV, then it is one command per mode.
2. **No browser check of the changed Expenses panel** (NOT PERFORMED; it needs the job tables on DEV).
3. The scheduled backstop cannot fire on DEV (no publicly reachable DEV app origin); on DEV it is exercised by calling the route with the secret.
4. Nothing on production.

## The mechanism, and its honest limits

**Chosen: a durable job table + short lease-guarded slices, driven by the open page and by one scheduled route as a backstop.** No queue, worker, Lambda or EventBridge is required, because none exists on this platform (audit in the truth table).

```
upload (owner first, malware scan, account)            unchanged
POST .../bank-csv|bank-pdf/{id}/process   = ADMISSION  -> 202 + job id (or 200 inline if settled / copy / AI draft waiting)
   |  authenticate, Premium run-start guard (unchanged), malware admission, state, account resolved (else parked, as before),
   |  PDF password attempt rate limit, then create-or-get the statement's ONE job (unique per statement and per user+Idempotency-Key)
POST .../bank-import-jobs/{jobId}/advance  = ONE SLICE (browser poll)   <- also: POST .../bank-import-jobs/cron/advance (backstop)
   |  claim lease (database clock, one winner)  ->  bounded work  ->  checkpoint  ->  release for the next slice
phases:  read -> persist -> finalize                                  (CSV, certified PDF)
         read -> ai_read (parts) -> [person checks] -> plan_confirmed -> persist -> finalize     (PDF read by AI)
```

States: `queued`, `processing`, `review_required` (waiting for a person: AI reading to check, or PDF password), `completed`, `failed`. Dead job = an unfinished job whose lease ran out ("stalled"); the next poll or the backstop claims it and continues. There is no separate janitor.

What makes it correct:
- **Idempotent admission.** `unique(statement_upload_id)` and `unique(user_id, idempotency_key)`. Four admissions at the same moment create one job (PGlite-verified on the real constraints). A finished statement answers 200 inline with the stored result, as before.
- **The plan is frozen at read time.** The read slice parses once (it needs the file, the account dedup index and, for a protected PDF, a password that is never stored), decides every line, and stages the insert-ready rows + the facts finalize needs. Later slices only read the staging, so a killed slice never re-decides anything.
- **Persist writes only what is missing**, recomputed from the database (`source_row` present or not), 250 lines a batch, at least one batch a slice. Migration 0311 adds the database-level rule underneath (a statement cannot hold the same row number twice). Both layers are tested separately: the worker rule alone with the index switched off, and the index alone.
- **Fencing.** Every write to the job row is conditional on the slice's lease token; a slice whose lease was taken over matches nothing and stops.
- **Finalize is the same code as before**: the synchronous import's second half (`finalizeBankCsvImport`, `finalizeBankPdfImport`, the row mappers, the duplicate-candidate writer) was extracted unchanged and both paths call it. It clears what a killed finalize derived (reconciliation, quality checks, provenance, the import's own review items) and carries on from `extracted` / `ready_for_approval`, because the database lifecycle trigger refuses to move a statement backwards (found by the real engine).
- **AI reading in parts.** The masked text is split into parts of 18 lines (whole pages where they fit); each part is one small reading with its own atomic per-user cost reservation (`aie_reserve_ai_cost_v2`, US$1 per user per day) and its own stored result; up to six at once; a part has three tries; Premium, the kill switches and the malware precondition are re-checked **before every step**; masking happens once, fail-closed, on the whole text before any part is cut. A cap hit stops the reading, keeps the parts already read, says so ("try again tomorrow, or upload a CSV"), and a retry reads only the missing parts. The merged draft (opening balance from the first part, closing from the last; "complete" only if every part said it listed every line) goes to the person exactly as the single reading did; the balance rollforward catches a line lost at a part boundary and lands the statement in review instead of certifying it.
- **Real provider timings (DEV-verified, `scripts/doc2_4_wp_g_ai_timing.ts`)**, real gpt-4o-mini, US$ trivial: 10 lines 7 to 9 s, 20 lines 11 s, 28 lines 13.5 s (14.5 s with four at once), 40 lines past the 15 s bound. About 0.45 s a line plus 2.5 s; four parts at once cost no extra wall-clock time. So parts are 18 lines (about 10.5 s) with a 15 s call bound and no transient retries inside a slice (a failed part is retried by a later slice).
- **Short slices.** Work budget 17 s per slice (platform limit 28 s); lease 60 s. Estimated throughput (not measured as a job on DEV): about 90 AI-read lines per slice, so 3,000 lines is about 35 slices (about 8 minutes); CSV 3,000 rows is a handful of slices.

Preserved: owner before upload and account assignment (admission refuses an unresolved account exactly as before); malware admission (at admission and again before parsing); the raw-file lifecycle and strict deletion (unchanged: purge after approval, purge right after an AI confirm, the 50-minute backstop, which now purges but does not reject a statement whose staged plan exists); Premium run-start guard on the process route; the per-user AI cost cap and ledger; idempotency keys (`Idempotency-Key` header, 8 to 120 safe characters).

**Limits (all real):**
- *Browser-open dependence.* Without the scheduled backstop a job advances only while the page is open. A closed page resumes when the Expenses import is opened again (the panel lists unfinished jobs). A job nobody reopens is ended by the 50-minute raw-file backstop for the read phase (the statement is rejected and the file deleted; the person uploads again). The backstop (`05_SCHEDULE`) removes this; you must register it.
- *The read slice cannot be split.* For a certified-layout PDF the native read (up to the existing 20 s extraction timeout) plus staging has to fit in one slice. A password-protected PDF is read once inside the admission request (the password must not outlive it); a very large protected PDF can therefore still hit the 28 s limit, in which case the job asks for the password again.
- *Staging holds temporary content.* The staged plan holds the statement's insert-ready lines (the same rows that become transactions), and an AI reading stages the MASKED page text of each part. Both are deleted when the job completes or fails for good, and swept after 24 hours; the raw file rules are untouched. If you would rather not stage masked text, the alternative is re-extracting the PDF in every slice (slower, and impossible for a protected PDF); this is your call.
- *AIE intake still synchronous.* `app/api/aie/fdh-bank/intake` and `lib/aie/adapters/fdhBankStatement/atomicImport.ts` still call `processBankPdfDocument` (kept, with its WP-E dead-run handling). The Expenses panel does not use that route. The same panel pattern in the liability, retirement and investment statement panels is unchanged.
- Raw PDFs longer than 60 pages are refused by the existing page limit; 3,000 lines needs about 55 dense pages.

## Tests (96 new, all passing; tsc: only the two known errors)

| File | Tests | Evidence | What |
|---|---|---|---|
| `doc2_4_wpG_bankImportJobsPglite.test.ts` | 16 | PGLITE-VERIFIED | 0310 / 0311 on a real engine: one claim winner, take-over counted, finished jobs never claimed, claim_next, browser roles cannot call the functions, one job per statement / key, two-user RLS (own jobs read-only, staging invisible, cross-tenant trigger), unique line index; 2 negative controls |
| `doc2_4_wpG_bankImportPgliteEndToEnd.test.ts` | 15 | PGLITE-VERIFIED | The worker against the real schema: CSV 25 / 120 / 500 / 1,500 / 3,000 exact counts and certified; duplicate admission x4; 3 concurrent polls (1 advanced, 2 busy); killed after a batch before the checkpoint; the unique index as the net; killed mid-finalize; retry; backstop; tenancy; AI reading 120 and 1,500 lines through confirm to exact lines, reconciled |
| `doc2_4_wpG_bankImportWorker.test.ts` | 28 | UNIT-TESTED | Same scenarios on the in-memory database: admission rules (owner/account, malware, other user), scale, kill points (checkpoint, staging, finalize, after finalize), thrown slices (3 in a row fail the job and clear partial lines), retry, lease fencing, backstop, reaper must not touch a job statement |
| `doc2_4_wpG_aiParts.test.ts` | 12 | UNIT-TESTED | Splitting (every line once, in order), merging, 120 and 3,000 lines through confirm, kill with no part read twice, failed part retried alone, daily cap keeps the parts and a retry reads only the missing ones, lapsed Premium stops the next step, Free refusal, confirm idempotency, tenancy |
| `doc2_4_wpG_routesAndDriver.test.ts` | 18 | UNIT-TESTED | Every job route with two users (list, read, advance: 404 non-enumerating, no lease token in any answer), 401 signed out, backstop secret, 202 contract of the process routes, 503 without 0310, job model, browser driver |
| `doc2_4_wpG_poPack.test.ts` | 7 | PGLITE-VERIFIED | The pack: apply files byte-equal to the migrations, SQL-editor safety rules (and the lint bites), no secrets, every read-only block runs and returns what it promises, the schedule registers, rollback then re-apply restores the exact shape |

**Negative controls** (`node scripts/doc2_4_wp_g_negative_controls.mjs`: removes one guard at a time, runs the suite, restores the source; exits non-zero if a control stays green). All six went red with a named test: persist without the "only what is missing" rule; finalize without clearing derived rows; fencing removed; the dead-run reaper no longer sparing job statements; the read phase not clearing an earlier attempt; a failed job not removing its partial lines. The first run found two controls that stayed green (the unique index masked the persist rule; no test had debris) and the tests were strengthened until each control bit.

**Defects the real engine found** (the in-memory fake could not): the lifecycle trigger refuses `failed -> processing` (retry now goes `failed -> queued -> processing`) and backward moves (a killed finalize now resumes from `extracted` / `ready_for_approval`); and the SQL-editor safety rules (tagged dollar quotes, no percent or double quotes, clean comments) which an existing repository test applies to every migration from 0270 and which the first draft of 0310 broke.

Existing suites adapted (their contract moved to the job, assertions kept): `doc2_4_wpE_interruptedRun` (the stable codes now come through admission), `aieStatementDraftConfirmRoundTrip` (confirm answers 202), `premiumAiGuardCoverage` and `fdh1Isolation` (the worker is listed with its reason). Related-suite run (`fdh aie bank premium statement upload import expenses lr3 canonical ...`): 277 files and 5,287 tests pass; 2 tests fail and **both fail identically on origin/main**: `resourcesBulkImportMigration` (migration 0285 breaks the SQL-editor rules) and `lr1UploadSecurityRawFileLifecycle` (purge.ts logs with console.error); 10 files failed to load from temp-file races or a missing `.env.local` and pass or fail identically in isolation (4 re-run: 3 pass, `resourcesBulkImportSecurity` needs `.env.local`). `git checkout -- scripts/` run afterwards.

## What changed (files)

New: `supabase/migrations/0310_*`, `0311_*`; `lib/financial-data-hub/dbContext.ts` (AsyncLocalStorage so the same repositories run under the service role inside a slice and unchanged otherwise); `lib/financial-data-hub/bankImport/{jobModel,planStaging,aiChunking,processResponse,routeHelpers}.ts`; `lib/financial-data-hub/services/{bankImportJobStore,bankImportWorker,bankImportAdmission}.ts`; routes `app/api/financial-data-hub/bank-import-jobs/{route, [jobId]/route, [jobId]/advance/route, cron/advance/route}.ts`; `components/expenses/bankImportJobDriver.ts`; scripts and tests above.
Changed (behaviour-preserving unless stated): both bank services (finalize, row mappers and duplicate-candidate writer extracted and shared; documents-in-`processing` of a job are not reaped as dead runs); the two process routes (admit, 202); the AI confirm route (queues the job; row ceiling 5,000 as the importer's); the Expenses panel (follows the job, resumes after a refresh, progress bar); `purge.ts` (the 50-minute backstop knows a staged plan); AI plumbing, additive and defaulted: per-call timeout and retry bound, the egress preconditions exposed, PDF pages kept next to the text in memory; `DEPLOYMENT.md` (backstop section).

## What you must do

1. **DEV:** run `po_apply_wp_g/01` (read only), `02`, `03`, `04` (read only) on DEV and tell me; then run the DEV driver (modes `scale`, `ai`, `robust`). Nothing else needs configuring on DEV.
2. **Production, in this order:** deploy only **after** `02` and `03` are applied there (until then the process routes answer 503 "not available yet", because the old synchronous reading is gone from the routes). Run `01`, `02`, `03`, `04`; deploy; then `05` (the schedule) and `07` to watch. No manual table backup is needed for `02` / `03` (empty tables and one index; no row changes). Rollback is `06`.
3. **Configuration:** none in Amplify (CRON_SECRET is already forwarded); the Vault secret name used by `05` is the one the purge sweep already uses. Decide whether masked staging text is acceptable (see limits).
4. **Still open from WP-E:** run its read-only pack `docs/reviews/po_apply_wp_e/01_READ_ONLY_find_the_failed_bank_import.sql` on production to confirm which stage your own failed upload stopped at; this design addresses the verified failure class (the request timeout) but your file is not proven to have taken the AI path until you do.
