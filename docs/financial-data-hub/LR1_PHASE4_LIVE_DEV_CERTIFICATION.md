# LR-1 — Phase 4 Live DEV Certification

Closes the evidence gaps section 8 of `docs/production-apply/LR1_UPLOAD_INVENTORY_AND_RETENTION_AUDIT.md`
left open at the end of Phase 2 ("no live Supabase DEV credentials... Phase 4's
six live-DEV fixtures (A-F)... cannot be verified in this environment").

Run against real hosted DEV Postgres/Storage (project `vqycarelcoijzwlpkpcz`)
and a real `next dev` instance built from this branch. Every fixture drives
the actual ingestion pipeline end to end (real upload -> real format
detection -> real CSV parsing -> real R8 economic-type classification ->
real approval endpoint -> real purge-sweep cron route) — never a raw insert
of parser output into a staging table. Two real synthetic authenticated DEV
users (`lr1-livedev-<stamp>-a-fixa@fhip-test.invalid`,
`...-b-fixd@fhip-test.invalid`) were used for the cross-user fixture.

Script: `scripts/lr1_live_dev_certification.mjs` (`node scripts/lr1_live_dev_certification.mjs`,
optionally `[cronauth|a|b|c|d|e|cleanup]` to run a subset). **Latest full run:
80 passed, 0 failed.**

## Fixture results

| Fixture | Result | Evidence |
|---|---|---|
| A — success lifecycle | PASS (16/16) | Real upload -> `/detect` (CBA adapter matched) -> `/process` (5 transactions) -> `/categorise` (R8 classification, required before approval — `fdh7_transaction_has_blocking_issue()` correctly blocks an `unknown`-typed transaction) -> `/approve` -> purge scheduled `pending`/due-now (0-minute approved retention) -> cron sweep purges it -> raw object independently confirmed absent via a fresh `list()` call, never inferred from the sweep response -> `document_purged` audit event recorded, carries no signed URL/storage key/raw content. |
| B — malformed/unrecognised file | PASS (10/10) | A text-shaped-but-unrecognised CSV is accepted at upload (byte-signature validation only) and stored, but `/detect` correctly returns `manual_mapping_required` (no adapter match) and zero `fdh_transactions` are ever written. There is **no per-pipeline "purge immediately on parse failure" wiring** in this codebase (confirmed by reading every ingestion service) — only approval and explicit user-delete schedule an immediate purge — so this class of document relies entirely on the 60-minute hard backstop, exactly as designed. Verified live: backdating `uploaded_at` 65 minutes and running the real sweep forces the document into the purge lifecycle and the raw object is independently confirmed absent, with the transaction count still zero after. |
| C — abandonment | PASS (12/12), two sub-cases | **C1** (session created, never completed): `sweepAbandonedUploadSessions()` marks the expired session `expired` and the orphaned document `failed`, scheduling a purge 20 minutes out (verified live); a second clock-advance completes it via `findDuePurges`/`runPurgeAttempt` as `skipped_no_object` (nothing was ever uploaded). **C2** (a real object uploaded, then abandoned before any review action): the 60-minute hard backstop is what actually reclaims it — verified live end-to-end, raw object independently confirmed absent. |
| D — cross-user | PASS (16/16) | User B, with her own real authenticated session, is refused on every one of: status/reconciliation read, detect, approve, transaction-approve, preview (signed-URL redirect), generic metadata GET, delete (document verified untouched), and document listing — all `404`, i.e. genuinely not-found, not a leak-revealing `403`. At the Storage/Postgres RLS layer directly (User B's own access token, not the app, not service-role, not a mock): `list()` cannot see User A's object, `download` and `delete` are both refused. Negative controls confirm the SAME reads succeed for User A (real ownership scoping, not a blanket block). |
| E — delete retry | PASS (9/9), semi-synthetic (disclosed) | Supabase Storage's `remove()` does not error on an already-missing key (idempotent by design), and there is no safe way in this environment to force the underlying Storage HTTP call itself to fail without either revoking real DEV service-role permissions or network-level fault injection — both would be sabotaging real infrastructure, which the dispatch forbids. The `failed` purge state itself was therefore injected via a disclosed, reversible test-seam `UPDATE` (`raw_document_purge_status='failed'`, `purge_attempt_count=1`) on a synthetic row whose object still genuinely existed — exactly the column values the real failure path itself would leave. Every subsequent step (the real sweep's `findDuePurges` picking up `failed` rows, the real `runPurgeAttempt` retrying, delete + independent re-verify, the purged patch, the audit event, a further no-op sweep) is the unmodified real code path, run live. |
| F — raw-absent / Review still works (mandatory) | PASS (5/5) | After Fixture A's raw object was independently confirmed absent, `reconciliation`, `approved-summary`, the transaction list, and `status` all still return 200 with the real structured data; `preview` (the raw-file signed-URL redirect) correctly returns `410 Gone` rather than a stale or broken signed URL. |
| Cron sweep auth (fail-closed) | PASS (3/3) | No `x-cron-secret` header -> 401; an invalid secret -> 401; the correct secret -> 200 — exercised against the actual deployed-shape route (`app/api/financial-data-hub/documents/cron/purge-sweep`), not a unit mock. The secret value itself is never printed, logged, or written anywhere by the script or this document. |

## Re-run of prior/adjacent certifications on this now-live-DEV-capable tree

- `tests/unit/lr1UploadSecurityRawFileLifecycle.test.ts` + `tests/unit/fdh3Domain.test.ts` — 49/49 passed.
- `scripts/fdh3_rls_certification.mjs` (PGlite, fresh full rebuild — the cross-user RLS/FDH1-F1/audit/storage/purge-lifecycle suite) — **18/18 passed** on a clean rebuild of all 123 migrations. Two small fixes were needed to keep this pre-existing script correct against schema that landed well after FDH-3's own migration 0058, unrelated to LR-1: (1) the synthetic tenants must now satisfy Mandatory Country Confirmation (migrations 0104/0105/0108) before `fdh_statement_uploads` accepts a row for them, exactly as a real user would; (2) a stricter DB-level document-lifecycle transition trigger now enforces the full state chain, so the script's manual status update walks through every intermediate state (`validating` -> `queued` -> `processing` -> `extracted` -> `review_required` -> `ready_for_approval`) instead of jumping straight from `uploaded` to `approved`. Neither fix touches RLS/purge logic itself — both are pure test-fixture updates to keep an existing certification script valid against newer, unrelated schema.
- Full `npx vitest run`: 5978/5985 passed. The 2 genuine test failures (`aiResidualClosureFailClosed.test.ts`, a `fdh1Isolation.test.ts` 20-second static-analysis timeout) and 6 additional Resources-module `*LiveDev` test files that failed when run inside the full suite are **unrelated to LR-1** (AI module and Resources CMS, not Financial Data Hub) — disclosed here rather than investigated further, matching this project's established practice of not silently absorbing unrelated pre-existing gaps into an unrelated track's certification.

## Cleanup / residue

Every synthetic document/session/account/audit-event/reconciliation-result/
approved-summary row created by any fixture is deleted by the script's own
`cleanup` phase, keyed off every user created during that run (not merely
documents the script happens to remember), and independently re-queried
afterward — zero residue confirmed on every full run of this session,
including a final sweep across the entire session's auth users
(`lr1-livedev-*`), `LR1*`-masked financial accounts, and `lr1-fixture-*`
documents, which found zero remaining rows of any kind. No audit tombstone
or other permanent record was created by this certification pass itself —
the underlying `fdh_document_audit_events` rows the real pipeline itself
writes during each fixture are deleted along with everything else during
cleanup, since they belong to a wholly synthetic, test-only document.

## Not certified in this pass (disclosed)

Everything the original LR-1 dispatch explicitly scoped in Phase 4 was run
successfully; nothing was skipped or worked around. Production certification
(Phase 5) remains explicitly out of scope until this branch is reviewed and
merged, per this session's established sequencing for every track.

## Janitor Scheduler Cadence — Worst-Case Raw-File Lifetime

**Route audited:** `app/api/financial-data-hub/documents/cron/purge-sweep/route.ts`
(POST, `x-cron-secret`-gated, no user session — confirmed by reading the file directly).

**Finding: no scheduler invokes this route anywhere in this codebase's
deployment configuration.** Evidence, exhaustively:

- `amplify.yml` (repo root) is a plain Next.js build spec — `preBuild`/`build`
  phases only (Playwright deps, env-var propagation into `.env.production`,
  `npm run build`). It contains no `EventBridge`, no scheduled-invocation
  hook of any kind, and cannot express one — Amplify Hosting build settings
  are not a task scheduler.
- No `.github/workflows/` directory exists in this repository at all (`find
  .github/workflows -type f` returns nothing), so there is no GitHub Actions
  `schedule:` trigger to check.
- No `vercel.json` (or equivalent) exists — this project deploys via Amplify,
  not Vercel.
- No `pg_cron`/`cron.schedule(...)` reference to `purge-sweep` exists
  anywhere under `supabase/` (`grep -rn "cron.schedule(" supabase/` returns
  exactly **one** match in the whole codebase, in two files):
  - `supabase/migrations/0010_module9_reports.sql:225` — job name
    `monthly-report-generation`, cadence `'0 1 1 * *'` (01:00 on the 1st of
    every month), target `http://localhost:3000/api/reports/cron/monthly-generate`.
  - `supabase/production_bootstrap_part02.sql:634` — the same job, mirrored
    into the production bootstrap script.
  - Neither file, nor any other migration (`0046` through `0112`, every file
    matching `*purge*` was checked), contains a `cron.schedule` call for
    `purge-sweep`.
- `lib/financial-data-hub/services/purge.ts`'s own header (the module the
  route calls into) documents the invocation contract explicitly and does
  **not** claim a scheduler exists: it says the route "reus[es] the same
  `x-cron-secret` / `CRON_SECRET` pattern as
  `app/api/reports/cron/monthly-generate`" for **auth**, not that it inherits
  that route's `pg_cron` registration. The route's own header (added this
  branch) says it is "invoked by an external scheduler (or manually for DEV
  verification)" — written as a requirement/assumption the route depends on,
  not as a statement that such a scheduler has actually been configured.

