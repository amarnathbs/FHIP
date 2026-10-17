-- Migration 0290 part 5 of 5: old switches and grants. Run the parts in order, one at a time, in the Supabase SQL editor. Each part is safe to run again.
-- The source of truth is the migration file with the same number.
begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. The two earlier two-step switch functions stage lines in a net-value fund, which the rule forbids.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function smsf_switch_to_detailed(p_fund_id uuid) returns numeric as $fn$
begin
  raise exception 'smsf: use smsf_entity_switch_mode() to record the fund as itemised, assets and liabilities are entered as part of the switch'
    using errcode = '0A000';
end;
$fn$ language plpgsql;

create or replace function smsf_switch_to_summary(p_fund_id uuid, p_new_summary_balance numeric, p_new_summary_balance_date date) returns numeric as $fn$
begin
  raise exception 'smsf: use smsf_entity_switch_mode() to record the fund as a net value only'
    using errcode = '0A000';
end;
$fn$ language plpgsql;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Who may call what
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function smsf_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, date, boolean) from public, anon;
revoke all on function smsf_entity_undo_last_switch(uuid, boolean) from public, anon;
revoke all on function smsf_entity_retire_typed_net(uuid, boolean) from public, anon;
revoke all on function smsf_entity_move_linked_loan(uuid, uuid, boolean) from public, anon;
revoke all on function smsf_entity_adopt_register_rows(uuid, uuid[], boolean) from public, anon;
do $fn$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function smsf_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, date, boolean) to authenticated;
    grant execute on function smsf_entity_undo_last_switch(uuid, boolean) to authenticated;
    grant execute on function smsf_entity_retire_typed_net(uuid, boolean) to authenticated;
    grant execute on function smsf_entity_move_linked_loan(uuid, uuid, boolean) to authenticated;
    grant execute on function smsf_entity_adopt_register_rows(uuid, uuid[], boolean) to authenticated;
  end if;
end $fn$;

commit;
