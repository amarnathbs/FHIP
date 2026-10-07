-- 0269 -- a stored Fund analytics report can be read only while the owner is Premium (Stage 3 finding).
--
-- Forward-only and idempotent. HAND-OVER ARTEFACT: NOT APPLIED anywhere. Apply after 0261.
--
-- FOUND ON DEV (Stage 3, 06-10-2026): the report API answers 403 once a user Premium plan has lapsed, but the table policy of 0261 only
-- checked ownership. So the same user could still read the stored report (the whole report content) directly in the table with their
-- own session. This makes the database agree with the API: the owner rows are readable only while the owner is Premium today.
--
-- Premium today is exactly the rule every other reader uses (lib/services/entitlementWindow.ts and migration 0115). The plan is premium,
-- the start date is empty or not after today, and the end date is empty or not before today. The end date is inclusive and today is the
-- UTC date. The function reads the caller own entitlement row inside the database (definer rights and a fixed search path) and returns
-- only true or false.
--
-- NOT CHANGED: how reports are written (service role only, as before), the print route (it reads with the service role after checking a
-- single-use token), and other users rows (still invisible). A lapsed user keeps their reports and simply cannot read them until Premium
-- is back, which is the product rule for this report.
--
-- ROLLBACK: recreate the policy of 0261 (using auth.uid() = user_id) and drop the function.

create or replace function nav2_viewer_has_premium() returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.user_entitlements e
     where e.user_id = auth.uid()
       and e.plan_tier = 'premium'
       and (e.effective_from is null or e.effective_from <= current_date)
       and (e.effective_to is null or e.effective_to >= current_date)
  );
$fn$;
revoke all on function nav2_viewer_has_premium() from public, anon;
grant execute on function nav2_viewer_has_premium() to authenticated, service_role;

drop policy if exists own_read_nav2_fund_analytics_reports on nav2_fund_analytics_reports;
create policy own_read_nav2_fund_analytics_reports on nav2_fund_analytics_reports
  for select using (auth.uid() = user_id and public.nav2_viewer_has_premium());
