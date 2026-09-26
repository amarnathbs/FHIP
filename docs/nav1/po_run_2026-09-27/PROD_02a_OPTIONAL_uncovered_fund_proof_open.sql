-- =============================================================================
-- NAV 1 (2026-09-27) -- PRODUCTION, OPTIONAL, PO-RUN. Brief P1: "after
-- deployment ... prove [an uncovered instrument] is reached even when more than
-- ten covered instruments sort ahead of it."
--
-- WHAT IT DOES: one UPDATE of one row in ii_nav_history_floors (reference data,
-- not NAV history, not user data). NO DELETE. NO NAV row is touched.
--   Instrument f39ce044-6827-4dde-88dc-02a2499e8c67 (AMFI 103174, Aditya Birla
--   Sun Life) is the LAST of the 17 held funds in instrument_id order: 16
--   covered funds sort ahead of it -- beyond the former first-ten boundary.
--   Its floor is 2006-04-03 (its first AMFI NAV). Moving the floor back to
--   2006-04-01 (= HISTORICAL_FLOOR_DATE) makes the fund "uncovered" for the
--   window [2006-04-01, 2006-04-02] (a weekend: AMFI has no data there).
-- WHAT THE NEXT :00/:30 TICK SHOULD DO (checked by the node script below):
--   examined 17, alreadyCovered 16, needingFetch 1, attempted 1, succeeded 1,
--   the fund's perInstrument outcome 'already_covered' with "history starts
--   2006-04-03"; one row in ii_nav_hydration_attempts for it; 0 NAV rows written.
--   Cost: one small AMFI request for fund house 3, two days, then TIGZIG once.
-- SIDE EFFECT UNTIL RESTORED: the floor keeps the EARLIEST date, so the job
-- will NOT move it back to 2006-04-03 by itself, and every later tick repeats
-- that one small fetch. RUN PROD_02b WITHIN THE SAME HOUR to restore it.
--
-- WHEN: after the monitoring fix (branch fix/nav1-completion-2026-09-27) is
-- deployed, outside 03:00-04:30 UTC, at least 3 minutes before a :00/:30 tick.
-- =============================================================================
do $$
begin
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    raise exception 'REFUSING: not the production project';
  end if;
  if not exists (select 1 from ii_nav_history_floors
                 where instrument_id = 'f39ce044-6827-4dde-88dc-02a2499e8c67' and floor_date = date '2006-04-03') then
    raise exception 'REFUSING: the floor is not in its expected state (2006-04-03); do not proceed, report back';
  end if;
end $$;

update ii_nav_history_floors
   set floor_date = date '2006-04-01'
 where instrument_id = 'f39ce044-6827-4dde-88dc-02a2499e8c67'
   and floor_date = date '2006-04-03'
returning instrument_id, floor_date, confirmed_by, confirmed_at;
-- Expect exactly 1 row returned with floor_date 2006-04-01.
-- Then, after the next :00 or :30 tick (+2 minutes), from the repository:
--   node scripts/nav1_scheduled_proof_check.mjs hydration <this run's UTC time> 17
--   and read the batch: the fund must show as attempted (telemetry.attempted = 1).
