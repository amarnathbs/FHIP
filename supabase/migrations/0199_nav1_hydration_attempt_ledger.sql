-- NAV 1 completion (2026-09-25), brief P1 -- a per-instrument hydration attempt
-- ledger, so the fetch budget goes to the instruments that have waited longest.
--
-- THE PROBLEM. 7fe349e made maxInstruments bound fetches rather than coverage
-- checks, but the instruments needing a fetch were still taken in a FIXED
-- order (instrument_id). Ten funds that fail on every run -- an AMFI block,
-- a withdrawn scheme, a timeout -- would take the whole budget on every run,
-- and a fund sorted after them would never be reached.
--
-- THE FIX. Hydration records every fetch attempt here and orders its work
-- never-attempted first, then least recently attempted. An attempt, whatever
-- its outcome, moves the instrument to the back of the queue, so with N
-- instruments needing a fetch and a budget of B every one is attempted within
-- ceil(N / B) runs.
--
-- DEPLOY ORDER. The code tolerates this table's absence: if it cannot be read
-- the job falls back to a rotating order (seeded by the 30-minute tick) and
-- reports ordering = 'rotation_fallback' in the batch's notes.telemetry. So
-- the code may deploy before this migration is applied.
--
-- RESETTING. Deleting rows is always safe: an instrument with no row is
-- treated as never attempted and goes to the front of the queue. Nothing else
-- reads this table; retention (pc6_nav_row_is_candidate) never consults it.
--
-- ACCESS. Global reference data about an instrument -- no user column, no
-- user's holdings. Same shape as ii_nav_history_floors (0190): the service
-- role writes (hydration runs with it and bypasses RLS); reads are limited to
-- reference-data admins.
--
-- NUMBERING. 0195-0197 are taken by feat/aie1-final-production-completion and
-- 0198 by the local branch fix/fdh10-liability-zero-amount-atomic (scan of
-- every local and remote branch, 2026-09-25). No shared constraint is touched.

create table if not exists ii_nav_hydration_attempts (
  instrument_id uuid primary key references ii_instruments(id) on delete cascade,
  last_attempted_at timestamptz not null,
  last_outcome text not null check (last_outcome in (
    'hydrated', 'already_covered', 'partially_hydrated', 'fetch_failed', 'unresolvable_identifier'
  )),
  last_detail text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  attempts_total integer not null default 1 check (attempts_total >= 1),
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ii_nav_hydration_attempts_last_attempted
  on ii_nav_hydration_attempts(last_attempted_at);

alter table ii_nav_hydration_attempts enable row level security;

drop policy if exists "admin read ii_nav_hydration_attempts" on ii_nav_hydration_attempts;
create policy "admin read ii_nav_hydration_attempts" on ii_nav_hydration_attempts
  for select using (is_pc6_reference_data_admin());

comment on table ii_nav_hydration_attempts is
  'NAV 1 completion (0199). Last selective-hydration fetch attempt per instrument. Hydration spends its '
  'per-run budget never-attempted first, then least recently attempted, so instruments that keep failing '
  'cannot starve the rest. Deleting a row is always safe (the instrument is treated as never attempted). '
  'Not consulted by retention.';
comment on column ii_nav_hydration_attempts.consecutive_failures is
  'Failed attempts since the last success (hydrated or already_covered). 3+ is reported as persistently failing.';
