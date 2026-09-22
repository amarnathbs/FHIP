-- NAV 1.25 — statement acceptance integration: race prevention triggered by
-- REAL acceptance events, not a separately-polled queue.
--
-- Forward-only, additive, idempotent.
--
-- MIGRATION NUMBER FRESHNESS. Checked 2026-09-21 (3rd continuation dispatch):
-- this branch's chain -> 0167; origin/main -> 0164;
-- origin/feature/admin-a2-a5-master-execution -> 0165. 0168 is next free.
--
-- APPLICATION STATUS: NOT APPLIED anywhere. Hand-over artefact -- no DDL
-- path from this session to DEV or production (re-confirmed fresh).
--
-- WHY A TRIGGER, NOT A QUEUE TABLE. The selective-hydration job
-- (pc6_selective_historical_hydration, see selectiveHistoricalHydrationJob.ts)
-- is a FULL-RESCAN design -- every invocation re-reads every current
-- ii_portfolio_truth_status/ii_instrument_benchmarks row, exactly like the
-- existing pc6_amfi_daily_nav job re-reads the whole AMFI universe every
-- run. It therefore needs no separate "enqueue this new dependency" step to
-- eventually discover a newly-accepted statement -- its own next scheduled
-- run already will. What a full-rescan design does NOT give you for free is
-- the workbook's own "Race prevention" requirement: the gap between the
-- MOMENT a statement is accepted and the NEXT hydration run is exactly the
-- window in which a concurrent Stage-E cleanup pass could otherwise treat
-- that instrument's older rows as still-uncontested candidates. A trigger
-- closes that gap immediately, at the database layer, regardless of which
-- application code path performed the acceptance.
--
-- WHAT THIS DOES NOT DO. It does not fetch anything, call any adapter, or
-- write to ii_prices_nav. It only inserts a row into the ALREADY-EXISTING
-- ii_nav_retention_holds table (migration 0166) the moment
-- ii_portfolio_truth_status.status transitions INTO ('certified',
-- 'certified_with_warnings'). It never fires on any other status, and never
-- fires on an update that leaves status unchanged (e.g. re-certifying at the
-- same status touches other columns without re-triggering a hold storm).

create or replace function pc6_hold_instrument_on_statement_acceptance() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('certified', 'certified_with_warnings')
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
  then
    insert into ii_nav_retention_holds (instrument_id, reason, expires_at)
    values (
      new.instrument_id,
      'statement_reconciliation_in_progress',
      -- Bounded, not permanent: this hold exists to cover the gap until the
      -- next selective-hydration run picks the dependency up for real, not
      -- to hold an instrument forever if hydration is never enabled. A
      -- human/operator can always extend or convert it to a
      -- 'manual_admin_hold' with no expiry if a longer protection window is
      -- genuinely needed -- this trigger only ever creates the bounded kind.
      now() + interval '30 days'
    );
  end if;
  return new;
end;
$$;
comment on function pc6_hold_instrument_on_statement_acceptance is
  'NAV 1.25/1.39. Fires on ii_portfolio_truth_status certifying a statement;
  creates a bounded (30-day) ii_nav_retention_holds row so a concurrent
  Stage-E cleanup pass cannot treat this instrument as an uncontested
  candidate in the gap before the next selective-hydration run. Never
  fetches, never writes NAV data, never fires on a non-certifying status.';

drop trigger if exists trg_pc6_hold_on_statement_acceptance on ii_portfolio_truth_status;
create trigger trg_pc6_hold_on_statement_acceptance
  after insert or update on ii_portfolio_truth_status
  for each row execute function pc6_hold_instrument_on_statement_acceptance();
