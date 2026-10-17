-- P9 ROLLBACK of P3 (WRITES). Puts the SMSF rows back as the P1 copy recorded them: the fund returns to its earlier shape (itemised assets, the
-- typed net value, no fund liability), the duplicate Retirement row is active again. Use it only if P3 must be undone.
-- WARNING: that earlier shape holds a typed net value on an itemised fund, which the new rule discourages, so the dashboard shows the data quality
-- note again. The history rows written by P3 stay (the history is append-only).
-- Replace PUT_YOUR_LOGIN_EMAIL_HERE (the only edit, keep the quotes). All in one transaction.
begin;

do $fn$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower('PUT_YOUR_LOGIN_EMAIL_HERE');
  if v_uid is null then
    raise exception 'no such user, check the e-mail';
  end if;
  if to_regclass('public.zz_bk_20261017_smsf_funds') is null then
    raise exception 'no backup found, P1 was not run';
  end if;
  perform set_config('fhip.cutover_user', v_uid::text, true);

  -- 1. Retire the liability that P3 added (it is archived, not deleted).
  update smsf_liabilities set is_active = false, updated_at = now()
   where user_id = v_uid and notes = 'Added by the entity-level cutover pack on the PO instruction of 17-10-2026';

  -- 2. Bring the duplicate Retirement row(s) back to active, exactly as copied.
  update retirement_accounts r set is_active = b.is_active, updated_at = now()
    from public.zz_bk_20261017_retirement_accounts b
   where r.id = b.id and r.user_id = v_uid and b.owner = 'smsf' and coalesce(b.master_item_key, '') <> 'smsf';

  -- 3. Put the typed net value back (the rule trigger would refuse it, so it is paused for this one statement).
  alter table smsf_funds disable trigger trg_smsf_funds_mode_rule;
  update smsf_funds f set summary_balance = b.summary_balance, summary_balance_date = b.summary_balance_date, updated_at = now()
    from public.zz_bk_20261017_smsf_funds b
   where f.id = b.id and f.user_id = v_uid;
  alter table smsf_funds enable trigger trg_smsf_funds_mode_rule;

  -- 4. Work the fund net out again (assets only, as before).
  perform smsf_recompute_fund(id) from smsf_funds where user_id = v_uid and is_active;
end
$fn$;

select f.fund_name, f.mode, f.summary_balance as typed_net, f.detailed_net_value as derived_net,
       (select count(*) from smsf_liabilities l where l.smsf_fund_id = f.id and l.is_active) as active_fund_liabilities
from smsf_funds f
where f.is_active and f.user_id = current_setting('fhip.cutover_user', true)::uuid;

commit;
