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
-- DESIGN NOTE -- WHY THIS MIGRATION TOUCHES NO CERTIFIED FUNCTION BODY:
-- an earlier draft of this fix re-created smsf_recompute_fund() and the
-- Summary-sync trigger function so they could announce themselves to the
-- guard. That draft was WRONG and was discarded before shipping: the real
-- smsf_recompute_fund() delegates to smsf_compute_detailed_net_value() and
-- writes only detailed_net_value, whereas the rewrite had inlined different
-- arithmetic and invented columns. Re-creating a certified calculation from
-- memory is exactly how a certified output silently changes.
--
-- Instead this migration uses ALTER FUNCTION ... SET, which attaches a
-- transaction-scoped GUC to a function for the duration of every call to it,
-- WITHOUT modifying (or even reading) its body. Every certified writer is
-- whitelisted this way. Zero bytes of 0084's or 0089's logic change; if any of
-- those functions is later legitimately revised, this guard keeps working
-- untouched, because the whitelist is attached to the function identity, not
-- to its source.

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

  -- Certified writers carry this GUC via ALTER FUNCTION ... SET (section 2).
  -- current_setting(..., true) returns NULL instead of raising when unset.
  if coalesce(current_setting('fhip.smsf_balance_write', true), '') = 'certified' then
    return new;
  end if;

  raise exception
    'smsf: retirement_accounts.current_balance for an SMSF fund is a derived figure, not directly editable -- it is set only by the fund''s Summary value or by its Detailed holdings recomputation (migrations 0084/0089). Update the SMSF fund itself rather than writing this column.'
    using errcode = '42501';
end;
$$ language plpgsql;

comment on function retirement_accounts_smsf_balance_guard() is
  'Integrity guard (0090): blocks direct writes to retirement_accounts.current_balance for SMSF fund rows from any path other than the certified SMSF functions (whitelisted via ALTER FUNCTION ... SET, not by modifying their bodies). Fires only on a genuine current_balance change to a row that is BOTH master_item_key=''smsf'' AND has a matching smsf_funds row -- every other retirement account type (Industry Super, Retail Super, Defined Benefit, EPF/PPF/NPS, ...) is entirely unaffected and still fully editable through the ordinary grid. Not a cross-tenant control (RLS already handles that); this closes a self-inflicted data-integrity desync in which a direct API or PostgREST PATCH could make Net Worth disagree with the canonical smsf_funds valuation.';

drop trigger if exists trg_retirement_accounts_smsf_balance_guard on retirement_accounts;
create trigger trg_retirement_accounts_smsf_balance_guard
  before update of current_balance on retirement_accounts
  for each row execute function retirement_accounts_smsf_balance_guard();

-- ---------------------------------------------------------------------------
-- 2. Whitelist every certified writer -- body untouched.
--    ALTER FUNCTION ... SET applies the setting for the duration of each call
--    and unwinds automatically on exit (including on exception), so it cannot
--    leak into an unrelated statement, another function, or another session.
-- ---------------------------------------------------------------------------

-- Detailed mode: recompute holdings minus linked liabilities (0084).
-- Also covers every trigger that calls it (holdings / property-liability links
-- / liabilities), since the setting attaches to this function's own frame.
alter function smsf_recompute_fund(uuid) set "fhip.smsf_balance_write" = 'certified';

-- Summary mode: mirror smsf_funds.summary_balance into current_balance (0084).
alter function trg_smsf_funds_sync_summary_balance() set "fhip.smsf_balance_write" = 'certified';

-- Summary -> Detailed activation, which writes current_balance directly after
-- its zero-variance reconciliation gate passes (0084).
alter function smsf_switch_to_detailed(uuid) set "fhip.smsf_balance_write" = 'certified';

-- Detailed -> Summary switch-back (0089). It routes its write through the
-- Summary-sync trigger rather than writing current_balance itself, so it is
-- already covered transitively -- whitelisted explicitly anyway so the set of
-- certified writers is complete and self-documenting rather than relying on an
-- implementation detail of another function.
alter function smsf_switch_to_summary(uuid, numeric, date) set "fhip.smsf_balance_write" = 'certified';

-- Fund creation inserts its retirement_accounts row (INSERT, not UPDATE, so
-- the guard does not fire) but is whitelisted for the same completeness reason
-- and to stay correct if it ever performs a follow-up UPDATE.
alter function smsf_create_fund(text, text, numeric, date, text, char, char) set "fhip.smsf_balance_write" = 'certified';

commit;
