# R11 Live DEV Verification

Spec sections 108-127: 25 live-DEV scenarios (synthetic data), at least 12 independent live reconciliations.

## Status: BLOCKED — genuinely, not by choice

`.env.local` does not exist in this worktree (`D:\FHIP\.claude\worktrees\agent-aff40e5a051339483\.env.local` — checked directly, confirmed absent before writing any code, and re-confirmed here). Without it, there is no Supabase URL/anon key/service-role key available to this environment, so:

- No real Supabase Auth users can be created (the `resourcesAdminRoleCtaHotfixLiveDev.test.ts` failure observed during the full regression run — `Failed to verify OTP: Request rate limit reached` — is exactly the kind of pre-existing test that depends on live Supabase Auth and cannot run meaningfully here).
- No real DEV Postgres instance is reachable to apply migrations `0082`/`0083` against, or to exercise the actual API routes (`app/api/professional-access/*`) end-to-end over HTTP.
- No real document upload → `documentProcessing.ts` → cross-source-resolution → canonical-transaction pipeline can be run against real parsed CAMS/KFintech statements in this environment.

This is precisely the same environment boundary the standing orchestration constraints predicted, and the same boundary the immediately-prior FDH-8 task in this program hit and disclosed honestly rather than fabricating results. **0 of the requested 25 live-DEV scenarios and 0 of the requested 12 independent live reconciliations were performed.** No number is fabricated here.

## What WAS genuinely verified as the closest available substitute

- **`scripts/r11_rls_certification.mjs`** replays the actual migration files against a real, freshly-instantiated PostgreSQL engine (PGlite — an in-process real Postgres, not a mock/simulation of RLS semantics) and exercises real RLS policies, real triggers, real foreign keys, real unique constraints. This is real Postgres behavior, genuinely closer to a live-DEV proof than a pure-JS unit test, but it is NOT the same as a live Supabase project reachable over the network with real Auth-issued JWTs, real PostgREST, and real Storage — those specific layers remain unverified.
- **`documentProcessing.ts`'s new cross-source logic** (the actual DB-writing glue code added to the transaction-insert loop) is type-checked (`tsc` clean) and code-reviewed, but was NOT executed end-to-end in this environment — it uses `createAdminClient()` (a real `@supabase/supabase-js` client hitting a real REST endpoint), which has no PGlite-compatible substitute without building a PostgREST-compatible shim, which was judged out of scope for the time available. This is the one genuine, disclosed gap between "the pure identity-resolution logic is proven correct" (it is, thoroughly) and "the wiring that calls it from the real ingestion pipeline is proven correct in a live environment" (it is not, in this environment).

## What a future session with `.env.local` should run

1. Apply migrations `0082`/`0083` to DEV.
2. Upload a real CAMS fixture and a real KFintech fixture covering the same synthetic folio/scheme/transaction, verify `ii_transaction_source_links` links rather than duplicates, and verify `ii_reconciliation_cases` records an auto-resolved `cross_source_exact_duplicate` or `cross_source_high_confidence_duplicate` case.
3. Repeat in the reverse import order, verify identical canonical result (import-order independence, live).
4. Deliberately construct a conflicting pair (same reference, different amount) and verify a `review_required` transaction is created and excluded from R4/R5/R6 outputs until resolved.
5. Create two real Supabase Auth users, provision one as a `professional_profiles` row, run the full invitation → accept → scope-grant → access → revoke → retry-denied lifecycle over real HTTP against `app/api/professional-access/*`, confirming the revoked-token-retry behaviour holds through a real session/JWT, not just through this session's PGlite/unit-test proxies for it.
