-- WP-D step 1 (DEV ONLY, read only). Check the project reference in the address bar first: DEV is vqycarelcoijzwlpkpcz.
-- Production (twwpnltizhtjxhamyoxt) is never touched by this pack.

-- 1a. the table must NOT exist yet (expected: false)
select to_regclass('public.retirement_contributions') is not null as table_already_present;

-- 1b. the tables the migration refers to exist (expected: all true)
select to_regclass('public.retirement_accounts') is not null as accounts_ok,
       to_regclass('public.retirement_members') is not null as members_ok,
       to_regclass('public.fdh_payroll_events') is not null as payroll_events_ok,
       to_regclass('public.currencies') is not null as currencies_ok;

-- 1c. the SMSF marker the trigger relies on (expected: at least the column exists)
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'retirement_accounts' and column_name in ('master_item_key', 'employer_contribution', 'personal_contribution', 'contribution_frequency', 'retirement_member_id')
 order by column_name;

-- 1d. how many accounts carry a contribution figure of their own today (these stay untouched until a contribution is recorded for that account)
select count(*) filter (where coalesce(employer_contribution, 0) > 0 or coalesce(personal_contribution, 0) > 0) as accounts_with_own_figure,
       count(*) as accounts_total
  from public.retirement_accounts where is_active;
