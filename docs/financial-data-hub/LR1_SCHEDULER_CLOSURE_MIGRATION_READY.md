# LR-1 Scheduler Closure — Migration Ready (Phase 1)

Closes the janitor-scheduler gap identified in
`docs/financial-data-hub/LR1_PHASE4_LIVE_DEV_CERTIFICATION.md`'s "Janitor
Scheduler Cadence" section: the purge-sweep route was code-complete and
live-DEV certified, but nothing in this codebase's deployment configuration
ever invoked it on a cadence, making the true worst-case raw-file lifetime
unbounded. This pass is **Phase 1 only** — code-level fix, migration file
generation, and preparation for a DEV-live proof. **Nothing was applied to
any database and no migration was executed.**

## 1. Processing-time safety check — PASSED CLEANLY, no concern found

Before lowering `FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES` from 60 to 50, all
six supported FDH ingestion pipelines were inspected end-to-end:
bank-csv, bank-pdf, payslip, investment-statement, retirement-statement,
liability-statement.

Findings:
- Every pipeline's `process`/`upload` route (`app/api/financial-data-hub/*`)
  is a single synchronous HTTP request/response — there is no queue, no
  background worker, and no multi-step async job anywhere in this codebase's
  FDH ingestion code. Confirmed by inspecting every `process` route and its
  underlying `*ProcessingService.ts`.
- No pipeline contains a `setTimeout`/sleep/retry-with-backoff loop that
  could extend real wall-clock processing time (grepped
  `lib/financial-data-hub` and `app/api/financial-data-hub` for
  `retry|backoff|setTimeout|delay(` — the only matches were code comments,
  not actual timing logic).
- Inputs are bounded: uploads are capped at 10 MB (CSV) / 20 MB (PDF) by
  FDH-3's `FDH_MAX_FILE_SIZE_BYTES`, and CSV parsing is additionally capped
  at `CSV_MAX_ROWS = 50,000` rows. In-process parsing/classification of
  inputs this size in Node.js takes low single-digit seconds, not minutes.
- No `maxDuration`/custom runtime override exists on any FDH route — they
  run under the platform's ordinary short request-timeout budget, which is
  itself far below 50 minutes.
