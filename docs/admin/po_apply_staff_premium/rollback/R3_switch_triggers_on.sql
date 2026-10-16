-- R3 switch the three triggers back on (after R1, when you want the feature again). Then run backfill/B2 and B3.
alter table public.user_entitlements enable trigger trg_staff_premium_guard;
alter table public.admin_users enable trigger trg_staff_premium_admin_users;
alter table public.resource_user_roles enable trigger trg_staff_premium_resource_roles;

select tgname, tgenabled = 'O' as ok
from pg_trigger
where tgname in ('trg_staff_premium_guard', 'trg_staff_premium_admin_users', 'trg_staff_premium_resource_roles') and not tgisinternal
order by tgname;
