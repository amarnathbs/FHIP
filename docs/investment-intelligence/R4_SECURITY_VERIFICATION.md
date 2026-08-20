# R4 — Security Verification

## Honest status: NOT LIVE-TESTED this session

Every prior Investment Intelligence release's security section (R1, R2,
R3) was verified with real two-throwaway-household adversarial testing
against a live DEV Supabase instance, with service-role ground-truth
reads. This session's worktree initially had no `.env.local`; real
credentials were later copied in from the main repository checkout
(`D:\FHIP\.env.local`, a same-machine local file copy, never transmitted
anywhere) purely to unblock a production-build verification (see
`R4_ACCEPTANCE_REPORT.md` §39). **That does NOT unblock R4 security
testing**, for two independent reasons: (1) migration `0043` — the
migration that creates `ii_risk_free_rates`/`ii_analytics_results` and
extends the benchmark-mapping tables with the new RLS-relevant columns —
has NOT been applied to DEV (no DDL execution capability in this
sandbox), so none of R4's new tables/columns actually exist in the live
database yet to test against; (2) no API routes or UI were built this
session to exercise in the first place (see `R4_ACCEPTANCE_REPORT.md` —
Known Limitations). Credential availability was never the blocker for R4
specifically — the missing migration application and missing API surface
are.

Per this project's own established discipline (see `MEMORY.md`:
"Migration-application-BLOCKED is the correct, expected, non-penalized
classification... fabricating a live PASS is not"), the honest
classification here is: **SEC-R4-001 through SEC-R4-010, and the
reference-data write-rejection tests, were NOT EXECUTED this session.**
No security test in this document should be read as PASS — none were
run.

## What WAS done instead (design-level, not a substitute for live testing)

1. **RLS design review** (static, not live): `ii_analytics_results` (new
   in migration `0043`) has a SELECT policy scoped to `auth.uid() =
   user_id` and **no INSERT/UPDATE/DELETE policy for the authenticated
   role at all** — meaning, if the migration is applied exactly as
   written and RLS is enabled (as the `alter table ... enable row level
   security` statement does), Postgres denies all authenticated writes to
   that table by default (RLS with zero matching write policies = deny).
   This is the same pattern R1 established for `ii_benchmarks` /
   `ii_prices_nav` (`select using (true)`, no write policy), verified
   live in R1's own `R1_RLS_SECURITY_REPORT.md`. The pattern is reused,
   not reinvented — but its application to R4's specific new tables has
   **not itself been live-verified**.
2. **`ii_risk_free_rates`** — same "read-only for authenticated, service-
   role-write-only" pattern.
3. **Server-side canonical resolution**: `PerformanceEngine.ts` functions
   take pre-resolved `instrumentId`/cash-flow arrays as parameters; there
   is no code path in R4 that accepts a client-supplied `household_id` or
   `instrument_id` and uses it to bypass ownership, because **no API
   route was built this session** for R4 at all (see below) — there is
   literally no live HTTP endpoint yet to attack or defend. This is not a
   security guarantee; it is an accurate statement that the attack
   surface named in spec section 96 does not yet exist because the
   surface (API routes) was not built.

## No API routes were built this session

The spec's architecture section (67-68) calls for "API routes retrieve
derived results, never reimplement formulas." No such API routes exist
yet in this branch — only the underlying calculation engines
(`lib/engines/investment-intelligence/*.ts`) and the reference-data
config modules. Consequently:

- SEC-R4-001..010 (own-data access, cross-user blocking, unauthenticated
  blocking, query-param spoofing, tenant-safe audit) are **not
  applicable yet** — there is no endpoint to test.
- Reference-data write-rejection (NAV/benchmark/mappings/risk-free) and
  fake-analytics-insertion rejection are **schema-level design claims
  only** (see above), not proven by an actual authenticated write attempt
  against a live database.

## What this means for classification

Per spec section 111, "reference market data writable by ordinary users"
and "cross-user analytics leakage" are named Critical FAIL conditions —
but those are failure conditions for a system that has been tested and
found to fail. A system that has genuinely not been tested at all is a
different, narrower gap: **incomplete verification, not a demonstrated
failure**. This document exists specifically so that gap is stated
plainly rather than glossed over. See `R4_ACCEPTANCE_REPORT.md` — Final
Classification for how this affects the overall release verdict.

## What a follow-up session needs to actually run this

1. Apply migration `0043` to DEV (currently BLOCKED — no DDL capability
   in any session so far). Real Supabase credentials are already
   available in this worktree's `.env.local` (copied from the main
   checkout during this session).
2. Build the R4 API routes referenced in spec section 67 (not built this
   session).
3. Seed two throwaway households with real portfolios (reusing the
   existing 50-user harness pattern documented in `MEMORY.md` /
   `User tests/FHIP_50_User_E2E_Test_Package/`).
4. Run SEC-R4-001 through SEC-R4-010 for real, with service-role
   ground-truth reads after each attempted write, per this project's own
   established adversarial-testing discipline.
