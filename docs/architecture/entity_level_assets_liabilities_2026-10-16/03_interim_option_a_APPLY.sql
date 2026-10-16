-- 03 APPLY interim option A (WRITES). Run ONLY after 02 shows exactly ONE row, and after the PO says go.
-- Production has NO managed backups, so this makes its own copy first. All in one transaction: if any check
-- fails, nothing changes. Replace PUT_YOUR_LOGIN_EMAIL_HERE and, if different, v_expected (503000 for the PO household).
-- The copy tables are created with row level security ON and no policy, so they are NOT readable through the API.
begin;

do $$
declare
  v_user uuid;
  v_n int;
  v_expected numeric := 503000;   -- the amount 02 showed
begin
  select id into v_user from auth.users where lower(email) = lower('PUT_YOUR_LOGIN_EMAIL_HERE');
  if v_user is null then raise exception 'no such user: check the e-mail'; end if;
  select count(*) into v_n from retirement_accounts
   where user_id = v_user and master_item_key = 'smsf' and owner <> 'smsf' and is_active and current_balance = v_expected;
  if v_n <> 1 then raise exception 'expected exactly 1 active SMSF fund row of % but found %: stop and re-run 02', v_expected, v_n; end if;
  if to_regclass('public.zz_backup_20261016_retirement_accounts') is not null then
    raise exception 'a backup from an earlier run already exists: do not overwrite it, rename or drop it deliberately first';
  end if;

  create table public.zz_backup_20261016_retirement_accounts as
    select * from retirement_accounts where user_id = v_user and master_item_key = 'smsf' and owner <> 'smsf' and is_active;
  create table public.zz_backup_20261016_smsf_funds as
    select f.* from smsf_funds f join retirement_accounts r on r.id = f.retirement_account_id
     where r.user_id = v_user and r.master_item_key = 'smsf' and r.owner <> 'smsf' and r.is_active;
  alter table public.zz_backup_20261016_retirement_accounts enable row level security;
  alter table public.zz_backup_20261016_smsf_funds enable row level security;

  update smsf_funds set is_active = false, updated_at = now()
   where retirement_account_id in (select id from public.zz_backup_20261016_retirement_accounts);
  update retirement_accounts set is_active = false, updated_at = now()
   where id in (select id from public.zz_backup_20261016_retirement_accounts);
end $$;

-- Check before committing: the copies must hold 1 row each and the fund row must now be inactive.
select (select count(*) from public.zz_backup_20261016_retirement_accounts) as retirement_copies,
       (select count(*) from public.zz_backup_20261016_smsf_funds) as fund_copies,
       (select count(*) from retirement_accounts r join public.zz_backup_20261016_retirement_accounts b on b.id = r.id where not r.is_active) as archived_now;
commit;
