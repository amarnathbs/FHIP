-- =============================================================================
-- NAV 1 (2026-09-27) -- PRODUCTION, PO-RUN. Restores the floor moved by PROD_02a.
-- One UPDATE, no DELETE. Values are those read (GET) on 26 Sep 23:3x UTC.
-- Run as soon as the proof tick has been observed (or at once, to abandon).
-- =============================================================================
do $$
begin
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    raise exception 'REFUSING: not the production project';
  end if;
end $$;

update ii_nav_history_floors
   set floor_date   = date '2006-04-03',
       confirmed_by = 'pc6_selective_hydration',
       detail       = 'no data in [2006-04-01, 2006-04-02]: amfi: AMFI fund house 3 returned no NAV for scheme 103174 in [2006-04-01, 2006-04-02] | fallback tigzig: TIGZIG returned zero observations for 103174 in [2006-04-01, 2006-04-02].',
       confirmed_at = timestamptz '2026-09-24 10:52:05.927+00'
 where instrument_id = 'f39ce044-6827-4dde-88dc-02a2499e8c67'
returning instrument_id, floor_date, confirmed_by, confirmed_at;
-- Expect exactly 1 row: floor_date 2006-04-03, confirmed_at 2026-09-24 10:52:05.927+00.
-- The attempt-ledger row the proof created stays (it is correct history: one
-- real attempt that succeeded); deleting it is never required.
