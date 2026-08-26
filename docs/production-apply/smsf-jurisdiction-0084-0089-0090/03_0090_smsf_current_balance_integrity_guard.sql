-- SMSF follow-up (0090): server-side integrity guard for an SMSF fund's
-- retirement_accounts.current_balance.
--
-- THE GAP (found during independent verification of the SMSF UI work; not
-- disclosed by the implementing round's own report):
--
-- Migration 0084 established that an SMSF fund's
-- retirement_accounts.current_balance is a DERIVED figure with a small set of
-- certified write paths (Summary sync / Detailed recompute / mode switches).
-- The SMSF UI work then correctly removed the 'smsf' catalogue item from the
-- generic FinancialDataGrid (GridConfig.excludeMasterItemKeys), because that
-- grid's plain per-field PATCH would otherwise let a user overwrite
-- current_balance directly and desync it from smsf_funds.
--
-- But that exclusion is CLIENT-SIDE ONLY. Verified against the code as merged:
--   * app/api/retirement/[id]/route.ts performs a generic
--     registry.update(user.id, id, parsed.data) with no SMSF-specific guard,
--     so a direct PATCH to that route still reaches current_balance.
--   * The only pre-existing trigger on retirement_accounts,
--     trg_retirement_accounts_smsf_au_gate (0084), fires
--     `before insert or update of master_item_key, is_active` -- it does NOT
--     fire on current_balance, so it does not cover this at all.
--   * A user could equally bypass the Next.js route entirely and PATCH
--     PostgREST directly with their own anon key.
--   * RLS confines any such write to the user's OWN row, so this is NOT a
--     cross-tenant security hole -- it is a self-inflicted DATA-INTEGRITY
--     hole. The user's own Net Worth (computeDashboard reads
--     retirement_accounts.current_balance) would silently disagree with the
--     canonical smsf_funds valuation until some later legitimate SMSF edit
--     happened to re-sync it.
--
-- This contradicted the SMSF spec's own s.6 principle -- "UI filtering is
-- convenience only ... the database/API gate remains the enforcement" -- a
-- principle the AU-only jurisdiction gate already honours with real defence in
-- depth, but which this integrity gate did not.
--
-- DESIGN NOTE 1 -- WHY THIS MIGRATION TOUCHES NO CERTIFIED FUNCTION'S LOGIC:
-- an earlier draft of this fix re-created smsf_recompute_fund() and the
-- Summary-sync trigger function FROM MEMORY so they could announce themselves
-- to the guard. That draft was WRONG and was discarded before shipping: the
-- real smsf_recompute_fund() delegates to smsf_compute_detailed_net_value()
-- and writes only detailed_net_value, whereas the memory-based rewrite had
-- inlined different arithmetic and invented columns. Re-creating a certified
-- calculation from memory is exactly how a certified output silently changes.
--
-- DESIGN NOTE 2 -- WHY THIS ISN'T "ALTER FUNCTION ... SET" (v1 of this
-- migration used that and was rejected by the target database with
-- `42501: permission denied to set parameter`): Supabase's hosted `postgres`
-- role is NOT a Postgres superuser, and lacks the privilege to attach a
-- custom GUC to a function's proconfig via ALTER FUNCTION ... SET. This
-- migration instead brackets each certified write with a plain
-- `perform set_config('fhip.smsf_balance_write', 'certified', true)` /
-- `perform set_config('fhip.smsf_balance_write', '', true)` pair -- an
-- ordinary runtime statement (the same primitive PostgREST itself uses for
-- `request.jwt.claims`), requiring no elevated privilege at all. `is_local =
-- true` scopes it to the current transaction only (auto-discarded on
-- commit/rollback), and each pair is bracketed as narrowly as possible --
-- immediately before and after the single UPDATE it is meant to authorise --
-- rather than for a function's whole body, so nothing else in the same
-- transaction can ride on an accidentally-wide-open window.
--
-- The three function bodies touched below (smsf_recompute_fund,
-- trg_smsf_funds_sync_summary_balance, smsf_switch_to_detailed) are copied
-- VERBATIM from their authoritative migration source (0084) with nothing
-- changed except the added set_config bracket around the one statement each
-- writes to retirement_accounts.current_balance -- confirmed by direct diff
-- against 0084/0089 before shipping, not from memory.
--
-- Two certified writers need NO changes at all and are simply covered as-is:
--   * smsf_create_fund() writes current_balance via INSERT, not UPDATE -- the
--     guard is `before update of current_balance`, so it never fires on
--     fund creation in the first place.
--   * smsf_switch_to_summary() (0089) never writes current_balance itself --
--     it updates smsf_funds.summary_balance/mode, and the existing
--     trg_smsf_funds_sync_summary_balance trigger (bracketed below) performs
--     the actual retirement_accounts write in the same transaction.

begin;

-- ---------------------------------------------------------------------------
-- 1. The guard.
-- ---------------------------------------------------------------------------
create or replace function retirement_accounts_smsf_balance_guard() returns trigger as $$
declare
  v_is_smsf_fund boolean;
