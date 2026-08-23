# R8 — Live DEV Verification

## Status: NOT PERFORMED — disclosed, structural constraint

This environment has **no DDL-execution credential** for the live DEV
Supabase project (`vqycarelcoijzwlpkpcz`) — service-role REST key only, no
`DATABASE_URL`, no linked Supabase CLI, no `exec_sql` RPC. This is the
identical, previously-documented constraint every prior FDH phase in this
environment has carried (FDH-2, FDH-3, R7, FDH-4 all disclosed the same
gap for their own migrations at the point of authoring).

Migration `0067_r8_transaction_classification_engine.sql` is delivered as
a file for manual application via the Supabase SQL editor or `supabase db
push`, following the exact process every prior migration in this project
used.

## What this means for the spec's live-DEV requirements (sections 79-82)

None of the following were performed, because none can be performed
without the migration being live:

- The 20 live-DEV cases (salary, expense, merchant normalisation, internal
  transfer, false transfer, credit-card repayment, investment transfer,
  refund, reversal, bank fee, interest income, user correction, reusable
  user rule, ambiguous merchant, monthly recurring, date-drift recurring,
  variable recurring amount, paused series, multi-account, >1000
  transactions).
- The 12 independently-derived live reconciliation cases.
- Live cross-user/same-user forgery attempts against the real database
  (as opposed to the PGlite-simulated equivalent in
  `R8_SECURITY_VERIFICATION.md`, which used real Postgres semantics but
  not the real DEV project).
- Live UI verification (moot in any case — no classification review UI
  exists yet in this release; see `R8_ACCEPTANCE_REPORT.md`'s open
  residuals).

## What WAS done to reduce the risk this gap represents

1. **PGlite full-migration rebuild** (`scripts/db-rebuild-check/replay.mjs`)
   confirms migration 0067 applies cleanly on top of all 66 prior
   migrations with zero manual intervention, against real Postgres
   (WASM), not a mock.
2. **The security certification script**
   (`scripts/r8_security_certification.mjs`) exercises the exact RLS/
   trigger logic that will govern the real DEV database once applied,
   using real two-tenant data and real `auth.uid()`/`auth.role()`
   semantics via the same JWT-claims GUC mechanism PostgREST itself uses.
3. **The independent oracle comparison**
   (`scripts/r8_oracle_compare.ts`) exercises the real, unmodified
   production TypeScript engine — the same code that will run against
   live DEV once wired to a real request path — not a simulated version.

## Recommended follow-up (for the Product Owner / next session)

1. Apply migration `0067` via the Supabase SQL editor.
2. Re-run `scripts/r8_security_certification.mjs`'s scenarios as live
   queries against a real authenticated session (mirroring how migration
   `0065`'s fix was independently re-verified live after application —
   see `docs/financial-data-hub/FDH4_COMPLETION_REPORT.md`'s closure
   addendum for that precedent).
3. Run `classifyUserTransactions()` against a real user's real imported
   bank-CSV transactions and manually verify a sample against the review
   endpoints.
