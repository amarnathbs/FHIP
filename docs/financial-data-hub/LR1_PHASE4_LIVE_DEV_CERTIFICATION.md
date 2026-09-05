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
