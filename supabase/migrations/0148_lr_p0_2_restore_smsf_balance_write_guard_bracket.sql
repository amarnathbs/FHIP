-- LR Independent Completeness Audit (2026-09-14), P0-2 fix.
--
-- THE REGRESSION: migration 0137 ("LR-5/LR-6 SMSF consolidated production
-- journey") re-declared smsf_recompute_fund() to add `security definer set
-- search_path = public` -- a real, needed fix for auth.admin.deleteUser()'s
-- cascade-role gap. But it re-declared the function FROM 0084's ORIGINAL
-- body, not from 0090's later body, silently dropping the
-- set_config('fhip.smsf_balance_write', 'certified', true) / '' bracket
-- 0090 had added around the function's one write to
-- retirement_accounts.current_balance. 0137's own header states "No change
-- to any function's logic/body" -- that claim is false with respect to 0090.
--
-- THE LIVE CONSEQUENCE: retirement_accounts_smsf_balance_guard() (0090) has
-- remained installed the whole time and still fires on every genuine
-- current_balance change for an SMSF fund row, raising 42501 unless that
-- narrow set_config window is open. Once 0137 shipped without it,
-- smsf_recompute_fund() itself started tripping its own guard: adding,
-- editing or removing ANY holding on a Detailed-mode fund now fails
-- outright with a raw 42501 the moment the recompute tries to write the new
-- balance. A no-op recompute (one that doesn't actually change
-- current_balance) still succeeds, which is why this was never caught until
-- the independent audit's oracle5 exercised a real add/edit/remove.
-- Production has one SMSF fund in detailed mode with 3 holdings -- that
-- user has been unable to maintain their own fund since 0137 shipped.
--
-- THE FIX: re-declare smsf_recompute_fund() ONE more time, this time
-- carrying BOTH fixes at once -- 0137's `security definer set search_path =
-- public` (still needed; do not regress the account-deletion fix it exists
-- for) AND 0090's set_config bracket around the retirement_accounts write
-- (needed to stop tripping the guard). Nothing else about the function
-- changes: same signature, same return type, same
-- smsf_compute_detailed_net_value() delegation, same
-- smsf_funds.detailed_net_value write. Diffed directly against both 0090
-- and 0137 before shipping, not reconstructed from memory (0090's own
-- design note explains why that matters).
--
-- The three trigger wrapper functions 0137 also re-declared
-- (trg_smsf_recompute_from_holding/_link/_liability) are UNCHANGED here --
-- they only ever called smsf_recompute_fund() and never themselves wrote
-- retirement_accounts, so they were never missing the bracket and 0137's
-- security definer addition to them stands as-is.
--
-- SCOPE NOTE: the audit also flagged (not yet a live defect)
-- trg_smsf_funds_sync_summary_balance() as still lacking `security definer`
-- since 0137 did not touch it. That trigger fires on an UPDATE to
-- smsf_funds.mode (Summary<->Detailed switching), a codepath distinct from
-- the add/edit/remove-holding flow this migration fixes, and is not part of
-- the confirmed-live P0-2 defect -- left out of scope here deliberately,
-- to keep this migration to the one confirmed regression.

begin;

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
    perform set_config('fhip.smsf_balance_write', 'certified', true);
    update retirement_accounts set current_balance = v_net, updated_at = now()
    where id = v_retirement_account_id;
    perform set_config('fhip.smsf_balance_write', '', true);
  end if;

  return v_net;
end;
$$;

comment on function smsf_recompute_fund(uuid) is
  'SMSF Detailed-mode recompute (0084), security definer for auth.admin.deleteUser() cascade privilege (0137), with 0090''s set_config(''fhip.smsf_balance_write'',...) bracket restored around its retirement_accounts write (0148 -- 0137 dropped this bracket by re-declaring from 0084''s original body, which tripped 0090''s own integrity guard on every real add/edit/remove of a Detailed holding; LR independent audit P0-2).';

commit;
