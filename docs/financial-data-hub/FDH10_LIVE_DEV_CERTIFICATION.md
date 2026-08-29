# FDH-10 — Live DEV Certification

## Status: NOT EXECUTED against hosted DEV — honestly disclosed

Per hard rule 3 of this dispatch: this environment has no Supabase CLI/token/connection string capable of applying DDL to the hosted DEV project. A read-only check (via the anon/service keys already present in `.env.local`, used only for SELECT queries, never DDL) confirmed **DEV does not yet have migration 0096's schema** — `fdh_liability_statements`/`fdh_liability_statement_activities` both return PostgREST `PGRST205` ("table not found in schema cache"), and `liabilities.masked_identifier` does not exist yet either. This is the expected, unsurprising state for a migration that has not been applied.

## What WAS executed as the closest available substitute

`scripts/fdh10_security_certification.mjs` runs against **PGlite** — a real, unmodified PostgreSQL engine (compiled to WASM), not a mock — which genuinely exercises RLS policies, trigger functions, and the atomic RPC exactly as hosted Postgres would. 18/18 checks pass. See `FDH10_SECURITY_CERTIFICATION.md` for the full transcript. This is materially stronger evidence than a pure TypeScript-level test (which is why this project's own established practice, per FDH-3/FDH-9's precedent, treats a PGlite result as meaningfully load-bearing) — but it is **not** a substitute for the specific guarantees only a hosted project provides: real Supabase Auth JWT issuance, the actual PostgREST HTTP layer (as opposed to a direct SQL client), and Storage.

## Required live-DEV journeys (spec sections 107-120) — none executed

- Full credit-card E2E (upload -> ... -> apply -> Expense Tracker without double-count)
- Full loan E2E (principal/interest/fee semantics end to end)
- India EMI decomposition
- AU mortgage with an existing linked Property/Liability (confirming the link survives)
- No-apply-through-the-flow
- Card-expense-double-count / loan-decomposition / loan-proceeds-not-income (all three already certified at the LOGIC level — see `FDH10_FINANCIAL_INTEGRITY_CERTIFICATION.md` — but not re-proven against a real browser + real hosted Postgres)
- Cross-tenant security, same-tenant forgery, stale proposal, concurrent apply (all certified against real Postgres via PGlite; not re-run against hosted DEV)

None of these could be executed because (a) migration 0096 is not applied to DEV (structurally cannot be, per hard rule 3), and (b) no UI exists yet for a browser journey to drive (see `FDH10_LIABILITIES_TAB_UX.md`).

## Exact owner action required

1. Apply migration `0096_fdh10_credit_cards_loans_intelligence.sql` to hosted DEV via the Supabase SQL Editor, in the 4 independently-pasteable chunks provided at `docs/financial-data-hub/migration_0096_chunks/chunk_{1..4}_of_4_*.sql` (verified byte-identical to the source file when reassembled — see the migration's own commit message).
2. Re-run `node scripts/fdh10_security_certification.mjs`'s DEV-schema-presence check (or an equivalent read-only query) to confirm the new tables/columns exist.
3. Build the FDH10-K UI/API surface (see `FDH10_LIABILITIES_TAB_UX.md`'s residual list) before attempting a genuine browser-journey live-DEV pass — there is currently nothing for a browser to drive.
4. Re-run the live-DEV journeys listed above once both (1) and (3) are complete.

## DEV cleanup

Not applicable — no synthetic data of any kind was created against hosted DEV in this pass (only read-only SELECT queries were issued, confirmed via the transcript above).
