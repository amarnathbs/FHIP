-- NAV 1 PO decision #1 (27 Sep 2026) -- combined apply file.
-- Run this ONLY after the code deploy (this branch merged to main, Amplify
-- job SUCCEED). Safe to run as one paste in the Supabase SQL editor: each
-- migration is independently idempotent and production-only guarded (each
-- is a documented no-op on DEV or any database without a 'production'
-- ii_nav_retention_policy row). See README.md in this folder for the full
-- deploy order and verification steps.

-- ============================================================
-- 1/3: 0220_nav1_daily_window_all_days.sql
-- ============================================================
do $$
begin
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    raise notice '0220: not the production database -- the daily-NAV schedule is left untouched.';
    return;
  end if;

  -- Daily NAV, 03:30-03:58 UTC every day (was Tue-Sat only).
  perform cron.unschedule('pc6-reference-ingest')
  where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest');
  perform cron.schedule(
    'pc6-reference-ingest',
    '30-58/2 3 * * *',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-reference-ingest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := '{"sourceConfigId":"amfi_nav_daily","jobKey":"pc6_amfi_daily_nav"}'::jsonb,
      timeout_milliseconds := 300000
    );
    $cron$
  );

  -- Daily NAV, 04:00-04:30 UTC every day (was Tue-Sat only; same call, second half of the window).
  perform cron.unschedule('pc6-reference-ingest-0400')
  where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest-0400');
  perform cron.schedule(
    'pc6-reference-ingest-0400',
    '0-30/2 4 * * *',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-reference-ingest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := '{"sourceConfigId":"amfi_nav_daily","jobKey":"pc6_amfi_daily_nav"}'::jsonb,
      timeout_milliseconds := 300000
    );
    $cron$
  );

  raise notice '0220: production -- daily NAV window now runs every day (03:30-04:30 UTC, every 2 min). Scheme master stays Tuesday-only (unchanged).';
end $$;

-- ============================================================
-- 2/3: 0221_nav1_reconciliation_sweep_foundation.sql
-- ============================================================
create table if not exists ii_reference_publication_coverage (
  id uuid primary key default gen_random_uuid(),
  source_config_id text not null,
  publication_date date not null,
  expected_count integer not null check (expected_count >= 0),
  present_count integer not null check (present_count >= 0),
  missing_count integer not null check (missing_count >= 0),
  complete boolean not null default false,
  last_checked_at timestamptz not null,
  last_sweep_batch_id uuid references ii_reference_import_batches(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ii_reference_publication_coverage_present_le_expected check (present_count <= expected_count),
  unique (source_config_id, publication_date)
);
create index if not exists idx_ii_reference_publication_coverage_incomplete
  on ii_reference_publication_coverage(source_config_id, publication_date desc) where not complete;
alter table ii_reference_publication_coverage enable row level security;
drop policy if exists "admin read ii_reference_publication_coverage" on ii_reference_publication_coverage;
create policy "admin read ii_reference_publication_coverage" on ii_reference_publication_coverage
  for select using (is_pc6_reference_data_admin());
comment on table ii_reference_publication_coverage is
  'NAV 1 reconciliation sweep (0221). One row per (source, publication date). complete=true ONLY once a reconciliation sweep has confirmed zero gap against what the source itself published for that date -- never merely because the collection window finished. "Expected" is derived from the source''s own file for that date, never a static instrument universe (see navReconciliationSweep.ts header for why).';
comment on column ii_reference_publication_coverage.complete is
  'Set exclusively by navReconciliationSweep.ts. A window can succeed (referenceIngestJob.ts) on a day the source later republishes more schemes (F-18) -- window success never implies this is true.';

create table if not exists ii_reference_coverage_alerts (
  id uuid primary key default gen_random_uuid(),
  source_config_id text not null,
  publication_date date not null,
  expected_count integer not null check (expected_count >= 0),
  present_count integer not null check (present_count >= 0),
  coverage_ratio numeric,
  baseline_present_count numeric,
  baseline_ratio_threshold numeric not null,
  detail text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_detail text
);
create unique index if not exists uidx_ii_reference_coverage_alerts_open
  on ii_reference_coverage_alerts(source_config_id, publication_date) where resolved_at is null;
create index if not exists idx_ii_reference_coverage_alerts_created on ii_reference_coverage_alerts(created_at desc);
alter table ii_reference_coverage_alerts enable row level security;
drop policy if exists "admin read ii_reference_coverage_alerts" on ii_reference_coverage_alerts;
create policy "admin read ii_reference_coverage_alerts" on ii_reference_coverage_alerts
  for select using (is_pc6_reference_data_admin());
comment on table ii_reference_coverage_alerts is
  'NAV 1 reconciliation sweep (0221). Queryable stand-in for external alerting (none exists in this repository): a row here means expected coverage was materially below the recent baseline after the day''s most recent reconciliation sweep. Self-resolves (resolved_at set) once a later sweep finds coverage recovered.';

alter table ii_reference_import_batches drop constraint if exists ii_reference_import_batches_batch_kind_check;
alter table ii_reference_import_batches
  add constraint ii_reference_import_batches_batch_kind_check
  check (batch_kind in (
    'scheme_master',
    'daily_nav',
    'nav_history',
    'benchmark_level',
    'risk_free_rate',
    'fund_holdings_disclosure',
    'nav_hydration',
    'nav_reconciliation'
  ));

insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'pc6_amfi_daily_nav_reconciliation', true, null
where not exists (select 1 from ii_reference_job_control where job_key = 'pc6_amfi_daily_nav_reconciliation');

-- ============================================================
-- 3/3: 0222_nav1_schedule_reconciliation_window.sql -- APPLY LAST (schedules the route; the route must already be deployed)
-- ============================================================
do $$
begin
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production') then
    perform cron.unschedule('pc6-nav-reconciliation')
    where exists (select 1 from cron.job where jobname = 'pc6-nav-reconciliation');
    raise notice '0222: not the production database -- nothing scheduled; any reconciliation job present was removed.';
    return;
  end if;

  perform cron.unschedule('pc6-nav-reconciliation')
  where exists (select 1 from cron.job where jobname = 'pc6-nav-reconciliation');
  perform cron.schedule(
    'pc6-nav-reconciliation',
    '0-16/2 10 * * *',
    $cron$
    select net.http_post(
      url := 'https://app.financialhealthplatform.com/api/investment-intelligence/cron/pc6-nav-reconciliation',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
      ),
      body := '{"sourceConfigId":"amfi_nav_daily","jobKey":"pc6_amfi_daily_nav_reconciliation"}'::jsonb,
      timeout_milliseconds := 300000
    );
    $cron$
  );

  raise notice '0222: production -- reconciliation window scheduled every day, 10:00-10:16 UTC every 2 min (9 calls; most are no-ops once coverage is confirmed complete).';
end $$;
