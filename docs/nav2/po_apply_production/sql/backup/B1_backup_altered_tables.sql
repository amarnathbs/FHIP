-- B1 (writes four small backup tables, changes nothing else). Run BEFORE any migration of the release. Production has NO managed backups, so this is the backup.
-- It copies the only existing things the release alters: the administrator permissions table (two columns are added), the switch table (four rows are added),
-- the text of the retention function (replaced by 0261) and the size of the price correction ledger (a trigger is added, no row is changed).
-- Safe to run twice: a second run keeps the first copy. The copies are locked to the service role (row level security on, no policy), so nobody can read them
-- through the application. Remove them with B3 once the release is confirmed.
create table if not exists public.nav2_backup_20261016_admin_users as select * from public.admin_users;
create table if not exists public.nav2_backup_20261016_job_control as select * from public.ii_reference_job_control;
create table if not exists public.nav2_backup_20261016_function_text as
  select 'pc6_nav_row_is_candidate'::text as function_name, pg_get_functiondef(p.oid) as definition, md5(p.prosrc) as body_md5, now() as taken_at
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'pc6_nav_row_is_candidate';
create table if not exists public.nav2_backup_20261016_corrections_size as
  select count(*)::bigint as row_count, now() as taken_at from public.ii_reference_corrections;
alter table public.nav2_backup_20261016_admin_users enable row level security;
alter table public.nav2_backup_20261016_job_control enable row level security;
alter table public.nav2_backup_20261016_function_text enable row level security;
alter table public.nav2_backup_20261016_corrections_size enable row level security;
revoke all on public.nav2_backup_20261016_admin_users from anon, authenticated;
revoke all on public.nav2_backup_20261016_job_control from anon, authenticated;
revoke all on public.nav2_backup_20261016_function_text from anon, authenticated;
revoke all on public.nav2_backup_20261016_corrections_size from anon, authenticated;
