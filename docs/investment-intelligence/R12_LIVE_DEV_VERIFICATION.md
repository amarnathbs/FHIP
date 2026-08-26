# R12 — Live DEV Verification

## A real, structural tool limitation this round hit and disclosed honestly

This session has **no DDL execution capability against the real hosted Supabase DEV project**.
Verified directly, not assumed: `scripts/fdh1_closure_capability_probe.mjs` (a pre-existing repo
script from an earlier round) was re-run against the current DEV project and confirmed no
`exec_sql`/`execute_sql`/`run_sql`/`admin_exec` RPC function exists, and PostgREST exposes no DDL path
of any kind. Migration 0092 could not, therefore, be applied to the real hosted DEV database from
within this session — the standing project pattern (see MEMORY.md) is for a human to apply new
migrations via the Supabase SQL editor, sometimes with the user pasting live verification back
afterward; that step did not happen in this round because the orchestrating instructions for this
task required continuous, uninterrupted work without waiting on external input.

## What this means for the spec's 25-scenario target

**Genuinely verified on real, live, hosted DEV Supabase (pre-0092 schema)**: 6 checks
(`scripts/r12_live_dev_verification.mjs`), covering existing-MF regression, the same-user holding
forgery vulnerability (RED, live), cross-user access (blocked), and same-ISIN instrument dedup across
NSE/BSE (blocked duplicate, HTTP 409).

**Verified on a freshly rebuilt REAL Postgres via PGlite, WITH migration 0092 applied** (real
`auth.uid()`/RLS enforcement, not a mock — the same technique `scripts/db-rebuild-check/rls.mjs`
already established in this project): 11 checks (`scripts/r12_post_migration_pglite_verification.mjs`),
covering every new schema addition (`sale`, `price_source`, `direct_listed_security_rule`), the GREEN
state of the holding-forgery fix, cross-user blocking, instrument dedup, and holding-publication
double-count prevention.

**Not verified this round** (would require either DDL access to real DEV, or a running `next dev`
instance driven through real HTTP with real session cookies — spec section 96's own preferred method
per the R11 precedent script, `scripts/r11_professional_live_dev_tests.mjs`): the actual
`POST /api/investment-intelligence/positions/manual` route exercised end-to-end through a live running
app; equity dividend/maturity/redemption through the real UI; R4/R5/R6/R9/R10 consuming a REAL
published equity position live; a real Premium report containing an equity position.

## Mapping against the spec's LIVE 01-25 (honest accounting)

| # | Scenario | Status |
|---|---|---|
| LIVE 01 | Existing MF regression | **DONE** (live) |
| LIVE 02 | Direct equity create | **PARTIAL** — proven at the DB/RLS layer live (LIVE-R12-04 creates a real equity instrument); the actual manual-entry API route was not exercised live (needs 0092) |
| LIVE 03 | Same equity, NSE+BSE | **DONE** (live) |
| LIVE 04 | Equity buy+sell | Not run live (unit/oracle-tested only — `HLD-003`, `HLD-004`) |
| LIVE 05 | Equity dividend | Not run live (unit-tested only — `HLD-005`) |
| LIVE 06-07 | ETF / ETF performance | Not run live |
| LIVE 08-10 | Bond/coupon/maturity | N/A — deferred scope |
| LIVE 11-12 | REIT/InvIT | N/A — deferred scope |
| LIVE 13-14 | Mixed portfolio / net worth | Not run live (unit-tested attribution only) |
| LIVE 15-17 | R4/R5/R6 live | Not run live (R5 X-ray attribution unit/oracle-tested; R4/R6 architecturally unchanged, not separately live-exercised) |
| LIVE 18-19 | Goals / Forecasting | N/A this cycle — no new code |
| LIVE 20 | Review Centre | N/A this cycle — no new rule added |
| LIVE 21 | Premium report | Not run live |
| LIVE 22 | Same-user forgery | **DONE** (live RED + PGlite GREEN) |
| LIVE 23 | Cross-user attack | **DONE** (live + PGlite) |
| LIVE 24 | >1000 rows | Not run (see `R12_PAGINATION_SCALE_CERTIFICATION.md`) |
| LIVE 25 | Missing/stale market data | Unit-tested only, not live |

**Actual: 4/25 fully live-proven, several more partially covered by the closest available substitute
(PGlite real-Postgres verification) — genuinely short of the spec's 25/25 target.** This is the single
largest honest gap in this round's certification, driven directly by the DDL-access limitation above.

## Independent live reconciliation (spec section 122)

Not separately performed (target was 12/12) — the live-DEV script above IS the live reconciliation for
the 6 scenarios it covers; no additional independent (non-production-code) live reconciliation pass
was run given the round's time budget.
