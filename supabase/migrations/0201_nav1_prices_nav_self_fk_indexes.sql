-- NAV 1 completion (2026-09-25) -- a Stage E (historical cleanup) PREREQUISITE.
-- Index ii_prices_nav's two self-referencing foreign keys.
--
-- THE PROBLEM. 0155 added
--   superseded_by_id uuid references ii_prices_nav(id)
--   correction_of_id uuid references ii_prices_nav(id)
-- with no index on either column. Deleting ANY ii_prices_nav row makes
-- Postgres check both constraints -- "is any row's superseded_by_id or
-- correction_of_id this id?" -- and with no index each check is a scan of the
-- whole table. Two full scans per deleted row.
--
-- FOUND LIVE on DEV (3.06M rows), 2026-09-25: deleting the 600 oldest rows of
-- one fund (D.11 rehydration proof) was cancelled by the statement timeout.
-- Nothing was deleted (the statement rolled back; the instrument was verified
-- byte-identical afterwards). Production is 22.4M rows: the proposed 10,000-
-- row canary would mean ~20,000 full scans of a 22M-row table, and the full
-- cleanup ~45 million. Stage E cannot run safely -- or at all -- without this.
--
-- THE FIX. Two PARTIAL indexes (only rows where the column is set -- a few
-- corrections, not 22M entries). The foreign-key check's `col = $1` implies
-- `col IS NOT NULL`, so Postgres uses them. They are tiny once built.
--
-- APPLYING (operator decision, stated rather than hidden -- same trade-off as
-- 0167). A plain CREATE INDEX, per this repository's convention, briefly
-- blocks WRITES to ii_prices_nav while it scans the table once per index.
-- Apply outside the daily NAV window (03:30 UTC Tue-Sat) and away from a
-- hydration tick (:00/:30). If even a brief write block is unacceptable, run
-- instead, one statement at a time and OUTSIDE a transaction:
--   create index concurrently if not exists idx_ii_prices_nav_superseded_by_id
--     on ii_prices_nav (superseded_by_id) where superseded_by_id is not null;
--   create index concurrently if not exists idx_ii_prices_nav_correction_of_id
--     on ii_prices_nav (correction_of_id) where correction_of_id is not null;
-- Either form leaves the same index names, so re-running this file after the
-- concurrent form is a no-op.
--
-- Verification: scripts/nav1_0201_pglite_verification.mjs (the FK check's
-- plan uses the index after 0201 and a sequential scan before it).

create index if not exists idx_ii_prices_nav_superseded_by_id
  on ii_prices_nav (superseded_by_id) where superseded_by_id is not null;

create index if not exists idx_ii_prices_nav_correction_of_id
  on ii_prices_nav (correction_of_id) where correction_of_id is not null;

comment on index idx_ii_prices_nav_superseded_by_id is
  'NAV 1 completion (0201). Lets a DELETE on ii_prices_nav check the superseded_by_id self-FK by index instead of '
  'a full-table scan per deleted row. Prerequisite for Stage E historical cleanup.';
comment on index idx_ii_prices_nav_correction_of_id is
  'NAV 1 completion (0201). Lets a DELETE on ii_prices_nav check the correction_of_id self-FK by index instead of '
  'a full-table scan per deleted row. Prerequisite for Stage E historical cleanup.';
