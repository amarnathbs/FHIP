-- 0298 -- Database guard for the retirement declaration (Document2 (4) PO-D24-02).
--
-- WHY. The grid disables the no retirement savings tick while the person holds an active retirement account or an
-- SMSF, and the two canonical write routes (PUT /api/user/profile and PUT /api/user/section-status) now refuse the same write with a
-- readable 409. A rule that lives only in the application can still be bypassed by any other writer, a direct call to the REST
-- endpoint with the own session of the person included, because the row level security policies let a person update their own rows.
-- This migration puts the SAME rule inside the database so the invariant holds for every writer.
--
-- THE RULE. The declaration cannot BECOME true (a new row already true, or a change that makes a value true that was not) while the person has
--   * an active retirement account (is_active is not false), other than the SMSF fund own mirror row, or
--   * an active SMSF fund.
-- Clearing the declaration is never refused. A declaration that is already true next to an account (saved earlier) is not touched
-- and does not block unrelated edits of the same row: only the transition to true is checked.
--
-- TWO PLACES, ONE RULE. The flag lives in two stores that the application writes together: user_profiles.not_applicable_retirement
-- and a user_financial_section_status row (section retirement, status not_applicable). Each gets a before trigger. The check takes a
-- transaction scoped advisory lock keyed on the person, so two declarations for one person are checked one after the other.
--
-- WHAT THIS DOES NOT DO. It changes no existing row and no existing column, adds no table and no policy, and does not reject
-- anything already saved. Additive, idempotent (safe to run twice), forward-only.

create or replace function public.fhip_retirement_declaration_blockers(p_user uuid)
returns integer
language sql
stable
as $fn$
  select (
    select count(*)
    from public.retirement_accounts ra
    where ra.user_id = p_user
      and ra.is_active is not false
      and ra.master_item_key is distinct from 'smsf'
  )::integer + (
    select count(*)
    from public.smsf_funds sf
    where sf.user_id = p_user
      and sf.is_active is not false
  )::integer;
$fn$;

create or replace function public.fhip_guard_retirement_declaration_profile()
returns trigger
language plpgsql
as $fn$
declare
  v_blockers integer;
begin
  if new.not_applicable_retirement is true
     and (tg_op = 'INSERT' or old.not_applicable_retirement is distinct from true) then
    perform pg_advisory_xact_lock(hashtextextended('fhip_retirement_declaration:' || new.user_id::text, 0));
    v_blockers := public.fhip_retirement_declaration_blockers(new.user_id);
    if v_blockers > 0 then
      raise exception using
        errcode = '23514',
        message = 'RETIREMENT_DECLARATION_CONFLICT: you have ' || v_blockers::text || ' active retirement account or SMSF items, remove or deactivate them before saying you have no retirement savings';
    end if;
  end if;
  return new;
end;
$fn$;

create or replace function public.fhip_guard_retirement_declaration_section()
returns trigger
language plpgsql
as $fn$
declare
  v_blockers integer;
begin
  if new.section = 'retirement' and new.status = 'not_applicable'
     and (tg_op = 'INSERT' or old.section is distinct from 'retirement' or old.status is distinct from 'not_applicable') then
    perform pg_advisory_xact_lock(hashtextextended('fhip_retirement_declaration:' || new.user_id::text, 0));
    v_blockers := public.fhip_retirement_declaration_blockers(new.user_id);
    if v_blockers > 0 then
      raise exception using
        errcode = '23514',
        message = 'RETIREMENT_DECLARATION_CONFLICT: you have ' || v_blockers::text || ' active retirement account or SMSF items, remove or deactivate them before saying you have no retirement savings';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_guard_retirement_declaration_profile on public.user_profiles;
create trigger trg_guard_retirement_declaration_profile
  before insert or update of not_applicable_retirement on public.user_profiles
  for each row execute function public.fhip_guard_retirement_declaration_profile();

drop trigger if exists trg_guard_retirement_declaration_section on public.user_financial_section_status;
create trigger trg_guard_retirement_declaration_section
  before insert or update on public.user_financial_section_status
  for each row execute function public.fhip_guard_retirement_declaration_section();

-- Rollback notes (manual, this repository has no down migration runner). Drop the two triggers named trg_guard_retirement_declaration_profile
-- (on user_profiles) and trg_guard_retirement_declaration_section (on user_financial_section_status), then the three functions
-- fhip_guard_retirement_declaration_profile, fhip_guard_retirement_declaration_section and fhip_retirement_declaration_blockers.
-- Nothing else depends on them and no row was changed by this migration.
