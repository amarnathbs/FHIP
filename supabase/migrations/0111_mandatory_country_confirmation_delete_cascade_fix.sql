-- Mandatory Country Confirmation -- MCC-14 fix (Product Owner review,
-- 2026-08-30). Closes the sole remaining Gate A blocker disclosed in
-- docs/jurisdiction-applicability/
-- Mandatory_Country_Confirmation_Beta_Cleanup_Report_2026-08-29.md
-- section U.
--
-- Migration number note: at the time this was authored, origin/main's head
-- is 0102 plus a since-merged 0106 (0103-0105/0107-0109 are gaps left by
-- other unmerged branches' reservations). This branch itself already owns
-- 0104/0105/0108 (unmerged, local-only). A full scan of every local
-- worktree/branch and every branch on `origin` found every number 0103
-- through 0110 already claimed by something (0103: local, unauthorised
-- fix/g0-wave2-closure-hotfix; 0106: feature/fdh11-au-investment-statement-
-- intelligence, now merged to origin/main; 0107 + 0109:
-- fix/admin-a02-wave1-recommendation-import-integrity, pushed to origin;
-- 0110: local, unmerged feature/module-11-0-ai-foundation). 0111 is the
-- first genuinely free number found across every ref checked
-- (`node scripts/check-migration-versions-against-branch.mjs` run against
-- origin/main, origin/fix/admin-a02-wave1-recommendation-import-integrity,
-- feature/module-11-0-ai-foundation and fix/g0-wave2-closure-hotfix, plus a
-- manual `git ls-tree` scan of all 112 origin branches and every active
-- local worktree for anything in 0103-0119). Recorded in
-- docs/architecture/MIGRATION_REGISTRY.md before this file was written.
--
-- The defect (MCC-14, full detail + live/PGlite reproduction in the report
-- section U): Supabase's own Admin API for user deletion
-- (`DELETE /auth/v1/admin/users/:id`) cascades DELETE across all ~85
-- country-confirmation-backstopped tables PLUS `user_profiles` itself, in
-- one statement, with NO guaranteed cross-table ordering (all of them are
-- SIBLING foreign keys directly referencing `auth.users(id) on delete
-- cascade` -- none of them cascades through `user_profiles`). If
-- `user_profiles` happens to be removed before some other backstopped
-- table's row in the same cascade, `is_country_confirmed()` finds no
-- profile for that table's DELETE trigger and incorrectly raises
-- COUNTRY_CONFIRMATION_REQUIRED against a user who really was confirmed --
-- reproduced live on 3 of 3 affected DEV test users (including a genuinely
-- CONFIRMED one) and independently re-derived from scratch via PGlite.
--
-- The Product Owner rejected a blanket DELETE exemption (it would let any
-- authenticated-but-unconfirmed user directly delete financial records --
-- itself a destructive write that must stay blocked pre-confirmation, per
-- Gap 2's own round-3 closure). The required rule, verbatim from the
-- Product Owner:
--
--   INSERT or UPDATE                                -> require confirmed country
--   DELETE where auth.users row still exists         -> ordinary direct deletion; require confirmed country
--   DELETE where auth.users row no longer exists     -> account-deletion cascade; allow
--
-- This distinguishes "this row's owner's account still exists" (an
-- ordinary, single-row DELETE attempt -- still fully gated) from "this
-- row's owner's account is being destroyed in its entirety right now" (an
-- account-deletion cascade -- can never itself be an "unconfirmed user
-- accessing financial data" violation, because destroying a user's own
-- data as part of destroying the user is not access/exposure).
--
-- Deliberately checks `auth.users` directly, NEVER `user_profiles` --
-- `auth.users` is the actual root of the Admin API's deletion cascade and
-- is unconditionally gone (the statement that triggers the whole cascade
-- IS the deletion of that exact row, which completes before any cascaded
-- child-table delete fires) whenever a real account deletion is underway,
-- regardless of `user_profiles`' own unspecified position in the sibling
-- cascade order -- unlike `user_profiles`, whose deletion order relative to
-- every OTHER backstopped table is exactly the unspecified thing this bug
-- exploits.
--
-- Does NOT exempt service_role, supabase_auth_admin, or DELETE broadly --
-- the exemption is conditioned on nothing but the owning auth.users row's
-- own absence, checked fresh per row via a narrow SECURITY DEFINER helper,
-- independent of which table's trigger fires it or when in the cascade.

-- 1. Narrow, minimal SECURITY DEFINER helper --------------------------------
-- Reads ONLY whether a given id currently exists in auth.users. Nothing
-- else -- no columns are selected, no other table is touched. Not exposed
-- to PostgREST: EXECUTE is revoked from public/anon/authenticated below, so
-- only a SECURITY DEFINER function owned by the same privileged migration
-- role (this one, or the two trigger functions below) can call it; a
-- direct client request can never invoke it.
create or replace function public._mcc_auth_user_exists(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u where u.id = p_user_id
  );
$$;

comment on function public._mcc_auth_user_exists(uuid) is
  'MCC-14 fix (migration 0111): internal-only helper for enforce_country_confirmed()/enforce_country_confirmed_via_twin_run()''s DELETE-path cascade detection. Tells "this row''s owner account still exists" (ordinary direct DELETE, still gated) apart from "this row is part of that same account''s own deletion cascade" (allow) by checking auth.users directly -- never user_profiles, whose cross-table cascade order is exactly what MCC-14 exploited. EXECUTE is revoked from public/anon/authenticated/service_role -- never exposed to PostgREST; callable only by the SECURITY DEFINER trigger functions in this migration, which run as this function''s owner.';

revoke all on function public._mcc_auth_user_exists(uuid) from public;
revoke all on function public._mcc_auth_user_exists(uuid) from anon;
revoke all on function public._mcc_auth_user_exists(uuid) from authenticated;
revoke all on function public._mcc_auth_user_exists(uuid) from service_role;

-- 2. Generic trigger function -- add the DELETE-cascade exception -----------
-- Everything else (service_role bypass, the narrow households INSERT/UPDATE
-- onboarding exemption, the is_country_confirmed() gate itself) is
-- byte-for-byte unchanged from migration 0108 -- only the new early-exit
-- DELETE branch is added.
create or replace function public.enforce_country_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_onboarding_completed boolean;
begin
  if auth.role() = 'service_role' then
    if TG_OP = 'DELETE' then return old; else return new; end if;
  end if;

  v_user_id := case when TG_OP = 'DELETE' then old.user_id else new.user_id end;

  -- MCC-14 fix: a DELETE whose owning auth.users row no longer exists is
  -- part of that same user's own account-deletion cascade -- allow it
  -- unconditionally, regardless of country-confirmation state. Checked
  -- BEFORE the households onboarding exemption and BEFORE
  -- is_country_confirmed() (both of which read user_profiles, the exact
  -- table whose cascade-order-dependent absence caused MCC-14). An
  -- ordinary direct DELETE by a still-existing account falls through
  -- unchanged to the same confirmation gate as before -- this branch does
  -- not fire for it, because _mcc_auth_user_exists() returns true.
  if TG_OP = 'DELETE' and not public._mcc_auth_user_exists(v_user_id) then
    return old;
  end if;

  if TG_TABLE_NAME = 'households' and TG_OP in ('INSERT', 'UPDATE') then
    select up.onboarding_completed into v_onboarding_completed
    from user_profiles up
    where up.user_id = v_user_id;

    if v_onboarding_completed is not true then
      if TG_OP = 'DELETE' then return old; else return new; end if;
    end if;
  end if;

  if not public.is_country_confirmed(v_user_id) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % has not confirmed a supported country of residence', v_user_id
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then return old; else return new; end if;
end;
$$;

comment on function public.enforce_country_confirmed() is
  'Database-level backstop for direct-Supabase-client writes (INSERT/UPDATE/DELETE, whichever an authenticated RLS policy actually grants per table) that bypass the application API/route guard. Onboarding-time exemption: households INSERT/UPDATE only (migration 0108). DELETE-cascade exemption: only when the row''s owning auth.users record no longer exists, i.e. this DELETE is part of that same account''s own deletion cascade, never a broader DELETE/role exemption (migration 0111, MCC-14 fix). Every other case requires a genuinely confirmed country.';

-- 3. Bespoke join trigger (financial_twin_insights /
--    financial_twin_metric_results) -- same DELETE-cascade exception -------
-- Belt-and-braces: this trigger's existing "no matching parent run -> allow"
-- branch (unchanged, still present below) already tolerates the *nested*
-- cascade case where financial_twin_runs itself was deleted first (its own
-- row is gone by the time this table's cascade-delete fires, so the join
-- to it returns no row). But is_country_confirmed() is still called
-- whenever the run row IS found -- reachable if, within the SAME top-level
-- account-deletion statement, this table's row is processed before its
-- parent run's row happens to be (an ordering this migration does not rely
-- on to reason about safety), which still reads user_profiles, the same
-- table whose cascade-order-dependent absence caused MCC-14. Added the
-- identical auth.users existence check as an explicit, ordering-independent
-- guarantee rather than relying on that nested-cascade inference alone.
create or replace function public.enforce_country_confirmed_via_twin_run()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_user_id uuid;
begin
  if auth.role() = 'service_role' then
    if TG_OP = 'DELETE' then return old; else return new; end if;
  end if;

  v_run_id := case when TG_OP = 'DELETE' then old.financial_twin_run_id else new.financial_twin_run_id end;

  select r.user_id into v_user_id
  from financial_twin_runs r
  where r.id = v_run_id;

  if v_user_id is null then
    -- No matching parent run -- not this trigger's concern, the FK
    -- constraint on financial_twin_run_id owns that failure mode (also
    -- covers the nested-cascade case: financial_twin_runs was already
    -- deleted first).
    if TG_OP = 'DELETE' then return old; else return new; end if;
  end if;

  -- MCC-14 fix: same DELETE-cascade exception as enforce_country_confirmed(),
  -- keyed off the resolved owner (via the parent run), not this table's own
  -- (nonexistent) user_id column.
  if TG_OP = 'DELETE' and not public._mcc_auth_user_exists(v_user_id) then
    return old;
  end if;

  -- No onboarding exemption applies to this trigger at all -- these two
  -- tables are never written during onboarding, unlike households -- so,
  -- unlike the shared enforce_country_confirmed() function, there is no
  -- TG_TABLE_NAME/onboarding_completed check here to skip.
  if not public.is_country_confirmed(v_user_id) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % has not confirmed a supported country of residence', v_user_id
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then return old; else return new; end if;
end;
$$;

comment on function public.enforce_country_confirmed_via_twin_run() is
  'Bespoke variant of enforce_country_confirmed() for financial_twin_insights/financial_twin_metric_results, whose owner is resolved via a join to financial_twin_runs rather than an own user_id column. Same MCC-14 DELETE-cascade exemption as the generic function (migration 0111), keyed off the resolved owner''s auth.users row.';

-- professional_notes' bespoke owner-column trigger function
-- (enforce_country_confirmed_professional_notes(), migration 0105) is
-- UNCHANGED and needs no MCC-14 fix: it fires on BEFORE INSERT only (no
-- authenticated UPDATE/DELETE policy exists on professional_notes -- RLS
-- already blocks both, confirmed by scripts/mcc_crud_policy_inventory.mjs),
-- so it can never be reached during a DELETE cascade at all.
--
-- ii_reconciliation_cases, ii_review_items and professional_profiles carry
-- BEFORE UPDATE triggers only (no DELETE policy for any of them) -- same
-- reasoning, no DELETE-path exists to fix.
