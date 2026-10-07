-- P6a (read only). How many administrators exist and how many people are Premium today. Expect ONE row. Paste it back.
select
  (select count(*) from public.admin_users) as administrators,
  (select count(*) from public.user_entitlements e where e.plan_tier = 'premium' and (e.effective_from is null or e.effective_from <= current_date) and (e.effective_to is null or e.effective_to >= current_date)) as premium_today;
