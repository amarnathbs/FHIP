-- WP-D (DEV, and PRODUCTION later): manual backup of the only existing table the app rewrites once contributions are recorded
-- (the two contribution columns and the frequency of an account). Run before the first contribution is recorded. Production has no managed backups.
create table public.bk_retirement_accounts_wp_d_20261021 as select * from public.retirement_accounts;
select count(*) as backed_up_rows from public.bk_retirement_accounts_wp_d_20261021;
