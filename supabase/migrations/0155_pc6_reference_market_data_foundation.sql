-- PC6 (M6) — reference-market-data foundation.
--
-- Forward-only, additive, and idempotent end to end (every statement is
-- guarded), so it is safe to re-run.
--
-- MIGRATION NUMBER FRESHNESS. 0155 was established on 2026-09-15 by
-- `scripts/m6_pc6_migration_freshness_probe.mjs`, which takes the MAXIMUM of
-- three independent sources rather than trusting the repo folder alone:
--   1. this branch's supabase/migrations      -> 0154
--   2. origin/main's supabase/migrations      -> 0148  (under-reports, as this
--      mission has repeatedly found: 0149-0154 exist only on feature branches)
--   3. supabase_migrations.schema_migrations on DEV and PRODUCTION
--      -> UNREADABLE over PostgREST (HTTP 406, the ledger lives in a
--         non-exposed schema), recorded honestly rather than assumed empty
-- The same probe checked, positively, that every table this migration creates
-- is ABSENT from both DEV and production today (all five returned HTTP 404),
-- so 0155 collides with nothing that was applied out-of-band.
--
-- APPLICATION STATUS: NOT APPLIED. `scripts/pc5_ddl_capability_probe.mjs` was
-- re-run on 2026-09-15 and confirmed afresh that this environment has no DDL
-- path to either database (no exec_sql/execute_sql/run_sql/admin_exec/sql/
-- pg_execute/exec/query RPC; no SUPABASE_ACCESS_TOKEN / SUPABASE_MANAGEMENT_TOKEN
-- / SUPABASE_PAT; no DATABASE_URL/POSTGRES_URL). 0155 is verified instead by a
-- full PGlite replay of the whole 0001..0155 chain — see
-- `scripts/pc6_0155_pglite_verification.mjs`. It joins 0153 and 0154 in the
-- queue of migrations awaiting an operator with dashboard/CLI access.
--
-- BOUNDARY (D.1, D.7, AIE10-PC6-01..05). Everything created here is EXTERNAL
-- REFERENCE data: global, tenant-free, world-readable, service-role-write.
-- There is no user_id anywhere in this migration and no table here is ever
-- written from a client request. Nothing here may overwrite a NAV, unit count
-- or value printed on a user's own statement — a PC6 observation is a separate
-- dated fact that sits beside the statement fact, never on top of it.

-- ===========================================================================
-- 1. ii_sources — admit reference-data providers as a source CATEGORY.
--    0031's CHECK allows statement_provider/broker/manual/admin/api_connector.
--    AMFI is none of those: it is not interpreting anyone's document, it is
--    publishing market reference data. A distinct category keeps the PC6/AIE
--    boundary legible in the data itself.
-- ===========================================================================
alter table ii_sources drop constraint if exists ii_sources_source_category_check;
alter table ii_sources add constraint ii_sources_source_category_check
  check (source_category in ('statement_provider', 'broker', 'manual', 'admin', 'api_connector', 'reference_data_provider'));

insert into ii_sources (source_key, source_label, source_category, country_code, is_active, parser_available, metadata)
select 'amfi', 'AMFI (Association of Mutual Funds in India) — public NAV and scheme files', 'reference_data_provider', 'IN', true, true,
       jsonb_build_object(
         'pc6_kind', 'scheme_master+daily_nav+nav_history',
         'canonical_host', 'https://www.amfiindia.com',
         'configured_in', 'lib/config/investment-intelligence/pc6ReferenceSources.ts')
where not exists (select 1 from ii_sources where source_key = 'amfi');

