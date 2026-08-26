-- =============================================================================
-- DEV verification script for 0093 (Education Fund / Children
-- Investment -> Goal Linkage).
--
-- HOW TO USE: run this in the DEV Supabase SQL Editor AFTER applying
-- 01_0093_education_children_investment_goal_linkage.sql. Paste the full
-- output back for the record.
--
-- PART A -- pure read-only schema/catalogue checks. Safe, no side effects.
-- PART B -- live behavioural checks (the ownership trigger's rejection
--           behaviour, and the catalogue retirement) that require an actual
--           INSERT attempt to prove the trigger fires. Wrapped in a DO block
--           that always raises an intentional rollback exception at the end,
--           so nothing is persisted regardless of outcome — no real customer
--           data is created, touched, or left behind. Read the RAISE NOTICE
--           lines in the SQL Editor's "Messages"/output pane.
--
-- This script was authored by an agent with NO DDL-execution capability
-- against the hosted DEV project; it has been validated only against
-- PGlite (see scripts/db-rebuild-check/education_goal_linkage.mjs, 32/32
-- passing) and via read-only/live-REST probes (scripts/egl_live_dev_
-- security_probe.mjs, which reproduced the pre-fix vulnerability live
-- against DEV before 0095 was applied there, and now reproduces its
-- fixed/rejecting behaviour). A human must run this in DEV and confirm
-- the results.
-- =============================================================================


-- =============================================================================
-- PART A -- read-only schema/catalogue presence checks
-- =============================================================================

-- A1. Catalogue retirement: education_fund/children_investment are now
-- inactive for NEW selection, with the migration's governance_note attached.
select category, item_key, item_label, is_active, governance_note
from master_financial_items
where category = 'investment' and item_key in ('education_fund', 'children_investment');
-- EXPECT: 2 rows, both is_active = false, governance_note mentioning
-- "Retired from new-investment creation 2026-08-26".

-- A2. Ownership-enforcing trigger function and trigger exist
select proname from pg_proc where pronamespace = 'public'::regnamespace and proname = 'gfs_enforce_ownership';
-- EXPECT: 1 row.

select tgname, tgrelid::regclass as on_table, tgenabled
from pg_trigger
where tgname = 'trg_gfs_enforce_ownership';
-- EXPECT: 1 row, on_table = goal_funding_sources, tgenabled = 'O' (enabled).

-- A3. RLS policy rewrite is in place (WITH CHECK now references goal_id/
-- linked_*_id ownership, not just user_id)
select polname, pg_get_expr(polwithcheck, polrelid) as with_check_expr
from pg_policy
where polrelid = 'goal_funding_sources'::regclass;
-- EXPECT: one policy named "own goal funding sources" whose with_check_expr
-- mentions user_goals/assets/investments/retirement_accounts subqueries, not
-- just "auth.uid() = user_id".

