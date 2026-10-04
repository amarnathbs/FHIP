-- 0261 -- Stage 2 of the fund analytics work: the pinned Fund analytics report, its NAV dependency manifest, the shared
-- result cache store, the PDF render tokens, and the retention predicate that protects a
-- finalised fund analytics reports NAV range.
--
-- Forward-only, additive, idempotent. HAND-OVER ARTEFACT: NOT APPLIED anywhere. Apply AFTER 0260.
--
-- THE ONE FUNCTION REDEFINITION. pc6_nav_row_is_candidate() is redefined to add ONE more
-- protected case (a fund analytics reports pinned NAV range, directly and through the merge family).
-- Its body is the 0219 definition VERBATIM (0219 is the latest definition of it: 0220+ do not
-- redefine it, checked by grep over supabase/migrations on 2026-10-04) with exactly two added
-- `or exists (...)` branches, so no predecessor protection is lost. The verification script
-- scripts/nav2_0260_0262_pglite_verification.mjs replays the chain, proves every 0219 behaviour
-- is unchanged and proves the new protection, with a negative control against the 0219 body.
-- EXECUTE stays service_role only, exactly as in 0219.
--
-- IMMUTABILITY. nav2_fund_analytics_reports rows are pinned output: the update trigger refuses
-- EVERY update, so an issued report can never be silently changed (a later correction raises an
-- alert / a new version, never an edit). Deletion is allowed (account deletion cascades from
-- auth.users, retention is a separate policy).

-- ---------------------------------------------------------------------------
-- 1. The pinned report
-- ---------------------------------------------------------------------------
create table if not exists nav2_fund_analytics_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  version_number integer not null check (version_number >= 1),
  -- The id of the version this one replaces, informational (no FK: pinned rows are never updated).
  supersedes_report_id uuid,
  as_of_date date not null,
  reporting_currency text not null,
  scheme_count integer not null check (scheme_count >= 0),
  policy_version text not null,
  engine_version text not null,
  risk_free_dataset_version text,
  -- The complete issued output and the complete input dependency manifest (spec 13): series checksums,
  -- first / last NAV dates, counts, benchmark and risk-free dataset versions, spec, versions.
  report_json jsonb not null,
  manifest_json jsonb not null,
  manifest_checksum text not null check (manifest_checksum ~ '^[0-9a-f]{64}$'),
  -- Counts of results by typed state across the report (no user data), for the monitoring snapshot.
  state_counts jsonb not null default '{}'::jsonb,
  status text not null default 'ready' check (status in ('ready')),
  created_at timestamptz not null default now(),
  constraint nav2_fund_analytics_reports_user_version unique (user_id, version_number)
);
create index if not exists idx_nav2_reports_user_created on nav2_fund_analytics_reports (user_id, created_at desc);
alter table nav2_fund_analytics_reports enable row level security;
drop policy if exists own_read_nav2_fund_analytics_reports on nav2_fund_analytics_reports;
create policy own_read_nav2_fund_analytics_reports on nav2_fund_analytics_reports for select using (auth.uid() = user_id);
-- Rows are written only by the server (service role) after the Premium check, no session can write.
revoke insert, update, delete, truncate on nav2_fund_analytics_reports from anon, authenticated;

create or replace function nav2_reports_immutable() returns trigger
language plpgsql as $fn$
begin
  raise exception 'nav2_fund_analytics_reports rows are pinned and immutable (update blocked)' using errcode = '42501';
end $fn$;
drop trigger if exists trg_nav2_reports_immutable on nav2_fund_analytics_reports;
create trigger trg_nav2_reports_immutable before update on nav2_fund_analytics_reports
  for each row execute function nav2_reports_immutable();