-- ===========================================================================
-- 2. ii_prices_nav — precision widening. A REAL DEFECT FOUND BY REAL DATA.
--    0033 created price as numeric(20, 6). AMFI publishes NAVs with up to
--    EIGHT decimal places: of the 14,361 data rows in NAVAll.txt on
--    2026-09-15, 54 carried 7 dp and 389 carried 8 dp (443 rows, 3.1% of the
--    universe). At scale 6 the importer must either reject 3.1% of real
--    schemes or round them silently; neither is acceptable for a price fact.
--    Widening precision/scale is a metadata-only change in Postgres for
--    existing rows — no value is altered and no row is rewritten.
-- ===========================================================================
alter table ii_prices_nav alter column price type numeric(24, 10);
comment on column ii_prices_nav.price is
  'numeric(24,10) since PC6/0155. AMFI publishes up to 8 decimal places; the original numeric(20,6) would have silently rounded 443 of 14,361 real schemes (measured 2026-09-15).';

-- Batch lineage + the record checksum that makes re-import idempotent by
-- CONTENT rather than by mere presence.
alter table ii_prices_nav add column if not exists import_batch_id uuid;
alter table ii_prices_nav add column if not exists record_checksum text;
alter table ii_prices_nav add column if not exists superseded_by_id uuid references ii_prices_nav(id);
alter table ii_prices_nav add column if not exists correction_of_id uuid references ii_prices_nav(id);
comment on column ii_prices_nav.record_checksum is
  'Content hash of the source record. Re-importing identical content is a no-op; a DIFFERENT checksum for the same (instrument, date) is a source CORRECTION, which inserts a new row and marks the prior one superseded rather than overwriting it (D.3).';

-- N.5 "no future dates". A CHECK cannot call now() (not immutable), so the
-- invariant is enforced by a trigger, which is stronger anyway: it also fires
-- on a direct service-role insert that bypasses the importer entirely.
create or replace function ii_prices_nav_reject_future_date() returns trigger
language plpgsql as $$
begin
  if new.price_date > (current_date + interval '1 day') then
    raise exception 'PC6: NAV date % is in the future (today is %). Reference prices are never forward-dated.', new.price_date, current_date
      using errcode = '23514';
  end if;
  return new;
end $$;
comment on function ii_prices_nav_reject_future_date() is
  'PC6/N.5. One day of slack absorbs the UTC/IST boundary: an Indian NAV published on the evening of day D is still D in IST while a UTC server has already ticked to D+1. Anything beyond that is a clock or parsing fault, not a timezone.';
drop trigger if exists trg_ii_prices_nav_no_future_date on ii_prices_nav;
create trigger trg_ii_prices_nav_no_future_date
  before insert or update on ii_prices_nav
  for each row execute function ii_prices_nav_reject_future_date();

-- ===========================================================================
-- 3. ii_scheme_master — effective-dated Indian mutual-fund scheme master (N.3)
--
--    One row per (instrument, effective period). Economically distinct
--    plans/options are NOT collapsed: each AMFI scheme code is its own
--    ii_instruments row and its own scheme-master row, and the raw AMFI plan
--    and option strings are preserved verbatim alongside the coarse
--    normalised enums (AMFI publishes 350 distinct option spellings).
-- ===========================================================================
create table if not exists ii_scheme_master (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,

  -- Identity
  amfi_scheme_code text not null,
  scheme_name text not null,
  amc_name text,                       -- null where AMFI omitted the AMC sub-header (23 real rows on 2026-09-15)
  isin_growth_or_payout text,
  isin_reinvestment text,

  -- Variant — never collapsed
  plan_raw text,
  plan_type text check (plan_type is null or plan_type in ('direct', 'regular', 'not_applicable')),
  option_raw text,
  option_type text check (option_type is null or option_type in ('growth', 'idcw', 'dividend_payout', 'dividend_reinvestment', 'not_applicable')),

  -- Structure / taxonomy, verbatim from AMFI's own section headers
  scheme_structure text not null check (scheme_structure in ('open_ended', 'close_ended', 'interval')),
  category_header_raw text not null,
  category_group text,
  sub_category text,

  -- Lifecycle. AMFI's public files do not publish inception/closure/merger
  -- dates, so these stay NULL until a source that does publish them is
  -- governed. A NULL here means "not published", never "assume today".
  lifecycle_status text not null default 'active' check (lifecycle_status in ('active', 'closed', 'merged', 'suspended', 'unknown')),
  inception_date date,
  closure_date date,
  merger_date date,
  merged_into_instrument_id uuid references ii_instruments(id),

  -- Canonical currency/country
  country_code char(2) not null references countries(country_code),
  currency_code char(3) not null references currencies(currency_code),

  -- Provenance + effective dating
  source_id uuid references ii_sources(id),
  import_batch_id uuid,
  record_checksum text not null,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),

  constraint ii_scheme_master_effective_range check (effective_to is null or effective_to >= effective_from),
  constraint ii_scheme_master_merged_requires_target check (lifecycle_status <> 'merged' or merged_into_instrument_id is not null)
);
-- Exactly one OPEN (current) row per AMFI scheme code per country.
create unique index if not exists uidx_ii_scheme_master_current
  on ii_scheme_master(country_code, amfi_scheme_code) where effective_to is null;
