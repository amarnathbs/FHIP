-- WP-D step 3 (DEV ONLY, read only): the migration landed as designed.

-- 3a. the table, its row level security and its single policy (expected: true, true, 1)
select to_regclass('public.retirement_contributions') is not null as table_present,
       (select relrowsecurity from pg_class where oid = 'public.retirement_contributions'::regclass) as rls_on,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'retirement_contributions') as policies;

-- 3b. the unique payslip index and the destination trigger (expected: 1 row each)
select indexname from pg_indexes where schemaname = 'public' and tablename = 'retirement_contributions' and indexname = 'uq_retirement_contributions_payslip';
select tgname from pg_trigger where tgrelid = 'public.retirement_contributions'::regclass and tgname = 'trg_retirement_contributions_validate';

-- 3c. the table is empty until a contribution is recorded (expected: 0)
select count(*) as rows_now from public.retirement_contributions;

-- 3d. after you approve one payslip on DEV: exactly one row for it (expected: 1), and none waiting if the fund name matched
select status, destination_kind, matched_by, count(*) as n
  from public.retirement_contributions where source_type = 'payslip' group by status, destination_kind, matched_by;
