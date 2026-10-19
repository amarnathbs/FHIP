-- 30 (read only). What the five standing DEV test users still hold in the investment tables. Expect ONE row. After the release candidate certification
-- cleanup every number except audit_events and manual_investments must be 0. audit_events is append only by design and stays. manual_investments are the
-- users own earlier test data (the forecast test pack) and are NOT touched by this work.
with u as (
  select id from auth.users
  where email in ('forecast.tc053@example.test', 'forecast.tc058@example.test', 'forecast.tc065@example.test', 'forecast.tc072@example.test', 'forecast.tc078@example.test')
)
select
  (select count(*) from u) as test_users_found_of_5,
  (select count(*) from public.ii_source_documents d where d.user_id in (select id from u)) as source_documents,
  (select count(*) from public.ii_accounts a where a.user_id in (select id from u)) as accounts,
  (select count(*) from public.ii_transactions t where t.user_id in (select id from u)) as transactions,
  (select count(*) from public.ii_holding_snapshots h where h.user_id in (select id from u)) as holding_snapshots,
  (select count(*) from public.ii_portfolio_truth_status s where s.user_id in (select id from u)) as portfolio_truth_rows,
  (select count(*) from public.ii_reconciliation_cases c where c.user_id in (select id from u)) as reconciliation_cases,
  (select count(*) from public.ii_fhip_publications p where p.user_id in (select id from u)) as publications,
  (select count(*) from public.nav2_fund_analytics_reports r where r.user_id in (select id from u)) as fund_analytics_reports,
  (select count(*) from public.nav2_report_render_tokens k where k.user_id in (select id from u)) as render_tokens,
  (select count(*) from public.investments i where i.user_id in (select id from u)) as manual_investments,
  (select count(*) from public.ii_audit_events e where e.user_id in (select id from u)) as audit_events,
  (select count(*) from public.user_entitlements e where e.user_id in (select id from u) and e.plan_tier = 'premium') as test_users_with_premium_now;