create unique index if not exists uidx_ii_scheme_master_period
  on ii_scheme_master(country_code, amfi_scheme_code, effective_from);
create index if not exists idx_ii_scheme_master_instrument on ii_scheme_master(instrument_id);
create index if not exists idx_ii_scheme_master_isin on ii_scheme_master(isin_growth_or_payout) where isin_growth_or_payout is not null;
create index if not exists idx_ii_scheme_master_category on ii_scheme_master(country_code, category_header_raw);
alter table ii_scheme_master enable row level security;
drop policy if exists "read ii_scheme_master" on ii_scheme_master;
create policy "read ii_scheme_master" on ii_scheme_master for select using (true);
-- No insert/update/delete policy for the authenticated role — service-role
-- ingestion only, same discipline as every other ii_* reference table.
comment on table ii_scheme_master is
  'PC6/N.3. Effective-dated Indian mutual-fund scheme master built from AMFI''s own public files. Global reference data: no user_id, no tenancy. Never the authority for what a user''s statement said (D.7).';

-- ===========================================================================
-- 4. ii_scheme_alias_history — historical scheme names (N.3)
--    ii_scheme_alias_map (0041) is the CURATED raw-name -> instrument mapping
--    used by statement resolution. This table is the different thing N.3 asks
--    for: the master's own name history, effective-dated, with provenance.
-- ===========================================================================
create table if not exists ii_scheme_alias_history (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id) on delete cascade,
  scheme_name text not null,
  amfi_scheme_code text,
  observed_from date not null,
  observed_to date,
  source_id uuid references ii_sources(id),
  import_batch_id uuid,
  created_at timestamptz not null default now(),
  constraint ii_scheme_alias_history_range check (observed_to is null or observed_to >= observed_from),
  unique (instrument_id, scheme_name, observed_from)
);
create index if not exists idx_ii_scheme_alias_history_instrument on ii_scheme_alias_history(instrument_id);
alter table ii_scheme_alias_history enable row level security;
drop policy if exists "read ii_scheme_alias_history" on ii_scheme_alias_history;
create policy "read ii_scheme_alias_history" on ii_scheme_alias_history for select using (true);

-- ===========================================================================
-- 5. Admin capability (Admin Architecture Standard §2, §4, §6)
--    A separately-NAMED capability, never implied by mere presence in
--    admin_users. Mirrors the LR-9 precedent (0132).
--
--    DEFINED HERE, BEFORE THE OPERATIONAL TABLES, because every one of their
--    RLS policies calls it — a policy referencing a not-yet-created function
--    aborts the migration.
-- ===========================================================================
alter table admin_users add column if not exists can_view_reference_data_quality boolean not null default false;
comment on column admin_users.can_view_reference_data_quality is
  'PC6/N.11: a separately-named, separately-tested capability (Admin Architecture Standard §2) authorising the read-only reference-market-data quality surface. Deliberately NOT implied by mere presence in admin_users.';

