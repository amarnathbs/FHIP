-- LR-5/LR-6 SMSF consolidated production journey (2026-09-10) --
-- CRITICAL, live-reproduced defect: a user who has ever added a real SMSF
-- Detailed Holding could NEVER delete their own account again.
--
-- BACKGROUND: migration 0084's smsf_recompute_fund() and its three calling
-- triggers (trg_smsf_recompute_from_holding on smsf_holdings,
-- trg_smsf_recompute_from_link on property_liability_links,
-- trg_smsf_recompute_from_liability on liabilities) were all declared with
-- NO `security definer` clause -- they run with the INVOKER's own
-- privileges, not the function owner's. That is harmless for every
-- ordinary application call (the invoker is the authenticated user's own
-- RLS-scoped session, which already owns the rows it's touching), but
-- `auth.admin.deleteUser()` cascades DELETE across ~132 tables under
-- Supabase's own internal `supabase_auth_admin` role, not the deleted
-- user's session -- exactly the same class of role/privilege gap MCC-14
-- (migration 0111) and its G5B follow-up (migration 0130) already fixed
-- once for a DIFFERENT trigger family (country-confirmation gating). This
-- is the identical defect CLASS, in the SMSF recompute triggers, never
-- previously caught because no earlier phase's live-DEV testing ever
-- exercised `auth.admin.deleteUser()` against a user who owned a REAL SMSF
-- Detailed Holding (LR-6's own report disclosed a fund it could not clean
-- up, but only because no fund-DELETE endpoint exists -- it never actually
-- attempted a full account deletion against that fund).
--
-- LIVE REPRODUCTION (2026-09-10, LR-5/LR-6 consolidated journey): created a
-- disposable user, an SMSF fund, and one Detailed Holding, then called
-- `auth.admin.deleteUser()` -- failed every time with a raw
-- "Database error deleting user" (500). Binary-searched by adding pieces
-- incrementally: fund alone -> succeeds; fund + member -> succeeds;
-- fund + ONE holding -> fails, reproducibly. A plain PostgREST cascade
-- DELETE of the same `retirement_accounts` row (same FK graph, invoked as
-- service_role rather than through GoTrue's internal role) succeeded
-- cleanly, isolating the failure to the specific execution role GoTrue's
-- cascade runs under -- exactly the privilege-context gap this fix closes.
--
-- FIX: mark smsf_recompute_fund() and all three trigger functions that call
-- it `security definer set search_path = public`, so the UPDATE (and the
-- SELECTs feeding it, several of which read RLS-protected tables) always
-- run with the function owner's privileges regardless of which role
-- invoked them -- matching the exact pattern already established by
-- MCC-14/G5B (migrations 0111/0130) for the equivalent class of defect on
-- a different trigger family. No change to any function's logic/body,
-- return type, or the tables/columns/RLS policies they read or write.

create or replace function smsf_recompute_fund(p_fund_id uuid) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
  v_retirement_account_id uuid;
  v_net numeric;
begin
  select mode, retirement_account_id into v_mode, v_retirement_account_id
  from smsf_funds where id = p_fund_id;

  if v_retirement_account_id is null then
    return null;
  end if;

  v_net := smsf_compute_detailed_net_value(p_fund_id);

  update smsf_funds set detailed_net_value = v_net, updated_at = now() where id = p_fund_id;

  if v_mode = 'detailed' then
    update retirement_accounts set current_balance = v_net, updated_at = now()
    where id = v_retirement_account_id;
  end if;

  return v_net;
end;
$$;

create or replace function trg_smsf_recompute_from_holding() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform smsf_recompute_fund(coalesce(new.smsf_fund_id, old.smsf_fund_id));
  return coalesce(new, old);
end;
$$;

create or replace function trg_smsf_recompute_from_link() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fund_id uuid;
  v_ra_id uuid;
begin
  v_ra_id := coalesce(new.linked_retirement_id, old.linked_retirement_id);
  if v_ra_id is not null and coalesce(new.link_type, old.link_type) = 'smsf_property_loan' then
    select id into v_fund_id from smsf_funds where retirement_account_id = v_ra_id;
    if v_fund_id is not null then
      perform smsf_recompute_fund(v_fund_id);
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create or replace function trg_smsf_recompute_from_liability() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fund_id uuid;
begin
  select f.id into v_fund_id
  from property_liability_links pll
  join smsf_funds f on f.retirement_account_id = pll.linked_retirement_id
  where pll.liability_id = new.id and pll.link_type = 'smsf_property_loan' and pll.is_active = true
  limit 1;
  if v_fund_id is not null then
    perform smsf_recompute_fund(v_fund_id);
  end if;
  return new;
end;
$$;

comment on function smsf_recompute_fund(uuid) is
  'Recomputes a fund''s detailed_net_value (and, while mode=detailed, syncs retirement_accounts.current_balance). SECURITY DEFINER since 0137 -- must run reliably regardless of the invoking role/session (see migration 0137''s own header for the live-reproduced auth.admin.deleteUser() cascade defect this fixes), matching the MCC-14/G5B precedent (migrations 0111/0130) for the equivalent class of defect.';

-- ROLLBACK: re-run each `create or replace function` above with the
-- migration-0084 body (drop `security definer set search_path = public`,
-- keep `language plpgsql` only). Reverting reopens the account-deletion-
-- cascade defect this migration fixes -- do not roll back without also
-- accepting that deleting the account of any user who has ever added a
-- real SMSF Detailed Holding, property-loan link, or (via a future DELETE
-- trigger on liabilities) a linked liability will fail.
