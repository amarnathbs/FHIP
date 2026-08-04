-- Module 9: Reports and Exports — historical, immutable monthly reports built
-- from existing Module 3-7 snapshots. This module does not recalculate any
-- score, DNA, resilience or forecast value; it only assembles, narrates and
-- versions what those modules have already produced (Rule 15).

-- ---------------------------------------------------------------------------
-- Entitlements — minimal stand-in for a real subscription/billing system,
-- which does not exist yet anywhere in this platform. Everyone defaults to
-- 'free'; there is no self-service upgrade path (no billing provider wired
-- up), so this table is written to directly (e.g. via SQL) until Module 12
-- admin tooling or a billing integration exists.
-- ---------------------------------------------------------------------------
create table user_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  plan_tier text not null default 'free' check (plan_tier in ('free', 'premium')),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table user_entitlements enable row level security;
create policy "own entitlement" on user_entitlements for select using (auth.uid() = user_id);

-- Backfill existing users as free, and default new signups to free too.
insert into user_entitlements (user_id, plan_tier)
select id, 'free' from auth.users
on conflict (user_id) do nothing;

create or replace function handle_new_user_entitlement()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_entitlements (user_id) values (new.id)
  on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created_entitlement
  after insert on auth.users
  for each row execute function handle_new_user_entitlement();

-- ---------------------------------------------------------------------------
-- Reports — one row per generated report. Published reports are immutable;
-- corrections create a new row (version_number + 1) linked via
-- revises_report_id, with the original marked 'superseded' (Rule 9/10).
-- ---------------------------------------------------------------------------
create table reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id),
  report_type_code text not null check (
    report_type_code in ('monthly_financial_health', 'financial_health_score', 'goal_progress', 'net_worth')
  ),
  report_period_start date not null,
  report_period_end date not null,
  report_month date not null,
  as_of_date date not null,
  title text not null,
  status text not null default 'draft' check (
    status in ('draft', 'queued', 'generating', 'ready', 'published', 'failed', 'revised', 'superseded', 'archived')
  ),
  version_number int not null default 1,
  revises_report_id uuid references reports(id),
  revision_reason text,
  reporting_currency char(3) not null,
  country_scope text not null default 'household',
  financial_snapshot_id uuid references financial_snapshots(id),
  health_score_snapshot_id uuid references financial_health_scores(id),
  resilience_snapshot_id uuid references resilience_scores(id),
  dna_snapshot_id uuid references financial_dna_profiles(id),
  financial_twin_id uuid, -- FK to financial_twin_runs added by the Module 8 migration once that table exists
  template_version text not null default 'report-1.0.0',
  disclaimer_version text not null default 'disclaimer-1.0.0',
  data_completeness_pct numeric(5,2),
  generated_at timestamptz,
  published_at timestamptz,
  failure_code text,
  failure_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_reports_user on reports(user_id, report_month desc);
create unique index idx_reports_official_unique on reports(user_id, report_type_code, report_month)
  where status in ('ready', 'published') and revises_report_id is null;

-- ---------------------------------------------------------------------------
-- Sections — structured content per report. The frontend renders this
-- structured JSON; it never receives a raw HTML blob from the database.
-- ---------------------------------------------------------------------------
create table report_sections (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  section_code text not null,
  section_title text not null,
  display_order int not null default 0,
  section_status text not null default 'included' check (section_status in ('included', 'unavailable', 'omitted')),
  section_data_json jsonb,
  narrative_text text,
  chart_data_json jsonb,
  source_references_json jsonb,
  confidence_level text,
  limitation_text text,
  created_at timestamptz default now()
);
create index idx_report_sections_report on report_sections(report_id, display_order);