create or replace function is_pc6_reference_data_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admin_users
    where admin_users.user_id = auth.uid()
      and can_view_reference_data_quality = true
  );
$$;
comment on function is_pc6_reference_data_admin() is
  'PC6/N.11. True only for an admin_users row with can_view_reference_data_quality=true — never true merely for being present in admin_users. Backs the RLS on every PC6 operational table (Admin Standard §4: navigation is not authorisation; enforce at the DB layer too).';

-- ===========================================================================
-- 6. ii_reference_import_batches — the job/batch ledger (N.4, N.11, N.15)
--    The repository had NO job-run table before this (audit events only), so
--    "did the job run, and did it succeed" was previously answerable only from
--    pg_cron's own internals. N.11 requires "failed import batches" and "last
--    successful job" on an operator surface; that needs a real table.
-- ===========================================================================
create table if not exists ii_reference_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  /** Which pc6ReferenceSources.ts entry produced this batch. */
  source_config_id text not null,
  batch_kind text not null check (batch_kind in ('scheme_master', 'daily_nav', 'nav_history', 'benchmark_level', 'risk_free_rate')),

  -- What was asked for
  window_from date,
  window_to date,
  as_of_date date not null,

  -- Where it came from, and proof of exactly which bytes
  source_url text,
  source_byte_length bigint,
  source_sha256 text,
  source_retrieved_at timestamptz,
  parser_version text,

  -- Lifecycle
  status text not null check (status in ('running', 'succeeded', 'failed', 'rolled_back', 'skipped_kill_switch', 'skipped_source_outage')),
  attempt integer not null default 1 check (attempt >= 1),
  started_at timestamptz not null default now(),
  finished_at timestamptz,

  -- Outcome counts (N.16 "exact source-vs-database counts")
  rows_read integer not null default 0,
  rows_accepted integer not null default 0,
  rows_rejected integer not null default 0,
  rows_inserted integer not null default 0,
  rows_unchanged integer not null default 0,
  rows_superseded integer not null default 0,

  error_code text,
  error_detail text,
  notes jsonb,
  created_at timestamptz not null default now(),

  constraint ii_reference_import_batches_terminal_has_finish
    check (status = 'running' or finished_at is not null),
  constraint ii_reference_import_batches_failed_has_error
    check (status <> 'failed' or error_code is not null)
);
create index if not exists idx_ii_reference_import_batches_source_started
  on ii_reference_import_batches(source_key, batch_kind, started_at desc);
create index if not exists idx_ii_reference_import_batches_status
  on ii_reference_import_batches(status, started_at desc);
alter table ii_reference_import_batches enable row level security;
drop policy if exists "admin read ii_reference_import_batches" on ii_reference_import_batches;
-- Deliberately NOT world-readable: this is operational telemetry (source URLs,
-- error details, run timings), not reference data a user needs. Readable only
-- by an admin holding the PC6 capability, via the predicate in section 9.
create policy "admin read ii_reference_import_batches" on ii_reference_import_batches
  for select using (is_pc6_reference_data_admin());