-- A4. Deterministic backfill outcome — informational count only (may
-- legitimately be 0 in production if no user happens to match the exact
-- 4-signal deterministic pattern; this is NOT a pass/fail gate, only a
-- disclosure of what the backfill actually did in production's real data).
select count(*) as backfilled_investment_funding_sources
from goal_funding_sources gfs
join investments i on i.id = gfs.linked_investment_id
where i.master_item_key in ('education_fund', 'children_investment');
-- INFORMATIONAL: report this number back. It is the count of legacy
-- Education Fund / Children Investment investments now linked to a goal
-- (via either the 0093 backfill or the new UI, going forward).

-- A5. Mandatory financial-integrity sanity check — the migration must never
-- have changed any Investments total (linking is planning-layer only).
-- Compare this figure to whatever total Investments reporting shows
-- elsewhere for the same population; it should be identical to before 0093
-- was applied (the migration touches zero rows in the investments table).
select coalesce(sum(current_value), 0) as total_active_investments_value
from investments
where is_active = true;
-- INFORMATIONAL: record this figure immediately after applying 0093 and
-- compare against the equivalent figure captured immediately before, from
-- your own pre-migration baseline query. EXPECT: identical.


-- =============================================================================
-- PART B -- live behavioural checks (self-cleaning: the DO block always ends
-- by raising an intentional exception, so nothing it does is committed).
-- =============================================================================

do $$
declare
  v_user_a       uuid := gen_random_uuid();
  v_user_b       uuid := gen_random_uuid();
  v_goal_a       uuid;
  v_investment_b uuid;
  v_err          text;
begin
  raise notice '--- SETUP: two synthetic users, never committed (this whole DO block is rolled back at the end) ---';

  insert into auth.users (id, email) values
    (v_user_a, '__egl_prod_verify_a__@fhip-test.local'),
    (v_user_b, '__egl_prod_verify_b__@fhip-test.local')
  on conflict (id) do nothing;

  insert into user_goals (user_id, goal_name, goal_type, goal_category, status, target_amount, current_amount, currency_code, target_amount_basis)
  values (v_user_a, '__egl_prod_verify_goal_a__', 'Education', 'education', 'active', 50000, 0, 'AUD', 'today_value')
  returning id into v_goal_a;

  insert into investments (user_id, investment_name, investment_type, current_value, currency_code, owner, is_active)
  values (v_user_b, '__egl_prod_verify_investment_b__', 'etf', 77000, 'AUD', 'self', true)
  returning id into v_investment_b;

  -- B1. FORGED cross-tenant link: Tenant A's own goal + Tenant B's private
  -- investment, submitted with user_id = A. Must be REJECTED by the new
  -- trigger (this DO block runs as a superuser/service context which also
  -- bypasses RLS, exactly like the real ii_goal_allocations.ts admin-client
  -- write path in production — so this specifically proves the TRIGGER,
  -- not RLS, is the operative defense here, matching the live-DEV probe's
  -- own finding that RLS alone would not have caught this).
  begin
    insert into goal_funding_sources (goal_id, user_id, source_type, linked_investment_id, allocated_amount, allocation_percentage, is_active)
    values (v_goal_a, v_user_a, 'investment', v_investment_b, 77000, 100, true);
    raise notice 'B1 FAIL: forged cross-tenant link (A''s goal + B''s investment) should have been rejected but succeeded';
  exception when others then
    get stacked diagnostics v_err = message_text;
    raise notice 'B1 PASS: forged cross-tenant link correctly rejected (%)', v_err;
  end;

  -- B2. NEGATIVE CONTROL: a legitimate same-tenant link (A's own goal + a
  -- freshly-created A-owned investment) must still succeed — proves B1 is
  -- a real ownership rejection, not the trigger blocking everything.
  declare
    v_investment_a uuid;
  begin
    insert into investments (user_id, investment_name, investment_type, current_value, currency_code, owner, is_active)
    values (v_user_a, '__egl_prod_verify_investment_a__', 'etf', 40000, 'AUD', 'self', true)
    returning id into v_investment_a;

    insert into goal_funding_sources (goal_id, user_id, source_type, linked_investment_id, allocated_amount, allocation_percentage, is_active)
    values (v_goal_a, v_user_a, 'investment', v_investment_a, 40000, 100, true);
    raise notice 'B2 PASS: legitimate same-tenant link succeeded (negative control confirms the test is not vacuous)';
  exception when others then
    raise notice 'B2 FAIL (unexpected rejection of a legitimate same-tenant link): %', sqlerrm;
  end;

  raise notice '--- CLEANUP: rolling back the entire transaction now -- nothing above is persisted ---';
  raise exception 'INTENTIONAL_ROLLBACK_DO_NOT_TREAT_AS_A_REAL_ERROR -- forces rollback so no synthetic rows survive';
exception when others then
  if sqlerrm like 'INTENTIONAL_ROLLBACK%' then
    raise notice 'Rollback triggered on purpose -- all synthetic rows above have been discarded.';
  else
    raise notice 'DO block ended on an unexpected error (see message): %', sqlerrm;
  end if;
end $$;

-- If your SQL Editor auto-commits per statement rather than treating the
-- whole pasted script as one transaction, wrap the entire PART B block
-- explicitly in BEGIN; ... (the DO block) ... ROLLBACK; instead.

-- Confirm no synthetic rows survived:
select count(*) as leaked_synthetic_goals from user_goals where goal_name = '__egl_prod_verify_goal_a__';
select count(*) as leaked_synthetic_investments from investments where investment_name like '__egl_prod_verify_investment_%__';
select count(*) as leaked_synthetic_users from auth.users where email like '__egl_prod_verify_%@fhip-test.local';
-- EXPECT: 0 for all three. If not 0, manually delete the synthetic rows
-- (auth.users delete cascades to user_goals/investments/goal_funding_sources)
-- before closing this out — do not leave synthetic data in production.
