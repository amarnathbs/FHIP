-- SMSF-UI: Detailed -> Summary switch-back (spec s.32-33). Genuine gap found
-- while building the SMSF UI on top of migration 0084: that migration's own
-- smsfFundUpdateSchema comment (lib/validation/smsf.ts) explicitly recorded
-- "there is deliberately no detailed->summary path in this release" -- the
-- UI cannot deliver spec s.32 ("Allow Detailed→Summary — do not delete
-- Detailed holdings ... require/confirm new Summary value + valuation date,
-- atomic switch") without a server-side path for it. This migration adds
-- exactly that, and nothing else -- it does not touch 0084's schema,
-- triggers, or the Summary->Detailed direction in any way.
--
-- NUMBERING NOTE: originally written as 0087, renumbered to 0089 to resolve a
-- genuine collision. Investment Intelligence R11's terminal-closure round
-- independently claimed 0087 for a live-exploitable same-user authoritative-
-- forgery security guard (plus 0088 for a report-access-log cascade fix).
-- Neither was applied to DEV, so this project's usual "whoever applied first
-- keeps the number" tie-break could not resolve it. Product Owner decision:
-- the security fix is applied first and keeps 0087/0088; this
-- Detailed->Summary switch-back RPC renumbers forward to 0089. Every
-- reference (route, service, validation, component, certification script,
-- unit test) was updated together via a full-repo grep, not a blind
-- search/replace. Live landscape at renumber time: main = 0078/0085;
-- 0079-0081 App Review remainder (unmerged); 0082/0083/0086 II-R11
-- (DEV-APPLIED, frozen); 0084 SMSF foundation (DEV-APPLIED, frozen);
-- 0087/0088 II-R11 (unapplied); 0090 = SMSF current_balance integrity guard,
-- written alongside this renumber.
--
-- Idempotent: create or replace throughout; no schema/table changes.

begin;

-- Mirrors smsf_switch_to_detailed()'s own shape and comment style exactly
-- (same file, same author intent) so the two directions read as one
-- coherent pair, not two unrelated designs. Unlike the Summary->Detailed
-- direction, this one is NOT gated behind a reconciliation/variance check --
-- spec s.32 asks the user to explicitly enter a NEW Summary value (which by
-- definition supersedes whatever the Detailed figures computed), not to
-- reproduce the old Detailed net value. Detailed holdings are never deleted
-- or archived here -- they simply stop being the fund's active valuation
-- source; smsf_recompute_fund()'s own existing "if v_mode = 'detailed'"
-- guard (migration 0084) already means further holding edits after this
-- switch keep updating smsf_funds.detailed_net_value as a live reference
-- figure without ever touching retirement_accounts.current_balance again --
-- no new logic needed for that half, it already falls out of 0084's design.
create or replace function smsf_switch_to_summary(
  p_fund_id uuid,
  p_new_summary_balance numeric,
  p_new_summary_balance_date date
) returns numeric as $$
declare
  v_mode text;
  v_retirement_account_id uuid;
begin
  select mode, retirement_account_id into v_mode, v_retirement_account_id
  from smsf_funds where id = p_fund_id;

  if v_retirement_account_id is null then
    raise exception 'smsf: fund % not found (or not visible to the current user)', p_fund_id using errcode = 'P0002';
  end if;
  if v_mode = 'summary' then
    raise exception 'smsf: fund % is already in summary mode', p_fund_id using errcode = '55000';
  end if;
  if p_new_summary_balance is null or p_new_summary_balance < 0 then
    raise exception 'smsf: a new Summary value is required to switch back to Summary mode' using errcode = '23514';
  end if;

  -- Single UPDATE statement so the existing trg_smsf_funds_sync_summary
  -- trigger (migration 0084, fires AFTER UPDATE OF summary_balance, mode)
  -- performs the retirement_accounts.current_balance write itself in the
  -- same transaction -- this function deliberately does not duplicate that
  -- write, so there is exactly one certified code path that ever sets
  -- current_balance from a Summary value, in either direction.
  update smsf_funds
  set mode = 'summary',
      summary_balance = p_new_summary_balance,
      summary_balance_date = p_new_summary_balance_date,
      updated_at = now()
  where id = p_fund_id;

  return p_new_summary_balance;
end;
$$ language plpgsql;

comment on function smsf_switch_to_summary(uuid, numeric, date) is
  'SMSF-UI Detailed->Summary switch-back (spec s.32-33). Runs as the invoking role (RLS-scoped): the initial SELECT only ever finds a fund this user owns, so a forged fund id from another tenant behaves identically to "not found". Detailed holdings/detailed_net_value are preserved, never deleted -- they become non-canonical reference data, still visible, no longer the active valuation source. Requires a non-null, non-negative new Summary value (spec: "require ... new Summary value") before flipping mode.';

commit;