- The existing lifecycle's "still processing" vs. "abandoned/stuck"
  distinction (verified, not rebuilt — `lib/financial-data-hub/domain/rawFileBackstop.ts#decideRawFileBackstopAction`)
  is purely age-based: a document younger than the threshold is left alone
  regardless of status; once it crosses the threshold it is force-purged
  regardless of status. This is safe specifically *because* of the two
  findings above: (a) no real processing state is ever occupied for more
  than a few seconds, so there is no legitimate in-flight operation to
  interrupt at 50 minutes, and (b) the states that legitimately persist for
  a long time by design (`review_required`, `ready_for_approval` — waiting
  on a human) do not need the raw file at all once structured data has been
  extracted (`services/purge.ts`'s own header: "Documents already awaiting
  review keep working from structured staging only").

**Conclusion: no legitimate supported workflow can normally take anywhere
close to 50 minutes between upload and durable structured extraction. The
threshold change proceeded.**

## 2. Constant updated

`lib/financial-data-hub/constants/retention.ts` —
`FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES` changed from `60` to `50`, with an
updated header explaining the PO's cadence decision and worst-case math
(50 + 5 = 55 minutes). This constant is the single source of truth consumed
uniformly by `services/purge.ts#enforceRawFileHardBackstop()` across all six
pipelines — no per-pipeline special-casing was introduced or existed before.
Confirmed exhaustively referenced in only 4 files (`retention.ts`,
`services/purge.ts`, and the two existing LR-1 test files) — no other
hardcoded "60" literal exists anywhere in the FDH codebase for this
concept.

## 3. Migration file — NOT applied

**File:** `supabase/migrations/0128_lr1_document_purge_sweep_scheduler.sql`

- Migration number `0128` was allocated after fetching `origin/main` and
  confirming its latest migration is `0127_g3_registration_country_expansion.sql`
  (matches this worktree's own local latest — no divergence to reconcile).
- Registers a `pg_cron` job (`lr1-document-purge-sweep`, `*/5 * * * *`) that
  calls `pg_net`'s `net.http_post` against the purge-sweep endpoint, mirroring
  the exact `cron.schedule(...) { select net.http_post(...) }` shape already
  proven to work in this environment by `0010_module9_reports.sql`'s
  `monthly-report-generation` job.
- **Idempotent by construction**: `select cron.unschedule('lr1-document-purge-sweep') where exists (...)`
  runs before `cron.schedule(...)`, the identical guarded-unschedule pattern
  `0010` itself uses — replaying this file cannot produce two jobs. (Reasoned
  from the SQL directly; not run, per instruction.)
- `0058` and every other historical migration file are untouched.

### Two defects in the `0010` precedent, deliberately NOT reproduced

`0010_module9_reports.sql`'s own job (checked directly, lines 219-235) has:
1. A hardcoded `http://localhost:3000/...` target — Supabase's hosted
   Postgres cannot reach a developer's localhost, so that job's HTTP
   callback has never been confirmed to actually succeed against a real
   deployment.
2. A **plaintext CRON_SECRET literal** committed directly into the migration
   body (`'fhip-cron-8f3a1c9e2b4d6e7f'`) — sitting in this repository's git
   history since `0010` was authored.

Neither is fixed in this pass (out of scope; `0010` is untouched), but
`0128` is deliberately designed not to copy either pattern.

### CRON_SECRET handling

Searched every file under `supabase/migrations/` for `vault` — **zero
matches**. No secure secret-storage mechanism exists anywhere in this
codebase's migration history to reuse. Per instruction, the actual secret
value is **never** written into `0128`, into any other file, or into this
report. Instead:

- `0128` enables `supabase_vault` (`create extension if not exists supabase_vault cascade;`) alongside `pg_cron`/`pg_net`.
- The scheduled job looks the secret up at call time from
  `vault.decrypted_secrets` by name (`lr1_purge_sweep_cron_secret`).
- **Before this migration is useful**, a human operator must separately run,
  directly in the DEV SQL Editor (never committed to any file):
  `select vault.create_secret('<the real CRON_SECRET value>', 'lr1_purge_sweep_cron_secret');`
  — using the exact same `CRON_SECRET` value already deployed to the app's
  own environment, since the route compares against that value directly.

This is a new mechanism for this codebase (nothing to "reuse" existed), but
it is Supabase's own native, documented facility for exactly this problem,
not an invented one.

### DEV target URL

`.env.local` in this worktree has no `APP_BASE_URL` set, and no standing,
publicly-reachable DEV deployment of this app was found anywhere in this
project's history — every prior "live DEV" certification pass in this
codebase (LR-1's own Phase 4 included, and FDH-11's/Mandatory-Country's
live-DEV passes) drove a developer's own local `next dev` instance, which
Supabase Cloud's hosted `pg_net` cannot reach. `APP_BASE_URL` *is* an
established env-var convention in this codebase's application code
(`lib/resources/public/metadata.ts`, `lib/services/reportPdfRenderer.ts`,
`lib/services/forecastReportPdfRenderer.ts`, and Amplify's own
`amplify.yml` build script all read/propagate it) — production's value is
presumably `https://app.financialhealthplatform.com` — but there is no DEV
equivalent already provisioned to read.

`0128` therefore ships with a clearly-marked placeholder,
`<REPLACE_WITH_REACHABLE_DEV_APP_ORIGIN>`, that a human must substitute with
a real, reachable DEV endpoint (e.g. a tunnel to a running `next dev`, or a
temporary branch deploy pointed at the DEV Supabase project) before pasting
into the DEV SQL Editor. **This is a genuine, disclosed prerequisite — not
something this pass can manufacture without console/infra access.** When
this same file is later applied to production, only that one literal
changes, to
`https://app.financialhealthplatform.com/api/financial-data-hub/documents/cron/purge-sweep`
— the Vault-based secret lookup is otherwise identical and environment-
agnostic (each Supabase project has its own independent Vault store, so the
same secret name resolves to that project's own value automatically).

## 4. Scheduler failure observability

No new platform or column is needed:
- `cron.job_run_details` (pg_cron's own built-in run-history table) is
  queryable directly in the Supabase SQL Editor and already sufficient to
  see the last N executions, their status, and any error message, e.g.:
  ```sql
  select jobid, runid, status, return_message, start_time, end_time
  from cron.job_run_details
  where jobid = (select jobid from cron.job where jobname = 'lr1-document-purge-sweep')
  order by start_time desc
  limit 20;
  ```
- Whether stale raw objects currently exist is already answerable from
  columns FDH-3 shipped in migration `0046`
  (`raw_document_purge_status`, `raw_document_purge_due_at`,
  `purge_attempt_count`, `last_purge_error_sanitised`), which already have a
  partial index covering exactly this query shape:
  ```sql
  select id, processing_status, raw_document_purge_status, uploaded_at,
         raw_document_purge_due_at, purge_attempt_count, last_purge_error_sanitised
  from fdh_statement_uploads
  where raw_document_storage_reference is not null
    and raw_document_purge_status <> 'purged'
    and uploaded_at < now() - interval '55 minutes';
  ```
  A non-empty result here past the designed 55-minute worst case is the
  signal an operator should watch for.

## 5. Regression

- `npx vitest run tests/unit/lr1UploadSecurityRawFileLifecycle.test.ts tests/unit/fdh3Domain.test.ts` — **49/49 passed.**
- `npx tsc --noEmit` — clean, no errors.
- `npx eslint` on both changed/added files (`retention.ts`,
  `scripts/lr1_scheduler_live_autonomy_proof.mjs`) — clean, no warnings.
- The threshold change is picked up everywhere it is referenced: confirmed
  by direct search that only `retention.ts`, `services/purge.ts`, and the
  two LR-1 test files reference `FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES`; the
  test files assert `<= 60` (still true at 50) and derive everything else
  from the constant, so no test needed updating.

## 6. DEV-live autonomous scheduler proof — PREPARED, NOT YET RUN

**Cannot run yet** — the migration has not been applied to any database.
Script: `scripts/lr1_scheduler_live_autonomy_proof.mjs`
(`node scripts/lr1_scheduler_live_autonomy_proof.mjs`, no arguments).

What it will do, once the migration is live in DEV:
1. Create one real, tagged synthetic user and drive one real upload through
   the actual bank-csv pipeline (a genuine pipeline-produced raw object, not
   a synthetic DB row).
2. Independently confirm the raw object is present in Storage via a direct
   `list()` call (never inferred).
3. Backdate `uploaded_at`/`created_at` to 51 minutes in the past — 1 minute
   past the new 50-minute backstop — using the same disclosed, reversible
   test-seam technique Phase 4 itself used for the 60-minute predecessor
   (Fixtures B and C2 in `LR1_PHASE4_LIVE_DEV_CERTIFICATION.md`).
4. **Never call the purge-sweep endpoint itself, at any point.**
5. Poll — every 30 seconds, for up to ~12 minutes (comfortably covering at
   least two 5-minute cron ticks) — for the raw object to become
   independently absent AND `raw_document_purge_status` to read `purged`,
   printing each poll's observed state.
6. Report PASS only if that happens with no manual sweep call anywhere in
   the script; report FAIL (not a fabricated pass) if the window elapses
   without it, which would mean the migration/Vault/URL setup is incomplete
   or incorrect — not that anything was faked.
7. Clean up the synthetic user/document/rows/object regardless of outcome.

## What's needed next

1. A human pastes `supabase/migrations/0128_lr1_document_purge_sweep_scheduler.sql`
   into DEV's Supabase SQL Editor, **after** first substituting
   `<REPLACE_WITH_REACHABLE_DEV_APP_ORIGIN>` with a real, reachable DEV app
   URL (this environment has no way to provision one itself).
2. That same human separately runs, directly in the SQL Editor (never
   committed): `select vault.create_secret('<the real CRON_SECRET value>', 'lr1_purge_sweep_cron_secret');`
3. Once both are done, `node scripts/lr1_scheduler_live_autonomy_proof.mjs`
   can be run to produce the genuine DEV-live autonomous proof — the one
   piece of this closure that cannot be completed in this pass.
