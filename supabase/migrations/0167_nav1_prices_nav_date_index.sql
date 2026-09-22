-- NAV 1.40 — performance budgets: a real, live-DEV-discovered index gap.
--
-- Forward-only, additive, idempotent.
--
-- MIGRATION NUMBER FRESHNESS. Checked 2026-09-21 (continuation dispatch):
-- this branch's chain -> 0166 (this migration's own predecessor);
-- origin/main -> 0164; origin/feature/admin-a2-a5-master-execution -> 0165.
-- 0167 is the next free number given those three.
--
-- APPLICATION STATUS: NOT APPLIED anywhere. Hand-over artefact — this
-- session has no DDL path to DEV or production (re-confirmed fresh this
-- continuation via scripts/pc5_ddl_capability_probe.mjs against DEV).
--
-- WHY THIS EXISTS — a REAL finding, not a speculative optimisation.
-- `ii_prices_nav`'s only index (migration 0033) is the composite UNIQUE
-- (instrument_id, price_date) — there is no index usable for a query that
-- filters or counts by price_date ALONE, which is exactly the access
-- pattern this whole NAV 1 programme needs constantly: "how many rows are
-- before/after the changeover date", "what's the coverage in this date
-- window across many instruments", the NAV 1.42 candidate-manifest
-- headline sizing, and NAV 1.27's daily-coverage checks. Measured LIVE
-- against DEV's real 3,058,764-row table this continuation dispatch:
--   * `select count(*) ... where price_date >= '2026-09-21'` timed out
--     (57014 "canceling statement due to statement timeout") while the
--     `price_date < '2026-09-21'` direction on the SAME table succeeded —
--     an asymmetry consistent with a full/partial index scan that
--     degrades once the planner can't use the composite index's leading
--     instrument_id column to narrow anything.
--   * A paginated, date-filtered read (`price_date` BETWEEN two dates,
--     high OFFSET) also hit the same statement-timeout error partway
--     through.
-- DEV is 3.06M rows; production was measured at 6.26GB+ before the backfill
-- was paused (this session has no production credentials to get an exact
-- row count, but it is a materially larger table). These same query shapes
-- will be slower there, not faster — this index should land BEFORE any
-- production-scale NAV 1.42 candidate-manifest run or NAV 1.27 coverage
-- check, not after one times out in production.
--
-- CONCURRENTLY vs plain -- a deliberate choice, made and then REVERSED
-- during this migration's own drafting, kept here because the reasoning
-- is worth preserving. `create index concurrently` avoids the write-lock a
-- plain `create index` takes for the build duration, which matters on a
-- table the live `pc6_amfi_daily_nav`/`pc6_amfi_scheme_master` jobs write
-- to continuously -- but it CANNOT run inside a transaction block, and this
-- session verified LIVE (via the repository's own PGlite full-chain-replay
-- verification technique, the same one every PC6/NAV1 migration in this
-- programme is checked with) that it fails there with exactly that error:
-- "CREATE INDEX CONCURRENTLY cannot run inside a transaction block". No
-- other migration in this entire repository's history uses CONCURRENTLY
-- (grepped fresh, zero matches) -- this repo's own established convention
-- and apply tooling assumes a plain, transaction-compatible statement. This
-- migration follows that convention rather than introducing a one-off
-- apply path an operator would have to discover by a failed run. The
-- trade-off is real and disclosed: applying this WILL briefly hold a
-- write lock on ii_prices_nav for the index-build duration. On DEV's
-- 3.06M-row table this is expected to be on the order of seconds; on
-- production's larger table it will take longer. Apply during a
-- low-traffic window, or have the operator manually run the CONCURRENTLY
-- form outside this migration's transaction if production traffic makes
-- even a brief lock unacceptable -- that operational decision belongs to
-- whoever applies this, not to this file.
create index if not exists idx_ii_prices_nav_price_date
  on ii_prices_nav (price_date);
comment on index idx_ii_prices_nav_price_date is
  'NAV 1.40. Added because ii_prices_nav had no index usable for a
  price_date-only filter/count -- the exact access pattern the NAV 1
  candidate-manifest (1.42) and daily-coverage (1.27) checks use constantly.
  Measured live: a price_date>=X count timed out on DEV''s 3.06M-row table
  before this index existed. A plain (non-CONCURRENT) index, matching this
  repository''s own established migration convention -- briefly locks
  ii_prices_nav for writes during the build; see this file''s own header.';
