# DEV apply package: FDH-10 — Credit Cards & Loans Intelligence (migration 0096)

Prepared by an agent with **no DDL-execution capability against any hosted
Supabase project** (no CLI project link, no reachable SQL-execution RPC, no
connection string anywhere this session could use to apply DDL — same
documented limitation as every prior release's DEV/production migration
step in this repo). This package is for a human to run against DEV.
**Nothing in this package has been applied anywhere. Production is never
touched by this package.**

## What 0096 does (see `docs/financial-data-hub/FDH10_ARCHITECTURE.md` for
the full account)

Additive-only (same discipline as every FDH migration before it — no
existing column, constraint, index, policy, or row is removed):

- Two new tables: `fdh_liability_statements` (one row per uploaded
  credit-card/loan statement) and `fdh_liability_statement_activities` (one
  row per line item — purchase/refund/payment/interest/fee/cash-advance/
  principal, matching `LIABILITY_ACTIVITY_TYPES`).
- Ownership + authoritative-write triggers on both new tables (never a raw
  client UPDATE of `reconciliation_status`/`bank_match_status`), and a third
  trigger widening `liabilities`' own authoritative-write guard to cover the
  new provenance columns (`source_type`, `last_import_application_id`,
  `last_imported_at`).
- Extends the EXISTING FDH-9 `fhip_import_proposals` / `fhip_import_
  applications` bridge with a `source_liability_statement_id` column and a
  `'liability'` branch on the bridge's own ownership/authoritative-write
  guard functions (`create or replace`, in place — no parallel bridge).
- Two callable RPCs: `fdh10_approve_liability_statement(uuid)` and the
  atomic apply RPC `fdh10_apply_liability_proposal(uuid, text, text[])` —
  the ONLY path permitted to mutate a canonical `liabilities` row from
  statement evidence (spec section 53).

## Verified safe before this package was assembled (this session, fresh)

- **Cross-branch migration collision guard** (`scripts/check-migration-
  versions-against-branch.mjs --against=origin/main`): `0096` is still free
  — no collision with `origin/main` (`ba23cd6`) or any other locally-known
  branch's migration lineage. `scripts/check-migration-versions.mjs`: 93
  active migrations, one file per version, next version is `0097`.
- **PGlite clean-rebuild replay** (`scripts/db-rebuild-check/replay.mjs`):
  93/93 migrations apply from empty with zero manual intervention, `0096`
  included, manifest `{tables:194, rls_enabled:194, rls_disabled:0}`.
- **A real statement-ordering defect was found AND fixed** during this
  migration's own certification (commit `a026927`): the bridge-widening
  function in what was originally Part G referenced
  `source_liability_statement_id` before that column existed (it was
  originally added later, in Part H). `create or replace function` validates
  column references at CREATE time, so the original ordering failed with
  `column "source_liability_statement_id" of relation "fhip_import_proposals"
  does not exist`. Fixed by moving the `alter table ... add column`
  statements earlier, to a new Part F.4. This session independently
  reproduced BOTH directions live against PGlite: reverting to the original
  (buggy) ordering reproduces that exact error; restoring the fix passes
  clean again.
- **Chunk-boundary safety**: the 4-chunk package under `../../financial-
  data-hub/migration_0096_chunks/` was re-verified this session —
  reassembling all 4 chunks in order is byte-identical to `supabase/
  migrations/0096_fdh10_credit_cards_loans_intelligence.sql`, and every
  chunk has a balanced (even) count of `$$` dollar-quote delimiters, so no
  function body is split across a chunk boundary, and no chunk ends
  mid-statement.
- **PGlite security certification** (`scripts/fdh10_security_certification.
  mjs`): 18/18 PASS — tenant isolation, forged liability-target rejection,
  forged bank-match rejection, authoritative-field-forgery rejection (with a
  same-tenant negative control proving ordinary fields remain writable),
  atomic apply (including duplicate-apply and cross-tenant-apply rejection),
  and stale-proposal rejection.

## How to apply

1. Open the **DEV** Supabase project's SQL Editor.
2. Capture a pre-migration baseline (row counts are useful, but this
   migration is purely additive — no existing table's data is touched, so
   the main thing worth re-confirming afterwards is that the existing
   `liabilities` table's row count and `balance` values are unchanged):
   ```sql
   select count(*) as n, coalesce(sum(balance), 0) as total_balance
   from liabilities where is_active = true;
   ```
3. Run the four chunk files, **in order**, from `../../financial-data-hub/
   migration_0096_chunks/`:
   `chunk_1_of_4_parts_A_B_C.sql` → `chunk_2_of_4_parts_D_E_F.sql` →
   `chunk_3_of_4_parts_G_H.sql` → `chunk_4_of_4_part_I.sql`.
   (Each chunk is a byte-exact slice of the single migration file — pasting
   all 4 in order has the identical effect to pasting the whole file at
   once; they exist only because Supabase Studio's SQL Editor has a
   practical size limit per paste.)
4. Re-run the baseline query from step 2. It must return an identical
   count and total.
5. Run `02_dev_verification.sql` in this directory (Part A read-only
   structural checks, Part B self-cleaning behavioural checks wrapped in
   `begin; ... rollback;`). Paste the full output back.

## What becomes testable once DEV is confirmed applied

Everything Part 7 of this session's completion report lists as blocked —
live AU/India credit-card and loan E2E journeys, live double-count proof,
live loan decomposition, live drawdown, live no-apply/stale-proposal/
concurrent-apply sequences, live cross-tenant Tenant A/B attacks, live
same-tenant authority-forgery attempts, independent live reconciliation,
and DEV cleanup verification — all require this package applied first.
Applying it is a separate, later, human-executed step; nothing in this
session's work depends on assuming it has already happened.

## Files in this package

- `02_dev_verification.sql` — Part A (read-only schema/RLS/trigger/RPC/
  grant/index checks) + Part B (self-cleaning live behavioural checks,
  `RETURNS TABLE` pattern, `begin; ... rollback;`).
- The migration content itself is NOT duplicated here — see
  `../../financial-data-hub/migration_0096_chunks/` (4 chunks) or
  `supabase/migrations/0096_fdh10_credit_cards_loans_intelligence.sql`
  (single file, byte-identical to the chunks reassembled).