-- ===========================================================================
-- 7. ii_reference_import_rejections — every record the parser refused (N.4)
-- ===========================================================================
create table if not exists ii_reference_import_rejections (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references ii_reference_import_batches(id) on delete cascade,
  source_line integer,
  reason text not null,
  detail text not null,
  raw_excerpt text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ii_reference_import_rejections_batch on ii_reference_import_rejections(batch_id, reason);
alter table ii_reference_import_rejections enable row level security;
drop policy if exists "admin read ii_reference_import_rejections" on ii_reference_import_rejections;
create policy "admin read ii_reference_import_rejections" on ii_reference_import_rejections
  for select using (is_pc6_reference_data_admin());
comment on column ii_reference_import_rejections.raw_excerpt is
  'A line from a PUBLIC market-data file. Contains no user data of any kind — PC6 never ingests a user document (D.1/AIE10-PC6-01).';

-- ===========================================================================
-- 8. ii_reference_corrections — audited manual corrections (N.11)
--    "Any manual correction must be audited." Append-only by construction:
--    there is no update or delete policy, and the table records the before
--    value, the after value, the actor and the reason.
-- ===========================================================================
create table if not exists ii_reference_corrections (
  id uuid primary key default gen_random_uuid(),
  target_table text not null check (target_table in ('ii_prices_nav', 'ii_benchmark_series', 'ii_risk_free_rates', 'ii_scheme_master', 'ii_instrument_benchmarks')),
  target_row_id uuid not null,
  correction_kind text not null check (correction_kind in ('source_correction', 'manual_admin_correction', 'quality_status_change', 'mapping_override')),
  previous_value jsonb,
  new_value jsonb,
  actor_admin_id uuid,
  actor_kind text not null check (actor_kind in ('system_import', 'admin')),
  reason text not null,
  created_at timestamptz not null default now(),
  -- A human correction must be attributable and reasoned; a system correction
  -- carries the batch that made it instead of an actor.
  constraint ii_reference_corrections_admin_attributed
    check (actor_kind <> 'admin' or (actor_admin_id is not null and length(trim(reason)) >= 20)),
  batch_id uuid references ii_reference_import_batches(id)
);
create index if not exists idx_ii_reference_corrections_target on ii_reference_corrections(target_table, target_row_id, created_at desc);
alter table ii_reference_corrections enable row level security;
drop policy if exists "admin read ii_reference_corrections" on ii_reference_corrections;
create policy "admin read ii_reference_corrections" on ii_reference_corrections
  for select using (is_pc6_reference_data_admin());

-- ===========================================================================
-- 9. ii_reference_job_control — kill switch + schedule state (N.15)
--    The repo had NO kill switch for any cron job before this: the only way
--    to stop a sweep was cron.unschedule() or rotating the Vault secret.
--    N.15 requires one, so PC6 introduces a DB-backed switch (the pattern
--    ai_platform_controls already established for AI), which an operator can
--    flip without a deploy and which fails CLOSED if the row is missing.
-- ===========================================================================
create table if not exists ii_reference_job_control (
  job_key text primary key,
  enabled boolean not null default false,
  /** Why it is off. Mandatory when disabling, so a silent kill is impossible. */
  disabled_reason text,
  disabled_by_admin_id uuid,
  disabled_at timestamptz,
  last_success_at timestamptz,
  last_success_batch_id uuid references ii_reference_import_batches(id),
  last_failure_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  /** Exponential backoff floor: the runner refuses to start before this. */
  next_attempt_not_before timestamptz,
  updated_at timestamptz not null default now(),
  constraint ii_reference_job_control_disabled_has_reason
    check (enabled or disabled_reason is not null)
);
alter table ii_reference_job_control enable row level security;
drop policy if exists "admin read ii_reference_job_control" on ii_reference_job_control;
create policy "admin read ii_reference_job_control" on ii_reference_job_control
  for select using (is_pc6_reference_data_admin());

insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'pc6_amfi_daily_nav', false,
       'Ships DISABLED. Per this mission''s binding override, no production schedule may be activated by an autonomous agent; enabling is a deferred human-present step.'
where not exists (select 1 from ii_reference_job_control where job_key = 'pc6_amfi_daily_nav');

insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'pc6_amfi_scheme_master', false,
       'Ships DISABLED. Per this mission''s binding override, no production schedule may be activated by an autonomous agent; enabling is a deferred human-present step.'
where not exists (select 1 from ii_reference_job_control where job_key = 'pc6_amfi_scheme_master');

-- ===========================================================================
-- 10. Benchmark master completion (N.7)
-- ===========================================================================
alter table ii_benchmarks add column if not exists frequency text
  check (frequency is null or frequency in ('daily', 'business_daily', 'monthly'));
alter table ii_benchmarks add column if not exists source_id uuid references ii_sources(id);
alter table ii_benchmarks add column if not exists currency_code char(3) references currencies(currency_code);
alter table ii_benchmarks add column if not exists effective_from date not null default '1900-01-01';
alter table ii_benchmarks add column if not exists effective_to date;
alter table ii_benchmarks add column if not exists lifecycle_status text not null default 'active'
  check (lifecycle_status in ('active', 'deprecated'));
alter table ii_benchmarks add column if not exists licence_status text not null default 'unknown'
  check (licence_status in ('public_open', 'licence_required', 'licensed_held', 'unknown'));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ii_benchmarks_effective_range') then
    alter table ii_benchmarks add constraint ii_benchmarks_effective_range check (effective_to is null or effective_to >= effective_from);
  end if;
end $$;
comment on column ii_benchmarks.licence_status is
  'PC6/N.7. licence_required means the series may NOT be ingested without a commercial agreement. NSE/NIFTY and BSE/SENSEX index levels are licence_required — see BLOCKER PO-PC6-1. PC6 ships the machinery and ingests no unlicensed index level.';

-- ===========================================================================
-- 11. Governed category defaults (N.8)
--     A default benchmark for a category is only usable if a named admin
--     approved it. The CHECK makes an unapproved default unrepresentable.
-- ===========================================================================
create table if not exists ii_benchmark_category_defaults (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null references countries(country_code),
  /** AMFI's own category header, verbatim — the same string ii_scheme_master stores. */
  category_header_raw text not null,
  benchmark_id uuid not null references ii_benchmarks(id),
  effective_from date not null,
  effective_to date,
  approved_by_admin_id uuid not null,
  approved_at timestamptz not null,
  rationale text not null,
  created_at timestamptz not null default now(),
  constraint ii_benchmark_category_defaults_range check (effective_to is null or effective_to >= effective_from),
  constraint ii_benchmark_category_defaults_reasoned check (length(trim(rationale)) >= 20),
  unique (country_code, category_header_raw, effective_from)
);
create index if not exists idx_ii_benchmark_category_defaults_lookup
  on ii_benchmark_category_defaults(country_code, category_header_raw, effective_from);
alter table ii_benchmark_category_defaults enable row level security;
drop policy if exists "read ii_benchmark_category_defaults" on ii_benchmark_category_defaults;
create policy "read ii_benchmark_category_defaults" on ii_benchmark_category_defaults for select using (true);
comment on table ii_benchmark_category_defaults is
  'PC6/N.8. A category default is usable ONLY when explicitly governed: an approver, an approval time and a reasoned rationale are all required by CHECK. Deliberately seeded EMPTY — guessing that, say, every large-cap fund benchmarks to NIFTY 50 is exactly what N.8 forbids.';

-- ===========================================================================
-- 12. Mapping basis + audited override (N.8)
-- ===========================================================================
alter table ii_instrument_benchmarks add column if not exists mapping_basis text
  check (mapping_basis is null or mapping_basis in ('scheme_disclosed', 'governed_category_default', 'admin_override'));
alter table ii_instrument_benchmarks add column if not exists override_actor_admin_id uuid;
alter table ii_instrument_benchmarks add column if not exists override_reason text;
alter table ii_instrument_benchmarks add column if not exists override_recorded_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ii_instrument_benchmarks_override_audited') then
    alter table ii_instrument_benchmarks add constraint ii_instrument_benchmarks_override_audited check (
      mapping_basis is distinct from 'admin_override'
      or (override_actor_admin_id is not null
          and override_recorded_at is not null
          and length(trim(coalesce(override_reason, ''))) >= 20)
    );
  end if;
end $$;
comment on constraint ii_instrument_benchmarks_override_audited on ii_instrument_benchmarks is
  'PC6/N.8 "admin override with audit". An override without actor, timestamp and a >=20-character reason is unrepresentable — enforced in the DB, so a direct service-role insert cannot bypass it either.';

-- ===========================================================================
-- 13. Benchmark series — batch lineage and correction provenance (N.9)
-- ===========================================================================
alter table ii_benchmark_series add column if not exists import_batch_id uuid;
alter table ii_benchmark_series add column if not exists record_checksum text;
alter table ii_benchmark_series add column if not exists superseded_by_id uuid references ii_benchmark_series(id);
alter table ii_benchmark_series add column if not exists source_as_of timestamptz;

create or replace function ii_benchmark_series_reject_future_date() returns trigger
language plpgsql as $$
begin
  if new.series_date > (current_date + interval '1 day') then
    raise exception 'PC6: benchmark series date % is in the future (today is %).', new.series_date, current_date
      using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_ii_benchmark_series_no_future_date on ii_benchmark_series;
create trigger trg_ii_benchmark_series_no_future_date
  before insert or update on ii_benchmark_series
  for each row execute function ii_benchmark_series_reject_future_date();

-- ===========================================================================
-- 14. Risk-free methodology record (N.10)
--     A rate without a methodology is an unattributed assertion. This table
--     is created EMPTY and stays empty until the Product Owner chooses a
--     source — BLOCKER PO-PC6-2. The existing 16 DEV rows in
--     ii_risk_free_rates self-describe as "DEV SEED ... (not a certified
--     feed)" and are left exactly as they are: PC6 does not promote them and
--     does not delete them.
-- ===========================================================================
create table if not exists ii_risk_free_methodology (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null references countries(country_code),
  source_key text not null,
  tenor text not null,
  method text not null check (method in ('period_average', 'period_end', 'auction_cutoff_carry_forward', 'policy_step')),
  gap_rule text not null,
  version text not null,
  reference text not null,
  approved_by_admin_id uuid not null,
  approved_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (country_code, version)
);
alter table ii_risk_free_methodology enable row level security;
drop policy if exists "read ii_risk_free_methodology" on ii_risk_free_methodology;
create policy "read ii_risk_free_methodology" on ii_risk_free_methodology for select using (true);
comment on table ii_risk_free_methodology is
  'PC6/N.10. Created intentionally EMPTY. No risk-free source has been approved for any country; PC6 refuses to pick one on its own authority. See BLOCKER PO-PC6-2 in PC6_MARKET_DATA_CERTIFICATION_2026-09-15.md.';