-- ---------------------------------------------------------------------------
-- Snapshots — explicit references to the immutable source records/versions
-- used to build the report, for reconciliation and reproducibility
-- (Rule 16/17), without duplicating the underlying raw data.
-- ---------------------------------------------------------------------------
create table report_snapshots (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_type text not null, -- financial|score|dna|resilience|goal|forecast
  source_entity_id uuid,
  source_version text,
  source_as_of_date date,
  payload_hash text,
  snapshot_metadata_json jsonb,
  created_at timestamptz default now()
);
create index idx_report_snapshots_report on report_snapshots(report_id);

-- ---------------------------------------------------------------------------
-- Exports — export requests. No server-side PDF renderer exists yet
-- (Module 9B / feature-gated per the spec's own release staging), so export
-- requests are recorded honestly as failed/not_implemented rather than
-- faking a working pipeline. The in-app report and print stylesheet remain
-- the real "PDF-ready" deliverable for this release.
-- ---------------------------------------------------------------------------
create table report_exports (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  requested_by_user_id uuid not null references auth.users(id) on delete cascade,
  export_format text not null check (export_format in ('pdf', 'print', 'csv')),
  status text not null default 'queued' check (status in ('queued', 'generating', 'ready', 'failed', 'expired')),
  storage_path text,
  file_name text,
  file_size_bytes bigint,
  checksum text,
  renderer_version text,
  requested_at timestamptz default now(),
  completed_at timestamptz,
  expires_at timestamptz,
  download_count int not null default 0,
  error_code text
);
create index idx_report_exports_report on report_exports(report_id);

-- ---------------------------------------------------------------------------
-- Generation runs — audit trail for every generation attempt, manual or
-- scheduled.
-- ---------------------------------------------------------------------------
create table report_generation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  report_id uuid references reports(id),
  job_id uuid not null default gen_random_uuid(),
  trigger_type text not null default 'manual' check (trigger_type in ('manual', 'scheduled')),
  started_at timestamptz default now(),
  completed_at timestamptz,
  input_versions jsonb,
  output_status text,
  retry_count int not null default 0,
  failure_details text,
  worker_version text not null default 'report-worker-1.0.0'
);
create index idx_report_generation_runs_user on report_generation_runs(user_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Access events — view/print/export/download audit trail.
-- ---------------------------------------------------------------------------
create table report_access_events (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('viewed', 'printed', 'exported', 'downloaded')),
  metadata jsonb,
  created_at timestamptz default now()
);
create index idx_report_access_events_report on report_access_events(report_id);

alter table reports enable row level security;
alter table report_sections enable row level security;
alter table report_snapshots enable row level security;
alter table report_exports enable row level security;
alter table report_generation_runs enable row level security;
alter table report_access_events enable row level security;

create policy "own reports" on reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own report sections" on report_sections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own report snapshots" on report_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own report exports" on report_exports
  for all using (auth.uid() = requested_by_user_id) with check (auth.uid() = requested_by_user_id);
create policy "own report generation runs" on report_generation_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own report access events" on report_access_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Scheduled monthly generation via Supabase's built-in pg_cron/pg_net
-- extensions — no external job scheduler required. NOTE: net.http_post
-- requires Supabase's Postgres to be able to reach the target URL over the
-- network. In a local-development setup (this app running on
-- http://localhost:3000 with cloud-hosted Supabase), Supabase cannot reach
-- localhost, so this schedule will fire but the HTTP callback will fail
-- until app_base_url below is updated to a publicly reachable deployment
-- URL. The generation logic itself (/api/reports/cron/monthly-generate) is
-- fully functional and can be triggered directly for testing.
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('monthly-report-generation')
where exists (select 1 from cron.job where jobname = 'monthly-report-generation');

select cron.schedule(
  'monthly-report-generation',
  '0 1 1 * *', -- 01:00 on the 1st of every month
  $$
  select net.http_post(
    url := 'http://localhost:3000/api/reports/cron/monthly-generate',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'fhip-cron-8f3a1c9e2b4d6e7f'),
    body := '{}'::jsonb
  );
  $$
);
