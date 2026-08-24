# FDH-7 — Live DEV Certification

## Honest status: CONDITIONAL — migration 0076 is not applied to DEV

Per the orchestration constraint disclosed at the start of this task: this environment has REST/service-role read access to real DEV (`vqycarelcoijzwlpkpcz.supabase.co`) but **no DDL execution access**. Confirmed via live REST probes before allocating migration `0076`:

- `GET fdh_approved_financial_summaries?limit=1` -> `404` (table does not exist yet on DEV)
- `GET fdh_transactions?select=id,approval_status` -> `400` (column does not exist yet on DEV)
- `GET fdh_statement_uploads?select=id,approved_by` -> `400` (column does not exist yet on DEV)

Every NEW FDH-7 database object (`fdh_approved_financial_summaries`, `fdh_transactions.approval_status`/`approved_at`/`approved_by`, `fdh_statement_uploads.approved_by`/`approval_version`/`reopened_*`, all 5 new trigger functions, the widened `event_type` constraint) genuinely does not exist on DEV until `0076_fdh7_review_approval_workflow.sql` is applied. This makes a real end-to-end live-DEV run of the NEW split/approve/reopen/bulk-approve/review-queue endpoints structurally impossible from this environment — not a shortcut, a hard constraint, matching FDH-6's own precedent for its migration `0075`.

## What WAS proven live, at full Postgres fidelity, instead (spec 111 substitute — see FDH-6's identical precedent for migrations that cannot reach DEV from this environment)

`scripts/fdh7_certification.mjs` — real PostgreSQL 18 (PGlite, WASM-compiled, not a mock), full clean rebuild (75/75 migrations including 0076), real two-tenant populated data, real RLS enforcement, real trigger enforcement, real negative controls. **35/35 PASS, 0 FAIL.** This is qualitatively different from a unit-test mock: every constraint, every trigger, every RLS policy that would run on real DEV runs here identically — the only thing not proven is the network-path from a live Next.js server via PostgREST, which the untouched existing R7/R8/FDH-6 live-DEV certifications already prove works for this exact API-route/RLS-client pattern.

## What genuinely could not be tested this phase

- CSV upload -> review -> FDH-7 approval -> Approved Summary, end to end, through the real HTTP API (spec 111-121) — blocked by the migration-application gap above.
- Live purge-after-approval round trip specifically gated on `approved_by` (spec 121) — same gap.
- Scale at 5,000/10,000 real rows round-tripped through the live `review-queue` endpoint (spec 94) — same gap.

## What remains valid and reused from prior live-DEV certifications, unaffected by this phase

R7's live CSV certification, R8's live classification certification, FDH-6's live transfer/duplicate/correction certification (`FDH6_LIVE_DEV_CERTIFICATION.md`, 34/34 PASS) all remain valid — FDH-7 changes none of the code paths they exercised. The FDH-6 completion report's own closure addendum documents that migration application to DEV, once granted by the Product Owner, is followed by a same-day live re-certification and an upgrade to UNCONDITIONAL FULL PASS — the identical path is open here.

## Upgrade path to UNCONDITIONAL

1. Apply `supabase/migrations/0076_fdh7_review_approval_workflow.sql` to DEV.
2. Re-run `scripts/fdh7_certification.mjs`'s live-DEV equivalent (a synthetic CSV upload -> process -> split -> approve -> reopen -> re-approve -> purge cycle against real DEV, mirroring FDH-6's own `FDH6-*` scripted live checks).
3. Independently verify via REST that the new columns/table are queryable and the trigger functions exist (`pg_proc`).
