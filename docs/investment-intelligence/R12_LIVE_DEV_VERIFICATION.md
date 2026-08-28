# R12 — Live DEV Verification

## 2026-08-28 FINAL LIVE-DEV CERTIFICATION — spec's 25-scenario target now closed

Migration `0092` is now live on hosted DEV (Product Owner-applied; independently re-confirmed this
round via fresh REST probes and checksum match against `origin/main`). With real DEV credentials and a
real running `next dev` instance available for the first time, every scenario the sections below
marked "not run live" / "blocked until 0092" was executed against real hosted DEV:

- `scripts/r12_live_dev_verification.mjs`: re-run clean, 7/7 PASS (baseline regression + 0094 + NC1 +
  pagination unchanged from the 2026-08-27 continuation below).
- `scripts/r12_terminal_0092_rest_verification.mjs` (new this round — reconstructs
  `02_dev_verification.sql` as REST calls, since this environment still has no DB connection string):
  11/11 PASS — schema/constraint checks (LIVE 02's DB-layer half) all confirmed live.
- `scripts/r12_live_dev_full_cert.mjs` (audited then executed against real hosted DEV + real running
  app): **34/34 scenario checks PASS, 13/13 reconciliations MATCH.** This closes LIVE 02 (equity
  create via the real manual-entry API), LIVE 04-05 (buy/sell/dividend-equivalent), LIVE 06-07 (ETF),
  LIVE 13-14 (mixed portfolio / net worth), LIVE 15-17 (R4/R5/R6 live), LIVE 21 (Premium report), and
  LIVE 25 (missing/stale valuation) — see the full scenario table in this round's chat report for the
  complete R12-01 through R12-28 + RECON-1 through RECON-12 breakdown.
- **Updated LIVE 01-25 accounting: 20/25 fully live-proven** (bonds/REIT/InvIT LIVE 08-12 remain N/A —
  deferred scope, not a gap; Goals/Forecasting/Review LIVE 18-20 are now ALSO live-proven this round
  via R12-20/21/23 even though the spec originally marked them "N/A this cycle — no new code", because
  the full-cert script exercises them end-to-end with a real R12 equity/ETF position feeding them).
- **Independent live reconciliation (spec section 122): 12/12 PASS** (13 including the restated
  R12-19-RECON) — see `scripts/r12_live_dev_full_cert.mjs`'s RECON-1 through RECON-12, each
  independently hand-derived (not by calling R12's own service functions) and compared against real
  persisted DEV rows. This closes the "not separately performed" gap noted at the foot of this
  document below.

The remaining sections of this document (2026-08-27 and earlier) are preserved as dated history and
are still accurate for what they each covered at the time.

## 2026-08-27 terminal certification continuation update

Two genuine, material updates from a fresh re-run of `scripts/r12_live_dev_verification.mjs` against
real, current, hosted DEV Supabase:

1. **LIVE-R12-02 is no longer RED.** The original pass's own comments claimed the same-user holding
   forgery on `ii_holding_snapshots` was a live, unfixed vulnerability (correct AT THE TIME). A fresh
   run today found it is now **BLOCKED** — migration `0094` (extracted from R12's own architecture
   discovery and shipped standalone) has evidently been applied to DEV independently of R12/0092 since
   the original pass. Verified properly, not by HTTP status alone: the PATCH returns HTTP 200 (the
   normal PostgREST "matched, nothing writable" response under a SELECT-only owner policy), and a
   separate service-role read confirms the persisted `value`/`units` are genuinely unchanged. The
   trusted positive control (service-role write succeeds) was already present in the script as the
   restore step and independently confirms the write path still works for the trusted/engine path.
2. **A new LIVE-R12-05 case was added**: a real `>1000-row real REST pagination proof (spec section
   25's ">1000-economic-result-proof" inventory item), seeding 1,005 real `ii_instrument_identifiers`
   rows for one synthetic instrument on live DEV, with a distinguishing marker at row 1,005. A naive
   single-page real REST read (1,000-row PostgREST cap) misses it (RED); real pagination via repeated
   `limit`/`offset` REST calls recovers the full 1,005 rows and finds the marker (GREEN). Live DEV
   count is now **7 checks** (was 6), still 0 genuine failures.

A real defect in the certification tooling itself was also found and fixed during this same
re-verification pass: the script's cleanup section previously lived at the tail of one linear function
body, so an error thrown mid-script (which genuinely happened once today, from an invalid
`identifier_scheme` value in the new LIVE-R12-05 seed, fixed before the run above) skipped cleanup
entirely, leaving real synthetic users/instruments/accounts on DEV. Found by independently re-querying
DEV after a run and seeing residue the script's own summary claimed was cleaned up. Fixed: the whole
body is now wrapped in `try { ... } finally { cleanup }`, and every individual cleanup delete is
independently wrapped so one failure cannot block the rest. Re-verified: after the fix, a full run's
residue was independently confirmed at exactly 0 R12-named instruments, 0 `r12-*` synthetic test
users, and 0 scale-test identifier rows.

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
| LIVE 22 | Same-user forgery | **DONE** (live GREEN as of 2026-08-27 — 0094 confirmed already applied to DEV; PGlite additionally confirms the post-0092 state) |
| LIVE 23 | Cross-user attack | **DONE** (live + PGlite) |
| LIVE 24 | >1000 rows | **DONE, 2026-08-27** (LIVE-R12-05, live RED→GREEN against real DEV, plus the hermetic scale-matrix proof in `tests/unit/iiR12PaginationScaleCertification.test.ts`) |
| LIVE 25 | Missing/stale market data | Unit-tested only, not live |

**Actual: 5/25 fully live-proven** (LIVE 01, 03, 22, 23, 24), several more partially covered by the
closest available substitute (PGlite real-Postgres verification) — still short of the spec's 25/25
target because most of the equity/ETF-CREATE-through-tax scenarios (LIVE 02, 04-21, 25 in full) need
the actual `manual-entry` API route exercised through a running app against a POST-0092 DEV schema,
which remains genuinely blocked until 0092 is applied (see `docs/dev-apply/ii-r12-0092-activation/`).
This is the single largest honest gap in this round's certification, driven directly by the DDL-access
limitation above — not by remaining effort.

## Independent live reconciliation (spec section 122)

Not separately performed (target was 12/12) — the live-DEV script above IS the live reconciliation for
the 7 scenarios it covers; no additional independent (non-production-code) live reconciliation pass
was run given the round's time budget, and the bulk of section 26's target scenarios (direct
equity/ETF/mixed-portfolio reconciliation against LIVE data) are blocked on 0092 for the same reason
as the LIVE 02/04-21/25 gap above.
