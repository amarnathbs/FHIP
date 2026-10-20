-- P1 BACKUP (WRITES, creates copy tables only). Run once, before P3. Production has NO managed backups, so this keeps its own
-- copy of exactly the rows the cutover can touch. The copy tables have row level security ON and no policy, so the API cannot read them.
-- Replace PUT_YOUR_LOGIN_EMAIL_HERE (the only edit, keep the quotes). It refuses to overwrite an earlier backup.
-- Needs the DEV-tested migrations 0289 and 0290 applied first (it does not read the new tables, but P3 does).
begin;

do $fn$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower('PUT_YOUR_LOGIN_EMAIL_HERE');
  if v_uid is null then
    raise exception 'no such user, check the e-mail';
  end if;
  if to_regclass('public.zz_bk_20261017_retirement_accounts') is not null then
    raise exception 'a backup left by an earlier run already exists, do not overwrite it, rename or drop it on purpose first';
  end if;

  create table public.zz_bk_20261017_retirement_accounts as
    select * from retirement_accounts where user_id = v_uid and (master_item_key = 'smsf' or owner = 'smsf');
  create table public.zz_bk_20261017_smsf_funds as
    select * from smsf_funds where user_id = v_uid;
  create table public.zz_bk_20261017_smsf_holdings as
    select * from smsf_holdings where user_id = v_uid;
  create table public.zz_bk_20261017_liabilities as
    select * from liabilities where user_id = v_uid and (owner = 'smsf' or position('smsf' in lower(liability_name)) > 0
      or id in (select liability_id from property_liability_links where user_id = v_uid and link_type = 'smsf_property_loan'));
  create table public.zz_bk_20261017_property_liability_links as
    select * from property_liability_links where user_id = v_uid and link_type = 'smsf_property_loan';
  create table public.zz_bk_20261017_assets as
    select * from assets where user_id = v_uid and owner = 'smsf';

  alter table public.zz_bk_20261017_retirement_accounts enable row level security;
  alter table public.zz_bk_20261017_smsf_funds enable row level security;
  alter table public.zz_bk_20261017_smsf_holdings enable row level security;
  alter table public.zz_bk_20261017_liabilities enable row level security;
  alter table public.zz_bk_20261017_property_liability_links enable row level security;
  alter table public.zz_bk_20261017_assets enable row level security;
end
$fn$;

-- What was copied (row counts). Expect for the PO household: 2 retirement rows, 1 fund, 3 holdings, 1 or more liabilities, 0 or more links, 1 asset.
select (select count(*) from public.zz_bk_20261017_retirement_accounts) as retirement_rows,
       (select count(*) from public.zz_bk_20261017_smsf_funds) as funds,
       (select count(*) from public.zz_bk_20261017_smsf_holdings) as holdings,
       (select count(*) from public.zz_bk_20261017_liabilities) as liabilities,
       (select count(*) from public.zz_bk_20261017_property_liability_links) as links,
       (select count(*) from public.zz_bk_20261017_assets) as assets;

commit;