begin
  -- Only relevant when current_balance actually changes. An UPDATE touching
  -- any other column (notes, account_name, country_code, is_active, ...) on an
  -- SMSF row remains perfectly allowed.
  if new.current_balance is not distinct from old.current_balance then
    return new;
  end if;

  -- Is this row genuinely an SMSF fund? BOTH conditions must hold: the
  -- catalogue key says smsf AND a real smsf_funds row points at it. A row
  -- merely keyed 'smsf' with no fund record yet (e.g. mid-creation, before
  -- smsf_create_fund() has inserted its smsf_funds row) is deliberately NOT
  -- guarded -- otherwise fund creation would trip over this trigger.
  select exists (
    select 1 from smsf_funds f where f.retirement_account_id = new.id
  ) into v_is_smsf_fund;

  if not (new.master_item_key = 'smsf' and v_is_smsf_fund) then
    return new;
  end if;

  -- Certified writers open this narrow window via set_config immediately
  -- around their one write (section 2). current_setting(..., true) returns
  -- NULL instead of raising when unset.
  if coalesce(current_setting('fhip.smsf_balance_write', true), '') = 'certified' then
    return new;
  end if;

  raise exception
    'smsf: retirement_accounts.current_balance for an SMSF fund is a derived figure, not directly editable -- it is set only by the fund''s Summary value or by its Detailed holdings recomputation (migrations 0084/0089). Update the SMSF fund itself rather than writing this column.'
    using errcode = '42501';
end;
$$ language plpgsql;

comment on function retirement_accounts_smsf_balance_guard() is
  'Integrity guard (0090): blocks direct writes to retirement_accounts.current_balance for SMSF fund rows from any path other than the certified SMSF functions, which open a narrow set_config(...) window around their one authorised write. Fires only on a genuine current_balance change to a row that is BOTH master_item_key=''smsf'' AND has a matching smsf_funds row -- every other retirement account type (Industry Super, Retail Super, Defined Benefit, EPF/PPF/NPS, ...) is entirely unaffected and still fully editable through the ordinary grid. Not a cross-tenant control (RLS already handles that); this closes a self-inflicted data-integrity desync in which a direct API or PostgREST PATCH could make Net Worth disagree with the canonical smsf_funds valuation.';

drop trigger if exists trg_retirement_accounts_smsf_balance_guard on retirement_accounts;
create trigger trg_retirement_accounts_smsf_balance_guard
  before update of current_balance on retirement_accounts
  for each row execute function retirement_accounts_smsf_balance_guard();

-- ---------------------------------------------------------------------------
-- 2. Certified writers -- bodies verbatim from 0084/0089, each with a narrow
--    set_config(...) bracket added around its one write to
--    retirement_accounts.current_balance. Nothing else changed.
-- ---------------------------------------------------------------------------

-- Detailed mode: recompute holdings minus linked liabilities (0084).
create or replace function smsf_recompute_fund(p_fund_id uuid) returns numeric as $$
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
    perform set_config('fhip.smsf_balance_write', 'certified', true);
    update retirement_accounts set current_balance = v_net, updated_at = now()
    where id = v_retirement_account_id;
    perform set_config('fhip.smsf_balance_write', '', true);
  end if;

  return v_net;
end;
$$ language plpgsql;

-- Summary mode: mirror smsf_funds.summary_balance into current_balance (0084).
-- Also covers smsf_switch_to_summary (0089), which routes its write through
-- this same trigger rather than writing current_balance itself.
create or replace function trg_smsf_funds_sync_summary_balance() returns trigger as $$
begin
  if new.mode = 'summary' then
    perform set_config('fhip.smsf_balance_write', 'certified', true);
    update retirement_accounts set current_balance = coalesce(new.summary_balance, 0), updated_at = now()
    where id = new.retirement_account_id;
    perform set_config('fhip.smsf_balance_write', '', true);
  end if;
  return new;
end;
$$ language plpgsql;

-- Summary -> Detailed activation, which writes current_balance directly after
-- its zero-variance reconciliation gate passes (0084).
create or replace function smsf_switch_to_detailed(p_fund_id uuid) returns numeric as $$
declare
  v_mode text;
  v_summary numeric;
  v_retirement_account_id uuid;
  v_detailed numeric;
  v_variance numeric;
begin
  select mode, summary_balance, retirement_account_id into v_mode, v_summary, v_retirement_account_id
  from smsf_funds where id = p_fund_id;

  if v_retirement_account_id is null then
    raise exception 'smsf: fund % not found (or not visible to the current user)', p_fund_id using errcode = 'P0002';
  end if;
  if v_mode = 'detailed' then
    raise exception 'smsf: fund % is already in detailed mode', p_fund_id using errcode = '55000';
  end if;

  v_detailed := smsf_compute_detailed_net_value(p_fund_id);
  v_variance := round(coalesce(v_detailed, 0) - coalesce(v_summary, 0), 2);

  if v_variance <> 0 then
    raise exception 'smsf: cannot switch to detailed mode with an unresolved Net Worth variance of % (summary=%, detailed=%) -- resolve the difference in Detailed Holdings first', v_variance, v_summary, v_detailed
      using errcode = '23514';
  end if;

  update smsf_funds
  set mode = 'detailed',
      detailed_net_value = v_detailed,
      activated_detailed_at = now(),
      updated_at = now()
  where id = p_fund_id;

  perform set_config('fhip.smsf_balance_write', 'certified', true);
  update retirement_accounts
  set current_balance = v_detailed, updated_at = now()
  where id = v_retirement_account_id;
  perform set_config('fhip.smsf_balance_write', '', true);

  return v_detailed;
end;
$$ language plpgsql;

-- smsf_create_fund() and smsf_switch_to_summary() are deliberately NOT
-- recreated here -- see design note above (INSERT-only, and
-- trigger-delegated, respectively; neither needs a set_config bracket).

commit;
