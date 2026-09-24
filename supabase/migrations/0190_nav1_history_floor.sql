-- NAV 1 Stage D (D.4 prerequisite) — a confirmed "history starts here" date
-- per instrument, so on-demand hydration stops re-requesting history that
-- does not exist.
--
-- THE PROBLEM. Hydration fetches a held instrument's history back to AMFI's
-- own floor (2006-04-01), newest window first, and stops at the first window
-- with no data. For a fund launched in, say, 2018, the window just before
-- launch is ALWAYS empty -- so every run requested it again, forever. With
-- TIGZIG as the only source that was one small per-scheme request per run.
-- With AMFI as the primary source (D.3) it is a fund-house download of up to
-- ~20 MB, per held fund, per run -- and hydration is intended to run every
-- 15-30 minutes.
--
-- THE FIX. The first time hydration walks past the start of an instrument's
-- history, it records the earliest date that has data. Later runs never ask
-- for anything before it.
--
-- WHEN A FLOOR IS RECORDED -- deliberately narrow, because a wrong floor
-- permanently stops fetching older history:
--   * the source reports NOT_FOUND for a window -- with AMFI primary and
--     TIGZIG fallback that means BOTH said so (fallbackHistoricalAdapter.ts
--     only reports not_found when both agree), AND
--   * data for the instrument already exists NEWER than that window, so the
--     empty window is genuinely before the start rather than a sign that the
--     scheme is simply unknown.
-- A not_found with no data anywhere records nothing (an unknown scheme is
-- not frozen out). A real error -- HTTP failure, rate limit -- records
-- nothing.
--
-- KNOWN LIMIT, stated rather than hidden: a scheme suspended for longer than
-- one hydration chunk (730 days) would look like it started at resumption,
-- and its pre-suspension history would not be fetched. Rare for any scheme a
-- user holds. The remedy is to delete the row: hydration then walks back
-- again on its next run.
--
-- RESETTING. Deleting an instrument's row is always safe -- the only cost is
-- that the next hydration run re-discovers the floor. Nothing else reads it.
--
-- NOT RETENTION. The floor only bounds what hydration FETCHES. Retention
-- (pc6_nav_row_is_candidate) never consults it: a held instrument's whole
-- history is kept regardless.
--
-- ACCESS. Global reference data about an instrument -- no user column, no
-- user's holdings. Same shape as ii_nav_retention_holds (0166): the service
-- role writes (hydration runs with it and bypasses RLS); reads are limited to
-- reference-data admins.

create table if not exists ii_nav_history_floors (
  instrument_id uuid primary key references ii_instruments(id) on delete cascade,
  floor_date date not null,
  confirmed_by text not null,
  detail text,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table ii_nav_history_floors enable row level security;

drop policy if exists "admin read ii_nav_history_floors" on ii_nav_history_floors;
create policy "admin read ii_nav_history_floors" on ii_nav_history_floors
  for select using (is_pc6_reference_data_admin());

comment on table ii_nav_history_floors is
  'NAV 1 Stage D (0190). Earliest date with NAV data for an instrument, confirmed by selective hydration '
  'when both providers report nothing older while newer data exists. Hydration never requests earlier '
  'than this. Deleting a row is always safe: the next run re-discovers it. Not consulted by retention.';
comment on column ii_nav_history_floors.floor_date is
  'Earliest date with NAV data. Hydration''s required-from date is max(its own requirement, this).';
comment on column ii_nav_history_floors.confirmed_by is
  'What recorded the floor, e.g. pc6_selective_hydration.';
