-- ROLLBACK of 0269: the 0261 reading rule comes back (an owner reads own stored reports whether or not Premium is current) and the helper function goes.
-- Only the fund analytics report table is affected.
drop policy if exists own_read_nav2_fund_analytics_reports on public.nav2_fund_analytics_reports;
create policy own_read_nav2_fund_analytics_reports on public.nav2_fund_analytics_reports for select using (auth.uid() = user_id);
drop function if exists public.nav2_viewer_has_premium();
