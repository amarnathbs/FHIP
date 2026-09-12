-- G8 closure (docs/country-programme/G6-G8 country-programme closure
-- mission, section 7): a GENERIC user can bypass the app's own
-- "Delete unavailable" restriction on income_sources/expense_items/
-- insurance_policies by issuing a direct, authenticated PostgREST UPDATE
-- that sets is_active = false on their own row.
--
-- ROOT CAUSE: this app implements "delete" for these three tables as an
-- UPDATE (`is_active = false`, lib/services/registry.ts's archive()), never
-- a literal SQL DELETE. Migration 0129's manifest
-- (mcc_generic_write_capabilities) correctly seeds DELETE = false for
-- GENERIC on all three tables, and the app's own capability layer
-- (appCapability.ts's OPERATIONS_G5B_WRITE_CERTIFIED) correctly blocks the
-- app's own DELETE route for GENERIC -- but enforce_write_permitted_g5b()
-- (0129, patched by 0130) only ever asked is_write_permitted() about the
-- coarse SQL operation (TG_OP: INSERT/UPDATE/DELETE), never about WHICH
-- COLUMNS an UPDATE actually touches. is_write_permitted() unconditionally
-- allows UPDATE for GENERIC on all three tables (so ordinary field edits --
-- amount, currency_code, etc. -- work, as intended), and a client-side
-- UPDATE setting is_active is indistinguishable from any other UPDATE at
-- that layer. A single RLS policy (`FOR ALL using (auth.uid() = user_id)`,
-- migration 0003) has no column-level restriction either, so nothing before
-- this fix stopped a GENERIC user's own authenticated PostgREST client from
-- directly archiving (or bulk-archiving, via `.in()`) their own rows --
-- fully equivalent to the "delete" the app's UI/route explicitly withholds
-- from them.
--
-- LIVE-REPRODUCED: tests/live-dev/g8LiveDevGenericArchiveBypassCertification.test.ts,
-- against real DEV infrastructure with a real, disposable, non-service-role
-- authenticated GENERIC (GB) session -- confirmed exploitable on all three
-- tables, individually and in bulk, before this fix. Cross-tenant forgery
-- and literal DELETE were separately confirmed still blocked (unaffected by
-- this gap -- RLS ownership and the existing DELETE=false manifest entry
-- already handled those correctly).
--
-- FIX: the narrowest change that closes the gap without touching
-- is_write_permitted(), the manifest table, its seeded rows, or RLS. Only
-- enforce_write_permitted_g5b() (the BEFORE INSERT OR UPDATE OR DELETE
-- trigger already unique to these three tables) is modified: when an UPDATE
-- is specifically an ARCHIVE transition (old.is_active = true and
-- new.is_active = false), the trigger re-asks is_write_permitted() using
-- the operation string 'DELETE' instead of 'UPDATE' -- reusing the existing,
-- already-correct DELETE = false manifest entry for GENERIC, exactly as if
-- the client had issued a literal DELETE. Every other UPDATE (any field
-- other than is_active, or a re-activation from false back to true, which
-- registry.save() legitimately performs when a previously archived
-- catalogue item is re-added) is completely unaffected -- it still asks
-- is_write_permitted() for 'UPDATE', unchanged from 0129/0130.
--
-- A FULL (AU/IN, country-confirmed) user is unaffected either way:
-- is_write_permitted() returns true unconditionally for them via its own
-- is_country_confirmed() early return, before this distinction is even
-- reached. service_role is unaffected (its own earlier early return in
-- is_write_permitted() is untouched). The MCC-14 DELETE-cascade exemption
-- (0130's `if TG_OP = 'DELETE' and not _mcc_auth_user_exists(...)` branch)
-- is untouched and evaluated first, exactly as before -- this fix only adds
-- a narrower operation classification for the ordinary (non-cascade)
-- UPDATE path, so it can NEVER cause a genuine account-deletion cascade to
-- fail (that cascade issues real DELETE statements against these tables at
-- the auth.users FK level, not this archive-UPDATE path, and is proven
-- unaffected by the same live-DEV suite). It also cannot weaken MCC-14: it
-- adds a restriction only for the GENERIC archive-via-UPDATE case, never
-- loosens any existing DELETE-cascade allowance.
create or replace function public.enforce_write_permitted_g5b()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_operation text;
begin
  if TG_OP = 'DELETE' then
    v_user_id := old.user_id;
  else
    v_user_id := new.user_id;
  end if;

  -- MCC-14 fix (migration 0111/0130), unchanged: a DELETE whose owning
  -- auth.users row no longer exists is part of that same user's own
  -- account-deletion cascade -- allow it unconditionally.
  if TG_OP = 'DELETE' and not public._mcc_auth_user_exists(v_user_id) then
    return old;
  end if;

  v_operation := TG_OP;

  -- G8 closure fix: an UPDATE that specifically archives the row
  -- (is_active true -> false) is, in this application's own business
  -- semantics, a delete -- classify it as one for permission purposes so
  -- GENERIC's existing, correct DELETE = false manifest entry actually
  -- applies to it. Any UPDATE that leaves is_active untouched, or that
  -- re-activates a previously archived row (false -> true), is unaffected.
  if TG_OP = 'UPDATE'
     and old.is_active is true
     and new.is_active is false
  then
    v_operation := 'DELETE';
  end if;

  if not public.is_write_permitted(v_user_id, TG_TABLE_NAME, v_operation) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % is not permitted to % %', v_user_id, v_operation, TG_TABLE_NAME
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.enforce_write_permitted_g5b() is
  'G5B trigger function for income_sources/expense_items/insurance_policies ONLY. Calls is_write_permitted() instead of enforce_country_confirmed()/is_country_confirmed(). Migration 0147: an UPDATE that flips is_active from true to false (this app''s archive/soft-delete convention, lib/services/registry.ts''s archive()) is now classified and permission-checked as a DELETE, closing the GENERIC "Delete unavailable" bypass via direct UPDATE that 0129/0130 left open -- see this migration''s own header for the live-reproduced defect and tests/live-dev/g8LiveDevGenericArchiveBypassCertification.test.ts for the proof. Every other UPDATE (including re-activation, false -> true) is unaffected. Raises the SAME error code (42501) and a near-identical message as before, so existing client-side error handling is unaffected.';

-- ROLLBACK: `create or replace function public.enforce_write_permitted_g5b()`
-- with the 0130 body (remove the `v_operation` reclassification block,
-- restoring the unconditional `TG_TABLE_NAME, TG_OP` call) to revert to the
-- pre-0147 state. Reverting reopens the GENERIC archive-via-UPDATE bypass
-- this migration closes -- do not roll back without accepting that a
-- GENERIC user's own direct PostgREST client can again silently archive
-- (individually or in bulk) their own Income/Expense/Insurance rows,
-- bypassing the app's "Delete unavailable" restriction.