alter table ii_risk_free_rates add column if not exists methodology_id uuid references ii_risk_free_methodology(id);
alter table ii_risk_free_rates add column if not exists is_certified boolean not null default false;
comment on column ii_risk_free_rates.is_certified is
  'PC6/N.10. false for every existing row (they are self-declared DEV seeds). Sharpe/Sortino built on an uncertified rate must be labelled provisional.';

-- ===========================================================================
-- 15. NO pg_cron SCHEDULE IS REGISTERED BY THIS MIGRATION.
--
--     Every prior scheduler migration in this repo (0010, 0135, 0149) ends
--     with a cron.schedule(...) call. 0155 deliberately does NOT, because the
--     mission's binding override states that this execution environment's
--     safety controls do not permit an autonomous agent to activate a
--     production job without a human present.
--
--     The route, its kill switch, its retry/backoff, its batch ledger and its
--     partial-batch semantics are all built and proven in DEV. Turning the
--     schedule on is a DEFERRED HUMAN-PRESENT STEP, documented in
--     docs/investment-intelligence/PC6_OPERATOR_RUNBOOK.md, which carries the
--     exact cron.schedule statement to run and the Vault secret to create.
--     Putting it here commented-out would still be putting it in the chain's
--     execution path one careless uncomment away; the runbook is the safer
--     home for it.
-- ===========================================================================
