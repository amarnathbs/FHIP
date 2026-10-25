# Document2 (4) WP-J report: large statement processing and reprocessing as a background job

Branch `feat/doc2-4-wp-j-statement-reprocess-job-20261022`, based on the WP-G tip `2eb3793` (which contains origin/main `5c9fa63`), then origin/main merged in twice, last at `46e79d5` (WP-H2 scan fix with the password decrypted in memory, WP-B2, WP-H3 null-reference dedup). Truth table: `DOCUMENT2_4_TRUTH_WP-J.md`. PO-run SQL pack: `docs/reviews/po_apply_wp_j/`. Migrations: **0312** (parse-run counters, columns only) and **0313** (job tables and lease functions), both additive. Nothing pushed, nothing applied to production, **nothing applied to DEV**.

Evidence labels: UNIT-TESTED, PGLITE-VERIFIED (real Postgres engine, the repository's whole migration chain), DEV-verified (project `vqycarelcoijzwlpkpcz` only, services called with a synthetic passwordless user, zero residue), **NOT PERFORMED** where stated. Nothing is PRODUCTION-VERIFIED.

## Verdict: CONDITIONAL

The mechanism is built and proven on a real Postgres engine for 25, 200 and 1,000 positions, for replays, for slices killed at 14 named points, for the WP-H3 aged-row re-read, and for tenancy. It stays CONDITIONAL, stated plainly:

1. **The job itself has not run on DEV (NOT PERFORMED).** DEV does not have 0312 or 0313, and no agent can run DDL there. The DEV driver `tests/live-dev/iiWpjJobLiveDev.test.ts` is written, type-checked and, run today, reports `NOT PERFORMED: migrations 0312 / 0313 are not applied on DEV` (evidence file `docs/reviews/evidence_wp_j/dev_job_wpjjob-1792931748287.json`). After you apply `02` and `03` on DEV it is one command.
2. **No browser click-through** of the changed Statements & data list, replacement control and Review centre (NOT PERFORMED; it needs the job tables on DEV). The wiring is pinned by tests against the source and the loop by pure driver tests.
3. **The profile is DEV, not production.** The DEV round trip is 157 to 403 ms (the app talking to DEV from a laptop); production is closer to its database. The request counts and the step shares transfer; the seconds do not.
4. The scheduled backstop cannot fire on DEV (no publicly reachable DEV app origin).

## Task 0: where the time goes (DEV, real PDFs, real Storage, timeline of every request)

Harness: `tests/live-dev/iiWpjProfileLiveDev.test.ts`, fixture builder `tests/support/buildWpjLargeCas.ts` (deterministic CAMS-shaped statements; folios, ISINs and names unique to a run so nothing real can match; everything deleted and re-queried). Evidence JSON per run in `docs/reviews/evidence_wp_j/`. Scheme universe on DEV: 14,570 instruments and 27,970 identifiers (production: about 14,360 and 27,916).

| Fixture | Run | Requests | Dominant steps |
|---|---|---|---|
| 25 funds x 12 purchases (300 lines, 13 folios) | first processing, before | 1,121 | certification 800 requests (67% of the time), scheme resolution 145, transactions 53 |
| | replacement reprocess, before | 1,293 | certification 800, transactions 301 (one link upsert per line) |
| | first processing, after | 379 | |
| | replacement reprocess, after | 338 | |
| 60 funds x 30 purchases (1,800 lines, 30 folios) | first processing, before | 4,635 (840 s) | **certification 3,960 requests, 703 s (84%)** |
| | replacement reprocess, before | 6,129 (1,089 s) | certification 3,960, **transactions 1,802 requests, 312 s** |
| | first processing, after | 816 | |
| | replacement reprocess, after | 719 | |
| Re-evaluate all, 60 positions | loop in one request | 840 (146 to 159 s) | 2.7 s a position |
| Publish 3 positions | | 75 | 4.1 s a position |

Findings. (1) The replacement attach and identity check is not the problem: 14 to 16 requests, 3 to 5 s. (2) **CPU is not the problem either**: extracting and parsing a 294 KB, 1,800-line PDF is 1.6 s; 1,000 funds and 6,000 lines 6.2 s (measured). (3) The time is round trips. The dominant waste was **certifying every (folio, scheme) combination of the statement** instead of the combinations that exist: for N funds in about N/2 folios that is about N x N/2 evaluations of several requests each, quadratic. (4) On a replay, one link upsert per transaction (1,802 requests for 1,800 lines). (5) One query per account, per owner, per fund, per audit event; the active scheme universe read as about 45 sequential pages.

Cheap, safe optimisations done and measured (the same steps, so the synchronous path gets them too): certification only for combinations that have a statement line or a stored snapshot (a combination with neither was answered "nothing to certify" by the old code); links written in bulk; the open-cases lookup shared per account; certification and Re-evaluate evaluate 6 positions at a time; the scheme universe read in 4 parallel pages; the user's accounts read once instead of 2 queries per folio; account and fund audit events written in one request per batch; owner checks per batch of 40 (the old single owner query put every account id of the statement in one request address, which can overflow for a statement with hundreds of folios). Result: requests 4,635 to 816 (5.7 times fewer) for the first processing and 6,129 to 719 (8.5 times fewer) for the replay of the 60-fund statement.

**Does a large reprocess now fit under about 15 s? Not guaranteed, so the job is still required.** Time is about 2 s of CPU plus requests x round trip. For the 60-fund replay (719 requests): about 9 s at 10 ms a request, 20 s at 25 ms, 38 s at 50 ms. Before the change, at 10 ms it was already about 63 s and at 25 ms about 155 s, which matches the production symptom (more than 2 minutes). A 200-fund statement is about 3 times larger again. So the optimisation moves the line, the job removes it.

## Design

```
Statements & data / replacement control / Review / Re-evaluate all
   POST .../source-documents/{id}/process | /reevaluate  = ADMISSION  -> 202 + job id   (or 200 with an immediate answer)
   |  authenticate, Premium run-start guard, malware scan (WP-H2: the password opens a PROTECTED pdf in memory for the scan only),
   |  then: resume the unfinished job of this statement, else the shared preflight (statement exists and is yours, AI review waiting,
   |  dead runs closed, cached success, stored file present, password attempt limiter), then create ONE job (idempotent on the statement
   |  and on the Idempotency-Key header)
POST .../statement-jobs/{jobId}/advance  = ONE SLICE (the open page asks again and again)  <- also: .../statement-jobs/cron/advance (backstop)
   |  claim the lease (database clock, one winner) -> steps for at most 17 s -> checkpoint -> release for the next slice
steps: read -> accounts -> owner -> schemes -> transactions -> holdings -> analyse -> certify -> finalize     (reevaluate: certify only)
```

States `queued`, `processing`, `review_required` (password, or an AI reading to check), `completed`, `failed`, with a phase and a progress figure. Reuse of WP-G: the same lease functions and fencing pattern, copied into **ii-specific tables** (`ii_statement_jobs`, `ii_statement_job_chunks`) because WP-G's tables are bound by foreign key and cross-tenant trigger to `fdh_statement_uploads`; generalising them would have meant altering a shipped table. There is no `job_kind` shim on WP-G's tables.

What makes it correct:

- **The pipeline is one implementation.** The 1,500-line `processSourceDocument` became resumable steps in `statementPipeline.ts`; `processSourceDocument` is now a thin wrapper that runs all steps in memory (tests, scripts). The job runs the SAME steps in slices. The economic oracle compares the two (equal).
- **The file and the password are used by one step.** The `read` step downloads, extracts and parses once; the structured result (folios, schemes, transaction and holding lines, exact bigints) is staged as temporary server-only rows; no later step needs the file or the password. The password goes in the request body of that slice only, is never in a job row, checkpoint, staging, audit event, case, run or document (a test searches every table for it), and the page drops it when the job leaves the step (`password_step`). A protected statement the backstop reaches without a password ends `review_required (password)`; nothing is deleted.
- **Idempotent admission.** Partial unique index: one queued or processing job per statement; unique per user and Idempotency-Key. Four simultaneous admissions create one job.
- **Idempotent steps.** Accounts, funds: find-or-create (fund ids derived from user, statement and fund key). Transactions: matched by fingerprint (unique per account in the database); rows this run already wrote are recognised by the run id and are not written, linked or counted twice; ids are derived from the run and the fingerprint. Holdings: insert-if-absent. Cases: opened idempotently. Counters are saved WITH the cursor in one write.
- **WP-H3 re-read matching, kept across slices.** Per batch the decisions (which stored row each re-read line claims, and whether it links or supersedes) are recorded in staging BEFORE any row is written; the pool of claimable stored rows excludes rows matched by fingerprint, rows claimed by earlier batches, and rows this batch had claimed in a killed attempt. The replaced rows are reversed exactly once, after the last batch and before holdings and certification (certification reads the figures), with one audit event. A killed and resumed chunk neither double-claims nor double-inserts.
- **Dead-job takeover.** A job whose lease ran out is claimed by the next poll or the backstop; the take-over is counted. Every write to the job row is fenced by the lease token.
- **Dead runs.** A parse run is alive only if a live job stands behind it (key `job:<id>:<attempt>`) or it has no job and is under 2 minutes old (the old synchronous path cannot outlive the platform limit by more). Anything else is closed `failed` with a plain reason, never succeeded, at admission, at the next attempt and by the sweep. This replaces the 10 minute "already being processed" window.
- **Raw-file deletion is unchanged**: purge after a successful finalize, the retention backstop leaves a file only for a job touched within 6 hours (strict deletion wins after that; the read step then says a replacement copy is needed). Staging is deleted when the job ends and swept after 24 hours; a job idle for a day with no live lease is ended `failed (abandoned)` with its run closed and its staging removed.
- **Preserved**: malware admission before parsing, owner-before-upload, the Premium gate and run-start guard, the per-user AI cost cap (the AI fallback is unchanged and runs inside the read step with an "attempted" mark saved before the call so a killed slice never repeats a billed call), non-enumerating 404s, day-first dates.
- **Backstop vs password race**: the backstop leaves a job admitted under 2 minutes ago to its browser, which is about to send the password.
- **Deployment order safety**: where 0313 is absent the process, re-evaluate, resolve and amend routes fall back to the earlier one-request behaviour (small statements still work).

## What changed (files)

New: `supabase/migrations/0312_*`, `0313_*`; `lib/services/investment-intelligence/{statementPipeline,statementStaging,positionCertification}.ts`; `statementJob/{model,store,worker,admission,deadRuns,abandoned,routeHelpers}.ts`; routes `app/api/investment-intelligence/statement-jobs/{route,[jobId]/route,[jobId]/advance/route,cron/advance/route}.ts`; `components/investment-intelligence/{statementJobDriver.ts,StatementJobFollower.tsx}`; fixtures, harness, live DEV files, negative-control script, tests, `docs/reviews/po_apply_wp_j/`.
Changed: `documentProcessing.ts` (wrapper), `accountResolution.ts` (optional prefetched accounts), `audit.ts` (batched events), `sourceDocumentPurge.ts` (backstop leaves a file for a recently active job), the process, re-evaluate, resolve-instrument and amend routes, `InvestmentIntelligenceClient.tsx`, `ReplacementCopyControl.tsx`, `ReviewCentreClient.tsx`, `lib/investment-intelligence/sourceDocumentGrouping.ts`, `DEPLOYMENT.md`, and the source-text or route contracts of 12 existing suites that cited the old function body or the old route behaviour (assertions kept, citations moved).

## Statements & data list (PO request)

Prominent: statements that are not finished (uploaded, processing, **Parse failed**, password, unsupported, reconciliation, AI review), have open issues (also when archived), have positions needing attention, are certified but have unpublished positions (chip "N ready to publish": publishing is a separate explicit click), or have a running job. Everything else, including archived and superseded statements with no open issue, sits under a quiet **Processed statements (N)** disclosure; the same row renderer draws both, so **Upload replacement copy** and the detail panel stay reachable. The replacement control and Re-evaluate follow the job with plain wording ("Queued. Starting in a moment. You can leave this page; it continues." / "Still working: this large statement is processed in steps. You can leave this page; it continues." / the end message). A reload picks unfinished jobs up again from `GET statement-jobs`.

## Tests

| File | Tests | Evidence | What |
|---|---|---|---|
| `doc2_4_wpJ_statementJobPglite` | 40 | PGLITE-VERIFIED | job = one-request run (economic oracle); 25, 200 and 1,000 positions (6,000 lines) exact counts, every position certified, run closed, staging empty; replay x3 after a publication (accounts, funds, transactions, links, holdings, publications, canonical investments, Net Worth unchanged); a replay killed at 8 points; **14 kill points** on a first processing; WP-H3 aged rows with NULL references and other units, NAV and type (200 lines per batch), killed at four points; two same-day instalments in different batches each claim their own stored row; a person-settled row stands; duplicate admission, Idempotency-Key, repeated polling, retry, dead-job takeover, fencing, dead-run guard, sweep, backstop grace, abandoned jobs, missing-transaction detection; the password in no table; two users, row level security |
| `doc2_4_wpJ_migrationsPglite` | 12 | PGLITE-VERIFIED | 0312 idempotent where columns exist, adds exactly three `int not null default 0` columns where absent, same shape as the PO's hand-applied statement, touches no constraint; 0313 guards, each with a negative control |
| `doc2_4_wpJ_unit` | 18 | UNIT-TESTED | staging round trip (bigints), same account and fund keys as the old pipeline, model, progress, driver |
| `doc2_4_wpJ_routes` | 15 | UNIT-TESTED | two users on every route, 401, secret, 202 contract, password never echoed, fallback |
| `doc2_4_wpJ_uiContract` | 10 | UNIT-TESTED | wiring, password handling |
| `doc2_4_wpJ_poPackPglite` | 10 | PGLITE-VERIFIED | the pack: editor rules, apply files equal the migrations, every read-only block, one schedule, rollback and re-apply, optional close and undo |

Run together with the WP-H oracle and the WP-H3 suite: 8 files, 123 tests pass. `iiSourceDocumentGrouping` was rewritten for the new rule.

**Negative controls** (`node scripts/doc2_4_wp_j_negative_controls.mjs`, removes one guard at a time, restores the source): all 9 turned a named test red: own-run rows not recognised after a kill; recorded claims ignored on resume; earlier batches' claims not excluded; replaced rows never reversed; fencing removed; dead-run guard treats everything as alive; the password written into the checkpoint; a failed job leaving its run running; a wrong owner flag in certification.

Related-suite run (`tests/unit/ii*, premiumUpload*, ownerBeforeUpload*, m12c*, statement*, aie*, pc*, fdh*, bank*, expenses*, lr3*, canonical*, doc2_4*`): 424 files, 7,918 tests. 3 failed: `aieUserDailyCapInvestmentIntelligence` (cited the old function body; fixed), `doc2_4_wpG_bankImportPgliteEndToEnd` 3,000 rows (5 s timeout under parallel load; passes in isolation, WP-G's), and `iiNetWorthNavRemarkPublishFlow` (a date-dependent test that fails the same way on origin/main, listed in the WP-B report). `fdh1Isolation` failed on origin/main for `realScanAdmission.ts` (WP-H2); its allow-list got that one entry. tsc: only the two known errors. eslint clean on every file I touched (the remaining warnings are in files I did not write). `git checkout -- scripts/ test-artifacts/` applied.

## Limits (all real)

- **Browser-open dependence.** Without the scheduled backstop a job advances only while the page is open; a closed page resumes when Statements & data is opened again. Registering the schedule removes this.
- **The read step cannot be split.** Extraction plus parse of the PDF (measured 1.6 s for 1,800 lines, 6.2 s for 6,000; a 20 MB file is the existing upload limit) must fit one slice. A statement that needs the AI fallback (layout not recognised) makes one bounded AI call inside that step, as before; if the slice dies inside it the job ends with an honest message and does NOT repeat the billed call.
- **Slice length is by budget, not measured as a job on DEV.** A slice stops starting new units after 17 s; the largest single unit (24 positions certified 6 at a time, 40 funds with the universe read, 200 lines) is a few seconds even at DEV latency, so a slice should stay under about 25 s of the 28 s. This is reasoning from the profile, not a measurement of slices on DEV (NOT PERFORMED).
- **Staging holds the parsed statement temporarily**: folios, holder names as parsed, fund names, ISINs, transaction and holding lines (not the file, not the full text, not the password). It is server-only (no browser policy), deleted when the job ends, ended after a day of inactivity and swept after 24 hours. If you would rather not stage this, the alternative is re-reading the PDF in every slice (slower, and impossible for a protected PDF). This is your decision.
- **Certification scope** changed deliberately: combinations with neither a line in this statement nor a stored snapshot are not evaluated (the old code returned "nothing to certify" for them). One edge: a fully redeemed position that has stored transactions but no stored snapshot and is not mentioned by the statement is no longer given a derived zero-unit closing snapshot by this statement's run (Re-evaluate and its own statement still do).
- **Other synchronous callers remain**: the AIE intake adapter (`lib/aie/adapters/investment-intelligence/write.ts`) still calls the synchronous wrapper; it is not on the Statements & data path.
- A replacement that corrects a figure for an as-of date already recorded does not overwrite it (WP-H limit 4, unchanged).
- The shared `node_modules` of this checkout lacked `@cantoo/pdf-lib` (WP-H2); I added it to this worktree's `node_modules` only (not committed).

## What you must do (release order: SQL first, then code, then schedule)

1. **DEV:** run `po_apply_wp_j/01` (read only), `02`, `03`, `04` (read only). Then tell me or run `WPJ_ENV_FILE=<DEV env file> WPJ_SIZES=25x12,60x30 npx vitest run --config vitest.livedev.config.ts tests/live-dev/iiWpjJobLiveDev.test.ts` (job in slices, replacement x2, a killed slice resumed, two-user denial, zero residue). Then click through Statements & data on DEV with a real protected statement (upload, replacement copy, reload mid-job, Re-evaluate all).
2. **Production, in this order:** `01`, `02` (a no-op if the three columns are already there, as you said), `03`, `04`; then push the code and confirm the Amplify deployment; then `05` (the schedule; replace the origin placeholder) and `07` to watch. No manual table backup is needed for `02` and `03`. Optional: `08` (backs up and closes the three old stuck runs; `09` undoes it) once `03` is applied; otherwise the new code closes them itself.
3. Decide: staging of the parsed statement (above); the 2 minute dead-run threshold for a run with no job; the 24 hour abandonment; the certification scope edge above; that a certified-but-unpublished statement stays prominent (chip "N ready to publish").
4. Production stays gated: uploads and replacement uploads remain Premium-gated and behind the malware and readiness switches. Nothing here enables anything.

## Release and merge facts

Fast-forward verdicts and the push lines are in the final message of the WP-J run (tip SHA verified after this report was committed). Admin Architecture Standard: not applicable (no Admin route, capability or screen touched).
