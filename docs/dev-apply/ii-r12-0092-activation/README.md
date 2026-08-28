# DEV apply package: II-R12 Wider India Assets (migration 0092)

## 2026-08-28 re-verification note

Re-checked fresh in a new dispatch, from a brand-new worktree off `origin/main` (which had moved to
`ba23cd6` by this point -- an unrelated parallel task's own `taxRepository.ts` fix, not touching
anything in this package). This dispatch has **no `.env.local` of its own** (confirmed: only
`.env.example` exists in the fresh worktree) and so could not re-run the live read-only REST checks
below itself -- they are preserved as the prior session's genuine, dated evidence, not re-verified live
by this dispatch. What WAS independently re-verified fresh this dispatch: a full migration-chain PGlite
replay (92/92, 0 failures) including `0092` immediately before `0094` with zero errors, and
`02_dev_verification.sql` was rewritten (2 real bugs fixed: a wrong column name in two of the Part B
probes, and `pg_policies.polname` -> `.policyname`) and then actually EXECUTED against that fresh
rebuild for the first time -- see that file's own revision note. `0092` is still confirmed unapplied to
any hosted environment (no contrary evidence found; see the collision-guard and ground-truth sections of
the final response for this dispatch).

Prepared by an agent with **no DDL-execution capability against the hosted Supabase DEV project** (no
CLI project link, no reachable SQL-execution RPC, no connection string anywhere in this repo /
`.env.local` — confirmed again today: `SUPABASE_SERVICE_ROLE_KEY`/`NEXT_PUBLIC_SUPABASE_URL` exist for
REST access only, no `access_token`/`db_password`/`project_ref`, and `npx supabase` has no session to
act as). Same documented limitation as every prior release's DEV migration step (see
`docs/dev-apply/education-goal-linkage-0093/README.md` and
`docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md`'s finding that this project has never used
a migration runner against DEV — every migration is applied by a human pasting SQL into the Supabase
Dashboard SQL editor). **Nothing in this package has been applied to DEV.**

## Confirmed live state (2026-08-27, read-only, service-role REST against
`https://vqycarelcoijzwlpkpcz.supabase.co`, the project referenced by this repo's own `.env.local`)

| Check | Result |
|---|---|
| `ii_holding_snapshots.price_source` column | **Does NOT exist** (`42703 column ii_holding_snapshots.price_source does not exist`) — 0092 has NOT been applied to DEV |
| `ii_transactions.transaction_type` observed live values | `purchase` (51), `redemption` (39), `switch_out` (3), `switch_in` (3) — no `sale` rows exist yet (consistent with 0092 not applied; the app cannot legally write `sale` until the constraint is widened) |
| `ii_scheme_tax_classification.basis` observed live values | `computed_from_holdings` (36), `known_debt_specified_category` (1), `unresolved_no_data` (1) — no `direct_listed_security_rule` rows exist yet |
| `ii_holding_snapshots` row count | **0** (empty table on DEV right now — nothing to protect/regress in this specific table beyond the RLS policy itself) |
| `ii_transactions` row count | 96 |
| `ii_scheme_tax_classification` row count | 38 |
| `ii_instruments` row count | 189 |
| **0094 (same-user holding forgery fix)** | **Already live on DEV**, independently of 0092 — a fresh live reproduction today (`scripts/r12_live_dev_verification.mjs` LIVE-R12-02) confirms a same-user PATCH attempting to forge `value`/`units` on an owned `ii_holding_snapshots` row returns HTTP 200 (PostgREST's normal "matched, nothing writable" response under the SELECT-only owner policy) with the persisted value genuinely unchanged — verified by an independent service-role read, not inferred from HTTP status alone. This means Stage A step 7's hard gate is **already independently proven pre-0092** on the live baseline; applying 0092 must not regress it (0092 itself contains zero DDL for this table/policy — see the migration file's own header — so there is no mechanism by which it could). |

## Dollar-quote and structural sanity check (performed before handoff, per hard rule 3)

`supabase/migrations/0092_ii_r12_wider_india_assets_foundation.sql`: 133 lines, SHA-256
`8437d0eaddf782361391b7d4f44421d8a14cdd28dee92ecaffc89db4c0eb9df5`. Zero `$$` dollar-quote pairs in the
file (it contains no functions/triggers — verified: `grep -o '\$\$' | wc -l` = 0, trivially balanced).
The file is 4 plain `alter table` / `comment on column` statements plus a documentation-only no-op
section (section 1 — see the file's own header for why: its RLS fix was extracted and shipped
separately as migration `0094`, already live). A full-stack PGlite replay of ALL 92 current migrations
in order (0001 through 0095, run today from a completely empty database) applies `0092` immediately
before `0094` with **zero errors** — this is the strongest evidence available short of a real DEV
apply that this file is safe to paste as-is.

## How to apply

1. Open the **DEV** Supabase project's SQL Editor (project ref extracted from
   `NEXT_PUBLIC_SUPABASE_URL` in `.env.local`: `vqycarelcoijzwlpkpcz`).
2. Optionally re-run the baseline queries above yourself first (row counts / column existence) to
   confirm nothing has changed since this package was prepared.
3. Run `supabase/migrations/0092_ii_r12_wider_india_assets_foundation.sql` in full. It is NOT wrapped
   in an explicit `begin;...commit;` block (unlike 0093) — every statement is independently
   `if not exists`/`drop ... if exists`-guarded (`add column if not exists`, `drop constraint if
   exists`), so it is safe to run as a single paste and safe to re-run if it is ever accidentally run
   twice.
4. Run `02_dev_verification.sql` (in this same folder) immediately after. Part A is read-only schema
   checks; Part B is a self-cleaning transactional probe (wrapped in `begin;...rollback;`, so it leaves
   no residue) that proves the new column/constraint values are genuinely writable, invalid values are
   still rejected, and the pre-existing mutual-fund path is unaffected. Paste the full output back.
5. Re-run `node scripts/r12_live_dev_verification.mjs` from a checkout with `.env.local` present — it
   should now additionally exercise the post-0092 schema (this session's copy already runs the
   pre-0092-safe subset and reports 7/7 clean; a repeat run after 0092 is applied is expected to keep
   those 7 green and should be extended with the equity/ETF-creation-specific cases this package's
   companion report lists as blocked).
6. Report back: did `02_dev_verification.sql` Part A show all 4 expected schema states? Did every
   Part B `raise notice` read `PASS`? Did Part C's two `should_be_zero` counts both read 0 (confirming
   the rollback left no residue)?

**Important, per this session's own hard-rule instruction**: if you report "ran with no error," the
next session should independently re-verify via read-only REST (the exact column-existence check in
the table above) before trusting it — this "no error but nothing landed" failure mode has happened
before with other migrations in this project's history.

## What happens next once DEV is confirmed applied

Stage A steps 6-8 (verify actual schema, verify 0094 not weakened, verify existing MF compatibility)
and the blocked live-DEV/independent-live-reconciliation inventory in
`R12_LIVE_DEV_VERIFICATION.md` (LIVE 02, 04-21, 25 and most of section 26) all become testable. None of
the deterministic/oracle/manual-reconciliation/negative-control certification already completed this
round (336 cases, 1,212 atomic comparisons, 20/20, 7/8) depends on 0092 being live — that work is
final regardless of when DEV is migrated.

## Files in this package

- `02_dev_verification.sql` — Part A (read-only schema checks) + Part B (self-cleaning transactional
  functional probes, `begin;...rollback;`) + Part C (residue check).