-- ---------------------------------------------------------------------------
-- 2. The reports NAV dependency manifest (range per instrument), the fund analytics counterpart of
--    ii_report_nav_dependencies (whose report_id is constrained to the Module 9 `reports` table)
-- ---------------------------------------------------------------------------
create table if not exists nav2_report_nav_dependencies (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references nav2_fund_analytics_reports(id) on delete cascade,
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  nav_date_from date,
  nav_date_to date not null,
  series_checksum text,
  created_at timestamptz not null default now(),
  constraint nav2_report_nav_dependencies_range check (nav_date_from is null or nav_date_from <= nav_date_to),
  constraint nav2_report_nav_dependencies_unique unique (report_id, instrument_id)
);
create index if not exists idx_nav2_report_nav_dep_instrument on nav2_report_nav_dependencies (instrument_id, nav_date_to);
alter table nav2_report_nav_dependencies enable row level security;
drop policy if exists admin_read_nav2_report_nav_dependencies on nav2_report_nav_dependencies;
create policy admin_read_nav2_report_nav_dependencies on nav2_report_nav_dependencies for select using (is_pc6_reference_data_admin());
revoke insert, update, delete, truncate on nav2_report_nav_dependencies from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The shared result cache store (service role only, no policies)
-- ---------------------------------------------------------------------------
create table if not exists nav2_result_cache (
  cache_key text primary key,
  bundle_kind text not null default 'scheme_performance',
  scope_hash text,
  instrument_id uuid references ii_instruments(id) on delete cascade,
  metric_id text not null,
  policy_version text not null,
  definition_version text not null,
  actual_end date,
  benchmark_id uuid,
  risk_free_dataset_id text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  invalidated_at timestamptz
);
create index if not exists idx_nav2_result_cache_instrument on nav2_result_cache (instrument_id) where invalidated_at is null;
create index if not exists idx_nav2_result_cache_benchmark on nav2_result_cache (benchmark_id) where invalidated_at is null;
create index if not exists idx_nav2_result_cache_risk_free on nav2_result_cache (risk_free_dataset_id) where invalidated_at is null;
alter table nav2_result_cache enable row level security;
revoke all on nav2_result_cache from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. PDF render tokens (single use, short lived, service role only)
-- ---------------------------------------------------------------------------
create table if not exists nav2_report_render_tokens (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  report_id uuid not null references nav2_fund_analytics_reports(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_nav2_report_render_tokens_expires on nav2_report_render_tokens (expires_at);
alter table nav2_report_render_tokens enable row level security;
revoke all on nav2_report_render_tokens from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. pc6_nav_row_is_candidate(): the 0219 body verbatim + the fund analytics report pin
-- ---------------------------------------------------------------------------
create or replace function pc6_nav_row_is_candidate(p_instrument_id uuid, p_price_date date, p_changeover_date date)
returns boolean
language sql stable as $fn$
  with recursive merge_family(instrument_id, depth) as (
    select p_instrument_id, 0
    union
    select x.other, f.depth + 1
    from merge_family f
    cross join lateral (
      select i.merged_into_instrument_id as other from ii_instruments i
        where i.id = f.instrument_id and i.merged_into_instrument_id is not null
      union all
      select i.id from ii_instruments i where i.merged_into_instrument_id = f.instrument_id
      union all
      select s.merged_into_instrument_id from ii_scheme_master s
        where s.instrument_id = f.instrument_id and s.merged_into_instrument_id is not null
      union all
      select s.instrument_id from ii_scheme_master s
        where s.merged_into_instrument_id = f.instrument_id and s.instrument_id is not null
    ) x
    where f.depth < 8
  )
  select coalesce(not (
    p_price_date >= p_changeover_date
    or pc6_instrument_is_user_held(p_instrument_id)
    or exists (
      select 1 from ii_instrument_benchmarks ib where ib.instrument_id = p_instrument_id
    )
    or exists (
      select 1 from ii_report_nav_dependencies d
      where d.instrument_id = p_instrument_id
        and p_price_date <= d.nav_date_to
        and (d.nav_date_from is null or p_price_date >= d.nav_date_from)
    )
    -- Fund analytics (0261): a finalised Fund analytics reports pinned NAV range.
    or exists (
      select 1 from nav2_report_nav_dependencies d2
      where d2.instrument_id = p_instrument_id
        and p_price_date <= d2.nav_date_to
        and (d2.nav_date_from is null or p_price_date >= d2.nav_date_from)
    )
    or exists (
      select 1 from ii_nav_retention_holds h
      where h.instrument_id = p_instrument_id and h.released_at is null
        and (h.expires_at is null or h.expires_at > now())
    )
    or exists (
      select 1 from ii_nav_source_coverage_gaps g
      where g.instrument_id = p_instrument_id and g.resolved_at is null
        and p_price_date between g.gap_from and g.gap_to
    )
    or exists (
      select 1 from merge_family m
      where m.instrument_id is distinct from p_instrument_id
        and (
          pc6_instrument_is_user_held(m.instrument_id)
          or exists (select 1 from ii_instrument_benchmarks ib where ib.instrument_id = m.instrument_id)
          or exists (select 1 from ii_report_nav_dependencies d where d.instrument_id = m.instrument_id)
          or exists (select 1 from nav2_report_nav_dependencies d2 where d2.instrument_id = m.instrument_id)
          or exists (
            select 1 from ii_nav_retention_holds h
            where h.instrument_id = m.instrument_id and h.released_at is null
              and (h.expires_at is null or h.expires_at > now())
          )
          or exists (
            select 1 from ii_nav_source_coverage_gaps g
            where g.instrument_id = m.instrument_id and g.resolved_at is null
          )
        )
    )
  ), false);
$fn$;

comment on function pc6_nav_row_is_candidate(uuid, date, date) is
  'NAV 1 (0189, hardened 0200, 0219, and 0261 adds nav2_report_nav_dependencies). True only if a NAV row may be deleted: before the '
  'changeover date AND neither its instrument nor any instrument in its merge family is user-held (any '
  'status), benchmark-mapped, report-pinned (Module 9 or fund analytics report), under an open hold, or inside an unresolved '
  'ii_nav_source_coverage_gaps range. Never returns NULL (NULL input = keep). EXECUTE is service_role only: under RLS any '
  'other caller would see no holdings and get TRUE.';

revoke execute on function pc6_nav_row_is_candidate(uuid, date, date) from public, anon, authenticated;
grant execute on function pc6_nav_row_is_candidate(uuid, date, date) to service_role;

-- ROLLBACK: re-run the 0219 definition of pc6_nav_row_is_candidate(), then drop the four tables and the trigger function.
