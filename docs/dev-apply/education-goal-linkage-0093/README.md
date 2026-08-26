# DEV apply package: Education Fund / Children Investment -> Goal Linkage (0093)

Prepared by an agent with **no DDL-execution capability against the hosted
Supabase DEV project** (no CLI project link, no reachable SQL-execution RPC,
no connection string anywhere in this repo/`.env.local` — confirmed again
today, same documented limitation as every prior release's DEV migration
step; see `docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md`'s
finding that this project has never used a migration runner against DEV —
every migration is applied by a human pasting SQL into the Supabase
Dashboard SQL editor). This package is for a human (or the orchestrating
session) to run. **Nothing in this package has been applied to DEV.**

## Confirmed live state (2026-08-26, read-only, service-role + anon REST against
`https://vqycarelcoijzwlpkpcz.supabase.co`, the project referenced by this
repo's own `.env.local`)

| Check | Result |
|---|---|
| `master_financial_items` catalogue: `education_fund` / `children_investment` `is_active` | **`true` for both** — 0093 has NOT been applied |
| `goal_funding_sources` ownership trigger (`gfs_enforce_ownership` / `trg_gfs_enforce_ownership`) | **Already live** — confirmed via a fresh live re-run of `scripts/egl_live_dev_security_probe.mjs`: the forged cross-tenant probe returns `HTTP 403 {"code":"42501", "message":"goal_funding_sources: linked investment ... is not owned by user ..."}`, matching migration `0095`'s own error text exactly |

**This is precisely the scenario spec section 4 asks about**: a
higher-numbered migration (`0095`) is already live on DEV while a
lower-numbered, unrelated-in-effect migration (`0093`) from the same
original bundle has not yet been applied. Per the ADR above, this project's
migration process has **no ordering enforcement at all** (no CLI, no
ledger table ever populated by a hand-pasted SQL Editor run) — applying
`0093` now is exactly as safe as it would have been applied before `0095`
existed, provided (confirmed true — see the migration file's own
"RELATIONSHIP TO 0095" header note) every statement in `0093` remains
idempotent against a database that already has `0095`'s trigger/policy.
`0093`'s own re-run of that trigger/policy is a deliberate, declared-safe
no-op in that case (`create or replace function`, `drop trigger if exists`
+ `create trigger`, `drop policy if exists` + `create policy`).

## Pre-migration DEV baseline (captured 2026-08-26, service-role read-only —
see spec section 9; full detail in the session's final report)

- 10 active purpose-only legacy investment rows: 4 `education_fund`
  (values: ₹850,000; A$30,000; ₹1,600,000; ₹1,056,000), 6
  `children_investment` (values: ₹1,450,000; A$13,500; A$30,000;
  ₹1,344,000; ₹880,000; ₹1,344,000).
- 300 existing `goal_funding_sources` rows, all `is_active=true`, all
  `source_type='investment'` (pre-existing Investment Intelligence /
  manual-UI linkage, unrelated to this migration's backfill).
- 20 active `goal_category='education'` goals.
- Deterministic-backfill audit (reproduced fresh, same 4-signal rule as the
  migration's own `WHERE` clause): of the 10 legacy rows, 0 users have 2+
  legacy investments (ambiguous), 9 users have 0 education-category goals
  (no candidate at all — not "ambiguous", genuinely no goal to link to), 0
  currency mismatches among the remainder, 0 already linked — leaving
  exactly **1 deterministic auto-link candidate**.
- Active Investments total (all users, all currencies): A$38,560,093.21 +
  ₹710,345,539.46 + $35,000.00 USD, 793 active investment rows.

**Before applying**, re-capture these two numbers as your own baseline
(they must be byte-identical after applying, since 0093 never touches
`investments.current_value`, `is_active`, or row count):

```sql
select coalesce(sum(current_value),0) as total, count(*) as n
from investments where is_active = true; -- group by currency_code if you want the split
```

## How to apply

1. Open the **DEV** Supabase project's SQL Editor (project ref extracted
   from `NEXT_PUBLIC_SUPABASE_URL` in `.env.local`:
   `vqycarelcoijzwlpkpcz`).
2. Run the baseline query above and save the result.
3. Run `supabase/migrations/0093_education_children_investment_goal_linkage.sql`
   in full (it is self-contained, `begin; ... commit;`, and idempotent).
4. Immediately re-run the baseline query. It must return an identical
   total and row count.
5. Run `02_dev_verification.sql` (same structure as the production
   verification script this session already prepared at
   `docs/production-apply/education-goal-linkage-0093/02_production_
   verification.sql` — Part A read-only, Part B self-cleaning/rolled-back).
   Paste the full output back.
6. Optionally re-run `node scripts/egl_live_dev_security_probe.mjs` — it
   should now report the SAME rejection it already reports today (0095's
   trigger), plus this confirms 0093 didn't regress it.

## What happens next in this session once DEV is confirmed applied

Sections 13-31 and 37 of the spec (live DEV UI linking, bidirectional
relationship, live funding value, allocation cap, Net Worth hard gate,
catalogue display, forecasting/twin/reports/dashboard, populated-DEV
upgrade) all become testable against real applied DEV state. Everything
that does NOT depend on `0093` specifically — the `goal_funding_sources`
relationship (already exists since migration `0009`), the `0095` ownership
trigger (already live), and the application-layer UI/allocation-cap code
(already merged onto this feature branch, not gated by `0093`) — was
already tested live against DEV in this same session and is reported as
such in the final report, independent of this gate.

## Files in this package

- `02_dev_verification.sql` — Part A (read-only schema/catalogue checks) +
  Part B (self-cleaning live behavioural checks). Content-identical to the
  production verification script (the check is environment-agnostic); the
  only difference is this one is meant to run against DEV first.
