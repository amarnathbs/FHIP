-- G5B follow-up fix: MCC-14 DELETE-cascade exemption was missing from
-- enforce_write_permitted_g5b() (migration 0129).
--
-- BACKGROUND: migration 0129 extended write-permission gating to
-- INSERT/UPDATE/DELETE on income_sources/expense_items/insurance_policies
-- for the first time -- prior to 0129, these three tables' trigger
-- (enforce_country_confirmed(), migration 0104) only ever fired on
-- BEFORE INSERT, never on UPDATE or DELETE, so this exact class of bug
-- never had a chance to manifest on them before now.
--
-- Every OTHER table in this codebase that DOES gate DELETE (the full
-- ~80-table inventory from migration 0105) already carries the MCC-14 fix
-- (migration 0111): a DELETE whose owning auth.users row no longer exists
-- is recognised as part of that same account's own deletion cascade and is
-- allowed unconditionally, checked via the narrow, already-existing
-- _mcc_auth_user_exists() helper (auth.users directly, never user_profiles,
-- whose cascade-order-relative-to-other-tables is exactly what MCC-14
-- exploited). enforce_write_permitted_g5b() (0129) copied the service_role
-- bypass from enforce_country_confirmed() but did NOT copy this DELETE-
-- cascade exemption -- found live in DEV: deleting a synthetic user who
-- owned an expense_items row failed with COUNTRY_CONFIRMATION_REQUIRED
-- during the auth.users cascade, because by the time expense_items' row
-- was reached, user_profiles' row had already been cascaded away in the
-- same transaction, so is_country_confirmed() (which reads user_profiles)
-- returned false for an otherwise-fully-confirmed AU user.
--
-- This is a real, live-reproduced defect: it would make it impossible to
-- delete the account of any AU/IN user who has ever recorded an
-- income/expense/insurance row (unless that DELETE happens to be issued
-- with the real, correctly-configured service_role JWT context, which
-- masks it in normal application use but is not something to rely on --
-- MCC-14's own fix exists specifically so this doesn't depend on that).
--
-- Migration 0129 remains otherwise fully correct and is NOT modified here
-- (already applied to DEV) -- this is a narrow, additive forward fix to
-- enforce_write_permitted_g5b() only. No change to is_write_permitted(),
-- the manifest table, or the manifest's seeded rows.

create or replace function public.enforce_write_permitted_g5b()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if TG_OP = 'DELETE' then
    v_user_id := old.user_id;
  else
    v_user_id := new.user_id;
  end if;

  -- MCC-14 fix (migration 0111), applied here for the first time: a DELETE
  -- whose owning auth.users row no longer exists is part of that same
  -- user's own account-deletion cascade -- allow it unconditionally,
  -- checked BEFORE is_write_permitted() (which, like is_country_confirmed(),
  -- reads user_profiles -- the table whose cascade-order-relative-to-
  -- expense_items/income_sources/insurance_policies is exactly what this
  -- exploits). An ordinary direct DELETE by a still-existing account falls
  -- through unchanged to the same permission gate as before -- this branch
  -- does not fire for it, because _mcc_auth_user_exists() returns true.
  if TG_OP = 'DELETE' and not public._mcc_auth_user_exists(v_user_id) then
    return old;
  end if;

  if not public.is_write_permitted(v_user_id, TG_TABLE_NAME, TG_OP) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % is not permitted to % %', v_user_id, TG_OP, TG_TABLE_NAME
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.enforce_write_permitted_g5b() is
  'G5B trigger function for income_sources/expense_items/insurance_policies ONLY. Calls is_write_permitted() instead of enforce_country_confirmed()/is_country_confirmed(). Raises the SAME error code (42501) and a near-identical message as the legacy trigger, so existing client-side error handling keyed on 42501/COUNTRY_CONFIRMATION_REQUIRED is unaffected. Migration 0130: added the MCC-14 (0111) DELETE-cascade exemption, missing from the original 0129 version -- see this migration''s own header for the live-reproduced defect this closes.';

-- ROLLBACK: `create or replace function public.enforce_write_permitted_g5b()`
-- with the 0129 body (omit the TG_OP = 'DELETE' and not
-- _mcc_auth_user_exists(v_user_id) branch) to revert to the pre-0130 state.
-- Reverting reopens the account-deletion-cascade defect this migration
-- fixes -- do not roll back without also re-disabling DELETE coverage on
-- these three tables, or accepting that account deletion for a user with
-- rows in them will fail.
