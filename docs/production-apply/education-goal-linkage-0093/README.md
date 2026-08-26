# Production apply package: Education Fund / Children Investment -> Goal Linkage (0093)

Prepared by an agent with **no ability to execute SQL against production**
and **no authorization to push to `origin/main` or merge to `main`**.
Everything in this folder is for a human (or the orchestrating session,
after independently re-verifying the work) to run. Nothing here has been
applied to production.

## Ledger (confirmed 2026-08-26 via read-only publishable-key REST probes with negative controls against `app.financialhealthplatform.com`'s live production Supabase — project ref `twwpnltizhtjxhamyoxt`, extracted from the site's own public JS bundle, never guessed or supplied by the user)

| Item | DEV status | Production status | Action needed |
|---|---|---|---|
| `0093_education_children_investment_goal_linkage.sql` | **NOT applied** (this sandbox has no DDL-execution capability — no psql, no Docker, no SQL-execution RPC; same documented limitation as every prior release's DEV migration step) — fully certified against PGlite instead (32/32, real Postgres 18/WASM engine, real RLS + real trigger) | **NOT applied** — confirmed live: `master_financial_items` still returns `is_active: true` for both `education_fund` and `children_investment`, with migration 0074's original governance_note verbatim (i.e. production has 0072-0074 but not 0093) | Apply `01_0093_education_children_investment_goal_linkage.sql` to DEV first, then to production, in that order |
| Cross-tenant `goal_funding_sources` ownership gap this migration fixes | Confirmed **live and real** on DEV via `scripts/egl_live_dev_security_probe.mjs` — a forged insert (Tenant A's own goal + Tenant B's private investment, submitted under Tenant A's own JWT) returned HTTP 201 (succeeded) against DEV's current pre-0093 schema | Not independently reproduced against production (would require creating throwaway auth users against production, which this agent is not authorized to do) — but production runs the byte-identical `goal_funding_sources` schema/RLS policy from migration 0009 with no later ownership fix, so the same gap is presumed present until 0093 is applied there too | Apply 0093 to close it in both environments |

Prerequisite tables (`user_goals`, `goal_funding_sources`, `investments`,
`master_financial_items`) **are already present** in production (confirmed:
all four return HTTP 200 via anon/publishable-key REST, correctly returning
empty results for the three user-scoped tables — RLS is working as
intended — and real catalogue rows for the public one), so 0093 has no
missing dependency and can be applied as-is.

## How to apply

1. Open the production Supabase project's SQL Editor.
2. **Before applying**, capture a baseline: `select coalesce(sum(current_value),0) from investments where is_active=true;` (total active Investments value) and `select count(*) from investments where master_item_key in ('education_fund','children_investment') and is_active=true;` (legacy purpose-only record count). Save both numbers.
3. Run `01_0093_education_children_investment_goal_linkage.sql` in full. It is self-contained (`begin; ... commit;`) and idempotent (every statement is a plain `UPDATE`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS`/`CREATE POLICY`, or an `INSERT ... SELECT` guarded by `NOT EXISTS`).
4. Immediately re-run the two baseline queries from step 2. **Both must return byte-identical numbers to the pre-migration baseline** — this migration never changes an investment's `current_value`, `is_active` state, or row count; it only changes catalogue `is_active` (for new-entry offering, not existing rows) and adds Goal-linkage rows in a *different* table (`goal_funding_sources`).
5. Run `02_production_verification.sql` (Part A first — read-only; Part B second — self-cleaning, wrapped in a `DO` block that always raises an intentional rollback exception, and the script's own final `SELECT`s confirm zero synthetic rows survived). Paste the full output back.
6. Optionally cross-check with `node scripts/egl_live_dev_security_probe.mjs` pointed at production credentials (temporarily, never committed) as an independent live-REST re-confirmation that the forged cross-tenant insert now fails — mirrors exactly what was already proven against DEV.

## What was and was not verified by the agent

- **Verified (read-only, publishable-key REST, negative-controlled) against live production:**
  - Current `is_active: true` state of both retired catalogue items (proving 0093 has not yet landed there).
  - RLS correctly blocks anonymous reads of `user_goals`, `investments`, and `goal_funding_sources` (all return `[]`), confirming per-user legacy-record counts on production are **not determinable** via this read-only method — an honest limitation, not an oversight. Production's actual Education Fund / Children Investment record count can only be obtained by a human with production database console access running a `count(*)` query themselves.
  - Presence of all four prerequisite tables.
- **Verified (PGlite — real PostgreSQL 18/WASM, not a simulation) on an equivalent fresh schema:**
  - 32/32 checks in `scripts/db-rebuild-check/education_goal_linkage.mjs`: the deterministic-backfill decision logic (including 4 negative cases: ambiguous/no-goal/currency-mismatch/already-linked), $0 unexplained financial variance across the backfill, the ownership trigger's rejection of forged cross-tenant references (with a negative control disabling both RLS and the trigger to prove the overall test is not vacuous), and all 9 of the spec's worked financial-integrity test cases (simple/partial/multi-holding/multi-goal/archive/multi-currency).
  - Full-chain clean rebuild (88/88 migrations) and the two pre-existing certification suites (Property↔Liability 41/41, general RLS coverage 25/25) reproduced with zero regressions.
- **Verified live against DEV (real Supabase project, real throwaway auth users, real JWTs, real PostgREST calls — not simulated):** `scripts/egl_live_dev_security_probe.mjs` reproduced the actual pre-0093 vulnerability (forged cross-tenant `goal_funding_sources` insert succeeds today) plus a negative control proving the harness itself is sound.
- **NOT performed by the agent — requires human/orchestrator execution:**
  - Actually applying `01_0093...sql` to DEV or to production.
  - The live behavioural checks in `02_production_verification.sql` Part B (the ownership trigger's rejection under a real INSERT against production, and the catalogue-retirement check) — these require mutating statements against DEV/production, outside this agent's authorization and technical ability in this environment. The script is self-cleaning (rolls back its own transaction) but must be run by a human.
  - Merging this branch (`feature/education-goal-linkage`) into `main` — reserved for the orchestrating session per this project's standing policy.

## Files in this package

- `01_0093_education_children_investment_goal_linkage.sql` — the migration itself (identical to `supabase/migrations/0093_education_children_investment_goal_linkage.sql` on the feature branch).
- `02_production_verification.sql` — Part A (read-only schema/catalogue checks) + Part B (self-cleaning live behavioural checks).
