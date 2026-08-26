# FDH-9 — Security Certification (consolidated)

This document consolidates the security posture across both FDH-9 passes: the
prior hardening pass (2026-08-26, commit `5937936`) and this live-DEV-cert +
Income-tab pass (same day). It supersedes nothing — both passes' findings
stand; this is the single place to read the combined picture.

## What the hardening pass already closed (unchanged by this pass)

See `FDH9_AUTHORITY_AND_MUTATION_MODEL.md` for the full table-by-table
breakdown. Summary:

1. **Same-tenant proposal forgery** (the originally disclosed defect): a
   direct `PATCH fhip_import_proposals?id=eq.<own>` to `status=applied` is
   now BLOCKED by `trg_fhip_import_proposals_authoritative_write` — `applied`
   is reachable only through `fdh9_apply_income_proposal()`.
2. **Forged application record**: a direct `INSERT` into
   `fhip_import_applications` is BLOCKED by RLS itself (`WITH CHECK` requires
   the `fhip.import_bridge_internal_write` transaction-local flag, which only
   the RPC ever sets).
3. **Payroll authoritative-field forgery**: every system-derived column on
   `fdh_payroll_events` (money fields, reconciliation outcome, bank-match
   outcome, parser provenance, approval state) is BLOCKED from direct
   authenticated UPDATE by `trg_fdh_payroll_events_authoritative_write` —
   only `employer_name`/`employer_normalised` remain directly editable.
4. **Cross-tenant Income target / bank link**: enforced both at proposal
   write time (same-tenant triggers resolve `target_entity_id` against the
   declared domain) and independently re-checked inside the apply RPC itself.
5. **income_sources provenance forgery**: `source_type` /
   `last_import_application_id` / `last_imported_at` are blocked from direct
   authenticated UPDATE; every other Income column remains exactly as
   user-editable as before FDH-9 (manual Income is unaffected).

All five are certified live against real Postgres in
`scripts/fdh9_certification.mjs` (76/76 PASS, re-run fresh in this pass — see
`FDH9_PGLITE_CERTIFICATION.md`), including 8 harness self-checks proving each
PASS is not vacuous (spec section 65).

## What this pass added: the API/UI layer's own authorization discipline

The database-layer hardening above is necessary but not sufficient once a
real HTTP API exists in front of it — an API route that forgot to check
`auth.getUser()`, or that trusted a client-supplied `user_id`, would reopen a
version of the same class of hole one layer up, RLS notwithstanding. This
pass adds:

- **Every one of the 7 new routes derives identity from `requireUser()`
  (session-based) and returns 401 before calling any service/database
  function when there is none** — proven directly (not just read from source)
  in `tests/unit/fdh9IncomeTabUx.test.ts`'s "authenticated session required"
  block (7 tests, one per route).
- **No route accepts a client-supplied `user_id`/`household_id`/`owner_id`
  of any kind.** The apply route's request body is `{ decision,
  selectedFields }` only — reviewed by hand against spec section 30's
  requirement, and mechanically true because `applyIncomeProposalAtomic()`
  never reads a user id out of the request body at all (it comes from
  `requireUser()` upstream and is not even passed into the RPC call — the
  RPC itself calls `auth.uid()`).
- **Apply is exclusively the atomic RPC** (spec section 31): grepped by hand
  — the apply route contains no `.update()`/`.patch()` call against
  `fhip_import_proposals` or `income_sources` anywhere; its only mutation
  path is `supabase.rpc('fdh9_apply_income_proposal', ...)`.
- **A genuine, previously-undetected TypeScript/DB drift was found and
  fixed**: migration 0091 widened `fdh_document_audit_events.event_type`'s
  DB check constraint with 6 FDH-9 values, but the parallel TS-side
  `FdhDocumentAuditEventType` enum was never widened to match — invisible
  until this pass because no code had ever tried to record one of those six
  events (no app/api layer existed). Fixed in `enums.ts`
  (`FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED`), closed by a new
  `tests/unit/fdh9SchemaContract.test.ts`, `tsc --noEmit` now exit 0.
- **`tests/unit/fdh1Isolation.test.ts` — the isolation guarantee — re-proven,
  not weakened.** Two files (`lib/import-bridge/incomeProposalService.ts`,
  `components/income/PayslipImportPanel.tsx`) trip that test's naive
  path-substring detector purely through prose/`fetch()`-URL mentions of
  `financial-data-hub`; both were hand-verified to contain **zero** real
  `from '@/lib/financial-data-hub/...'` imports and added to the test's own
  precedented `FDH_APPROVED_CONSUMER_FILES` allowlist (the identical pattern
  already used for `incomeAdapter.ts`/`types.ts`/`AppShell.tsx`). No FDH
  internal was actually imported from outside the FDH tree by this pass.

## What this pass could NOT certify, and why (see `FDH9_LIVE_DEV_CERTIFICATION.md`)

Sections 11-20's live-DEV security certification (same-tenant/cross-tenant
forgery attempts against a **real, running Supabase project**, exercised
through the **new HTTP routes** rather than PGlite) requires DDL execution
capability this environment does not have: no `supabase` CLI, no
`SUPABASE_ACCESS_TOKEN`, no Postgres connection string, no Management API
token anywhere in the repo, `.env.local`, or `~/.supabase` — confirmed fresh
in this pass, matching the prior hardening pass's own finding. Migration
`0091` has therefore never been applied to any live database, DEV included.
Everything in this document is proven against PGlite (a real, unmodified
Postgres via `@electric-sql/pglite`) and against the new routes' own logic —
genuinely strong evidence, but not the same claim as "verified against a live
Supabase project," and this report does not claim otherwise.