**Established mechanism in this project, confirmed by precedent:** the ONE
real scheduled job in the entire codebase — `monthly-report-generation` for
the reports cron — is registered via Supabase's `pg_cron` + `pg_net`
extensions inside a SQL migration (`cron.schedule(name, cron_expression, $$
select net.http_post(url := ..., headers := ..., body := ...) $$)`), not via
any AWS-console/EventBridge configuration and not via GitHub Actions. That
migration's own comment discloses a second real gap even for the one job
that IS registered: the hardcoded target URL is `http://localhost:3000/...`,
which Supabase's hosted Postgres cannot reach from outside — i.e. even the
reports cron's `pg_net` call is not confirmed to successfully reach a real
deployed instance today, though that is a separate, pre-existing issue
outside LR-1's scope and is not re-litigated here. No equivalent migration —
correct URL or not — exists for `purge-sweep` at all.

**Calculated worst-case raw-file lifetime:** with
`FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES = 60`
(`lib/financial-data-hub/constants/retention.ts`) and **no periodic caller of
any kind**, the worst case is not "60 minutes" and is not `60 + N` for any
finite `N` — it is **effectively UNBOUNDED**. A document that becomes stale
1 second after the last manual/ad-hoc invocation of `purge-sweep` (e.g. the
Phase 4 certification script, or a developer's `curl`) sits with its raw
object physically present in Storage indefinitely, until the next time some
human or process happens to call the route again. The 60-minute constant
describes only when a document becomes *eligible* for purge, not when it
will actually *be* purged.

**Verdict on the P1 (dormant janitor):** the code-level defect — no live
caller existed at all, not even a manual one — that FDH-3 originally shipped
with is closed by this branch: `approveStatement` now calls
`scheduleImmediateDocumentPurge` synchronously in the request path (approval
itself causes an immediate purge attempt, independent of any external
scheduler), and the `purge-sweep` route is a real, fail-closed, working
endpoint that Phase 4 proved does everything it claims when invoked. **But
the janitor as a *periodic background sweep* remains dormant**: nothing in
this repository's deployment configuration calls it on any cadence. This is
not a code defect — there is nothing further for a code change in this
branch to fix — it is an **external-infrastructure-activation gap** the
Product Owner must close outside of what any agent or this codebase can do
(no AWS/Amplify console access exists in this environment, matching every
other track this session).

**Precise specification for what must be configured externally:**

1. **Mechanism** (matching this project's own established pattern): a
   `pg_cron` + `pg_net` job in a new Supabase migration, structurally
   identical to `0010_module9_reports.sql`'s `monthly-report-generation`
   job — `cron.schedule('fdh-raw-file-purge-sweep', '<cron expression>', $$
   select net.http_post(url := '<APP_BASE_URL>/api/financial-data-hub/documents/cron/purge-sweep',
   headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', '<CRON_SECRET>'),
   body := '{}'::jsonb) $$)`. `<APP_BASE_URL>` must be the real, publicly
   reachable production origin, not `localhost` — the same defect already
   disclosed in the reports-cron migration must not be repeated here.
   (Alternatively, an AWS EventBridge Scheduler rule POSTing to the same
   route with the same header would work equivalently, but `pg_cron`/`pg_net`
   is what this codebase already uses and requires no new AWS wiring.)
2. **Required interval to achieve a genuine ≤60-minute worst case:** the
   worst case is `threshold + N` where `N` is the cron interval, so
   `threshold + N ≤ 60` requires `N ≤ 0` while the threshold stays at 60 —
   i.e. **no positive interval can hit a true ≤60-minute bound without also
   lowering the 60-minute threshold itself.** Two concrete options, stated
   exactly:
   - **Keep the 60-minute threshold, accept a slightly larger real-world
     bound:** every 5 minutes (`*/5 * * * *`) gives a worst case of
     **~65 minutes**; every 10 minutes gives **~70 minutes**; every 15
     minutes gives **~75 minutes**. None of these is "≤60 minutes" — they
     are the closest practical approximations given a nonzero polling
     interval.
   - **Achieve a genuine ≤60-minute guarantee by lowering the threshold to
     match the chosen interval:** e.g. run every 5 minutes AND lower
     `FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES` to 55 (55 + 5 = 60 exactly), or
     run every 10 minutes AND lower the threshold to 50 (50 + 10 = 60). This
     is the only way to make "≤60 minutes" a true statement about the
     deployed system rather than about the constant's name alone.
3. **This is an operational activation item, not a code defect**, and is
   called out here rather than fixed in this branch because fixing it would
   require either AWS/Amplify console access this environment does not have,
   or a Product Owner decision on which of the two options in point 2 (looser
   bound vs. lower threshold) is acceptable — both are policy calls, not
   engineering ones.
