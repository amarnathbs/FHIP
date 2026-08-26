-- Production verification for migration 0094 (ii_holding_snapshots
-- authoritative-forgery hotfix).
--
-- PART A -- read-only structural checks. Run this first.
-- =============================================================================

select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename = 'ii_holding_snapshots'
order by policyname;
-- EXPECT: exactly one policy, "read own ii_holding_snapshots", cmd = SELECT.
-- No ALL/UPDATE/INSERT/DELETE policy should exist for the authenticated role.

select relrowsecurity, relforcerowsecurity
from pg_class
where relname = 'ii_holding_snapshots' and relnamespace = 'public'::regnamespace;
-- EXPECT: relrowsecurity = true.


-- =============================================================================
-- PART B -- self-cleaning behavioural check (synthetic data only, wrapped in a
-- transaction that always rolls back). Run the 3 statements below in order.
-- =============================================================================

create or replace function verify_0094_hotfix()
returns table(step text, outcome text, detail text) as $$
declare
  v_synthetic_user  uuid := gen_random_uuid();
  v_snapshot_id     uuid;
  v_rows_affected   integer;
  v_actual_value    numeric;
begin
  begin
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change)
    values (v_synthetic_user, 'authenticated', 'authenticated', '__ii_hotfix_verify__@fhip-test.invalid', crypt('x', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '')
    on conflict (id) do nothing;
    step := 'SETUP: auth.users'; outcome := 'OK'; detail := null; return next;
  exception when others then
    step := 'SETUP: auth.users'; outcome := 'FAILED'; detail := sqlerrm; return next;
  end;

  begin
    insert into ii_holding_snapshots (user_id, account_id, instrument_id, value, units, as_of_date)
    select v_synthetic_user, a.id, i.id, 15000, 100, current_date
    from ii_accounts a, ii_instruments i
    limit 1;
    -- If the above needs real account/instrument rows and none exist, this
    -- INSERT will affect 0 rows silently -- check for that explicitly.
    step := 'SETUP: attempted synthetic ii_holding_snapshots row'; outcome := 'ATTEMPTED'; detail := 'if no ii_accounts/ii_instruments rows exist to reference, this step could not create a real fixture -- see note below'; return next;
  exception when others then
    step := 'SETUP: ii_holding_snapshots row'; outcome := 'FAILED (see detail -- may need real account_id/instrument_id values, adjust and rerun manually)'; detail := sqlerrm; return next;
  end;

  select id into v_snapshot_id from ii_holding_snapshots where user_id = v_synthetic_user limit 1;

  if v_snapshot_id is not null then
    -- THE ATTACK: forge the value as the (service-role) session -- this
    -- script runs with elevated SQL Editor privileges, so this specifically
    -- tests the RLS policy shape via pg_policies inspection above (Part A)
    -- is the more reliable proof; this UPDATE below is a supplementary
    -- sanity check only.
    update ii_holding_snapshots set value = 999999999 where id = v_snapshot_id;
    get diagnostics v_rows_affected = row_count;
    select value into v_actual_value from ii_holding_snapshots where id = v_snapshot_id;
    step := 'INFO: elevated-role UPDATE (not a substitute for Part A''s policy check)'; outcome := 'INFO'; detail := 'rows_affected=' || v_rows_affected || ', value now ' || v_actual_value || ' -- this role bypasses RLS by design; Part A''s pg_policies output is the authoritative proof for the authenticated-role restriction';
    return next;
  else
    step := 'B1'; outcome := 'SKIPPED'; detail := 'no synthetic snapshot row created above -- rely on Part A''s structural check as the primary proof for this hotfix'; return next;
  end if;

  return;
end;
$$ language plpgsql;

begin;
select * from verify_0094_hotfix();
rollback;

drop function if exists verify_0094_hotfix();

-- Confirm no synthetic rows survived:
select count(*) as leaked_synthetic_users
from auth.users
where email = '__ii_hotfix_verify__@fhip-test.invalid';
-- EXPECT: 0.
