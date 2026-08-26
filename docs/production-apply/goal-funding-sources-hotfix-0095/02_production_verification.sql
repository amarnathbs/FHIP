-- Production verification for migration 0095 (goal_funding_sources
-- authoritative-forgery hotfix).
--
-- PART A -- read-only structural checks. Run this first.
-- =============================================================================

select proname
from pg_proc
where pronamespace = 'public'::regnamespace and proname = 'gfs_enforce_ownership';
-- EXPECT: 1 row.

select tgname, tgrelid::regclass as on_table, tgenabled
from pg_trigger
where tgname = 'trg_gfs_enforce_ownership';
-- EXPECT: 1 row, tgenabled = 'O' (enabled).

select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies
where tablename = 'goal_funding_sources'
order by policyname;
-- EXPECT: one policy, "own goal funding sources", cmd = ALL, and with_check
-- should now mention goal_id/linked_asset_id/linked_investment_id/
-- linked_retirement_id ownership subqueries (not just "auth.uid() = user_id"
-- alone).


-- =============================================================================
-- PART B -- self-cleaning behavioural check (synthetic data only, wrapped in
-- a transaction that always rolls back). Run the 3 statements below in order.
-- =============================================================================

create or replace function verify_0095_hotfix()
returns table(step text, outcome text, detail text) as $$
declare
  v_user_a  uuid := gen_random_uuid();
  v_user_b  uuid := gen_random_uuid();
  v_goal_a  uuid;
  v_inv_b   uuid;
begin
  begin
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change)
    values
      (v_user_a, 'authenticated', 'authenticated', '__gfs_hotfix_a__@fhip-test.invalid', crypt('x', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', ''),
      (v_user_b, 'authenticated', 'authenticated', '__gfs_hotfix_b__@fhip-test.invalid', crypt('x', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', false, '', '', '', '')
    on conflict (id) do nothing;
    step := 'SETUP: two synthetic auth.users'; outcome := 'OK'; detail := null; return next;
  exception when others then
    step := 'SETUP: auth.users'; outcome := 'FAILED'; detail := sqlerrm; return next;
  end;

  insert into user_goals (user_id, goal_name, goal_type, goal_category, status, target_amount, current_amount, currency_code, target_amount_basis)
  values (v_user_a, '__gfs_hotfix_goal_a__', 'Education', 'education', 'active', 50000, 0, 'AUD', 'today_value')
  returning id into v_goal_a;
  step := 'SETUP: Tenant A goal'; outcome := 'OK'; detail := 'id ' || v_goal_a; return next;

  insert into investments (user_id, investment_name, investment_type, current_value, currency_code, owner, is_active)
  values (v_user_b, '__gfs_hotfix_inv_b__', 'etf', 50000, 'AUD', 'self', true)
  returning id into v_inv_b;
  step := 'SETUP: Tenant B private investment'; outcome := 'OK'; detail := 'id ' || v_inv_b; return next;

  -- THE ATTACK: Tenant A's own goal, forged to reference Tenant B's private
  -- investment. This SQL Editor session runs with elevated privileges (not
  -- the `authenticated` PostgREST role), so this specifically tests the
  -- TRIGGER (which fires regardless of role) -- Part A's pg_policies output
  -- is the authoritative proof for the RLS-layer restriction under a real
  -- user JWT.
  begin
    insert into goal_funding_sources (goal_id, user_id, source_type, linked_investment_id, allocated_amount, allocation_percentage, is_active)
    values (v_goal_a, v_user_a, 'investment', v_inv_b, 999, 50, true);
    step := 'ATTACK: forge cross-tenant link via elevated role'; outcome := 'SUCCEEDED (unexpected)'; detail := 'the trigger did not fire for this role -- investigate'; return next;
  exception when others then
    step := 'ATTACK: forge cross-tenant link via elevated role'; outcome := 'BLOCKED (PASS)'; detail := sqlerrm; return next;
  end;

  return;
end;
$$ language plpgsql;

begin;
select * from verify_0095_hotfix();
rollback;

drop function if exists verify_0095_hotfix();

-- Confirm no synthetic rows survived:
select count(*) as leaked_synthetic_users
from auth.users
where email in ('__gfs_hotfix_a__@fhip-test.invalid', '__gfs_hotfix_b__@fhip-test.invalid');
-- EXPECT: 0.
