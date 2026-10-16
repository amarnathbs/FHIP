-- D1 read only preview, to run BEFORE migration 0283. It changes nothing and needs nothing from 0283.
-- Paste the whole file in the SQL editor and press Run. You get one table.
--   Section A: is this database ready for the migration? Every ok must say true. If the editor itself shows a red message
--              such as column does not exist, STOP and send me the message.
--   Section B: exactly which accounts would receive Staff Premium, and what would happen to each. E-mail addresses are masked to
--              their first two characters and their domain. Nothing else about a person is shown.
-- The rule used: an account is staff while it has a row in admin_users, or an ACTIVE row in resource_user_roles for any of the six
-- Resources roles. Send me this table before you apply anything.

select section, user_id, masked_email, detail, ok
from (
  select 'A prerequisites' as section, null::uuid as user_id, null::text as masked_email, c.what as detail, c.ok as ok, c.n as n
  from (
    select 1 as n, 'migration 0231 applied: the entitlement_source column exists' as what,
           (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_entitlements' and column_name = 'entitlement_source') as ok
    union all select 2, 'migration 0237 applied: reserve_source, promo_code_id, admin_grant_extension_count and admin_grant_ends_on exist',
           (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'user_entitlements' and column_name in ('reserve_source', 'promo_code_id', 'admin_grant_extension_count', 'admin_grant_ends_on'))
    union all select 3, 'the capability function from 0231 exists', to_regprocedure('public.is_premium_entitlement_admin()') is not null
    union all select 4, 'the two role tables exist', to_regclass('public.admin_users') is not null and to_regclass('public.resource_user_roles') is not null
    union all select 5, 'the source rule today allows exactly payment, admin_grant and promo_code',
           coalesce((select position('promo_code' in pg_get_constraintdef(oid)) > 0 and position('staff_admin' in pg_get_constraintdef(oid)) = 0 from pg_constraint
                      where conname = 'user_entitlements_entitlement_source_check' and conrelid = 'public.user_entitlements'::regclass), false)
    union all select 6, 'no staff entitlement exists yet', (select count(*) = 0 from public.user_entitlements where entitlement_source = 'staff_admin')
  ) c
  union all
  select 'B staff accounts', s.id, s.masked,
         'via ' || s.via || ', today: ' || coalesce(s.src, 'no row') || ', ' || coalesce(s.tier, 'no row')
           || case when s.active then ' (Premium now)' else ' (not Premium now)' end
           || ', would: ' || case
                when s.active and s.src = 'payment' then 'keep, a paid subscription is Premium today and wins'
                when s.active and s.src = 'admin_grant' then 'start Staff Premium, REPLACING an active admin grant'
                when s.active and s.src = 'promo_code' then 'start Staff Premium, REPLACING an active promo'
                else 'start Staff Premium' end,
         true,
         100000
  from (
    select u.id,
           left(coalesce(u.email::text, ''), 2) || '***@' || split_part(coalesce(u.email::text, ''), '@', 2) as masked,
           case when exists (select 1 from public.admin_users a where a.user_id = u.id) then 'admin_users (Super Admin)'
                else 'resource role: ' || (select string_agg(r.role, ', ' order by r.role) from public.resource_user_roles r where r.user_id = u.id and r.is_active) end as via,
           e.entitlement_source as src,
           e.plan_tier as tier,
           coalesce(e.plan_tier = 'premium' and (e.effective_from is null or e.effective_from <= current_date) and (e.effective_to is null or e.effective_to >= current_date), false) as active
    from auth.users u
    left join public.user_entitlements e on e.user_id = u.id
    where exists (select 1 from public.admin_users a where a.user_id = u.id)
       or exists (select 1 from public.resource_user_roles r where r.user_id = u.id and r.is_active
                    and r.role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst'))
  ) s
) all_rows
order by n, section, user_id;
