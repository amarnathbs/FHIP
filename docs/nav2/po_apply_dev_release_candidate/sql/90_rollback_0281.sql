-- ROLLBACK of 0281: removes the idempotency key. Reports already issued are not touched (their rows only lose two empty or key columns).
-- After this the report screen still works: a repeated click can then issue a second report again.
drop index if exists public.uidx_nav2_reports_user_idempotency;
alter table public.nav2_fund_analytics_reports drop constraint if exists nav2_reports_idempotency_shape;
alter table public.nav2_fund_analytics_reports drop column if exists idempotency_key;
alter table public.nav2_fund_analytics_reports drop column if exists request_fingerprint;
