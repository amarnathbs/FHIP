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
-- NUMBERING NOTE: re-verified immediately before writing this file, same
-- method as 0084's own numbering note. This branch's own migrations folder
-- ends at 0084 (0078 is a byte-identical copy of the unmerged
-- property-liability branch's migration, not a new claim on that number).
-- Per this task's own briefing, the live cross-branch landscape as of
-- writing is: canonical main highest = 0085 (FDH-8 split-approval fix,
-- already merged); 0079-0081 claimed by the unmerged App Review remainder
-- branch; 0082/0083/0086 claimed by the unmerged Investment Intelligence R11
-- branch; 0078 already production-live (Property<->Liability). 0087 is the
-- next slot with zero collisions against every one of those claims. Per this
-- project's established renumbering precedent, if 0087 is no longer free by
-- the time this reaches DEV/main, this file renumbers to the next genuinely
-- free slot and this comment, every certification script reference, and
-- every runtime string get updated together (full-repo grep, not a blind
-- search/replace) -- see this task's own final report for the collision
-- re-check performed immediately before concluding.
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
