-- 0232 — Market-index display data (Nifty 50 / BSE Sensex, PRICE index close):
-- admin upload capability, append-only upload audit, and the daily-feed
-- ledger. Supports the India Mutual Fund Investment Report header
-- ("BSE Sensex ... / Nifty 50 ...") and nothing else.
--
-- WHAT THIS MIGRATION DOES
--   1. Adds the separately-NAMED admin capability
--      admin_users.can_upload_market_index_data and its database predicate
--      is_market_index_data_admin() (Admin Architecture Standard sections 2
--      and 4: database layer). Not implied by presence in admin_users, by any
--      other can_* column, or by any role.
--   2. Seeds two ii_benchmarks rows (price-index series, licence_status
--      'unknown'): IN_NIFTY_50_PRI, IN_SENSEX_PRI. They are NOT mapped to any
--      fund in ii_instrument_benchmarks, so loading values into them changes no
--      benchmark comparison anywhere. They deliberately stay licence_status
--      'unknown': the PC6 licence gate (which refuses licence_required /
--      unknown benchmarks for fund-vs-benchmark COMPARISON) is left exactly as
--      it was; the per-upload attestation recorded below is the rights
--      evidence for these display-only header values.
--   3. Creates ii_market_index_batches — an APPEND-ONLY audit ledger: one row
--      per committed upload (uploader, file SHA-256, row counts, date range,
--      and the REQUIRED attestation text) and per daily-feed run. RLS: capability
--      holders may read; nobody may write except through the two SECURITY
--      DEFINER functions below; UPDATE/DELETE/TRUNCATE are blocked by trigger
--      even for the service role. No FK to auth.users on purpose: an FK with
--      ON DELETE SET NULL/CASCADE would require updating/deleting an
--      append-only audit row when an admin account is removed.
--   4. commit_market_index_upload() — the ONE write path for an admin CSV
--      upload. SECURITY DEFINER, search_path pinned, authorises with
--      auth.uid() + is_market_index_data_admin() INSIDE the function (a caller
--      who skips the API route and calls the RPC directly is refused the same
--      way, SQLSTATE 42501), requires the attestation, validates every row,
--      refuses any row that would silently change an already-published value,
--      writes series rows + batch row in ONE transaction (all or nothing), and
--      is idempotent on (index, file SHA-256).
--   5. record_market_index_feed_closes() — the write path for the daily
--      updater. service_role only. Same validations, never overwrites.
--   6. Registers the daily-feed job in ii_reference_job_control SHIPPED
--      DISABLED. NO pg_cron schedule is created here. See
--      docs/investment-intelligence/INDIA_MF_INVESTMENT_REPORT_REPORT.md.
--
-- WHAT THIS DOES NOT DO
--   * It does not widen any shared CHECK constraint (the ii_audit_events
--     event_type list is untouched), so it cannot revoke any sibling branch's
--     values — the audit trail is this migration's own table.
--   * It does not weaken any existing RLS policy or grant.
--   * It does not load any index value.
--
-- ROLLBACK: drop the two functions, the table and the trigger functions, delete
-- the two ii_benchmarks seed rows (and any series rows loaded under them),
-- drop admin_users.can_upload_market_index_data and delete the job-control row.
-- Idempotent: every statement is guarded and may be re-run.

-- ---------------------------------------------------------------------------
-- 1. The named capability and its database predicate
-- ---------------------------------------------------------------------------
alter table admin_users add column if not exists can_upload_market_index_data boolean not null default false;
comment on column admin_users.can_upload_market_index_data is
  'Separately-named capability (Admin Architecture Standard section 2) authorising upload of historical Nifty 50 / BSE Sensex closing values and viewing the upload ledger. Deliberately NOT implied by presence in admin_users nor by any other can_* column.';

create or replace function is_market_index_data_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_users
    where admin_users.user_id = auth.uid()
      and admin_users.can_upload_market_index_data = true
  );
$$;
comment on function is_market_index_data_admin() is
  'True only for an admin_users row with can_upload_market_index_data = true. Backs RLS and the upload RPC at the database layer (Admin Standard section 4: navigation is not authorisation).';
revoke all on function is_market_index_data_admin() from public, anon;
grant execute on function is_market_index_data_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The two price-index benchmark rows (display series only)
-- ---------------------------------------------------------------------------
insert into ii_benchmarks (benchmark_key, benchmark_label, benchmark_category, country_code, return_type, frequency, currency_code, licence_status)
select 'IN_NIFTY_50_PRI', 'Nifty 50 (price index close)', 'index', 'IN', 'PRI', 'business_daily', 'INR', 'unknown'
where not exists (select 1 from ii_benchmarks where benchmark_key = 'IN_NIFTY_50_PRI');

insert into ii_benchmarks (benchmark_key, benchmark_label, benchmark_category, country_code, return_type, frequency, currency_code, licence_status)
select 'IN_SENSEX_PRI', 'BSE Sensex (price index close)', 'index', 'IN', 'PRI', 'business_daily', 'INR', 'unknown'
where not exists (select 1 from ii_benchmarks where benchmark_key = 'IN_SENSEX_PRI');

-- ---------------------------------------------------------------------------
-- 3. The append-only upload / feed ledger
-- ---------------------------------------------------------------------------
create table if not exists ii_market_index_batches (
  id uuid primary key default gen_random_uuid(),
  benchmark_key text not null check (benchmark_key in ('IN_NIFTY_50_PRI', 'IN_SENSEX_PRI')),
  source_kind text not null check (source_kind in ('admin_csv', 'daily_feed')),
  file_name text,
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  source_host text,
  row_count_submitted integer not null check (row_count_submitted >= 0),
  rows_inserted integer not null check (rows_inserted >= 0),
  rows_identical_skipped integer not null default 0 check (rows_identical_skipped >= 0),
  rows_conflicts_skipped integer not null default 0 check (rows_conflicts_skipped >= 0),
  date_from date,
  date_to date,
  uploader_user_id uuid,
  attested boolean not null default false,
  attestation_text text,
  attested_at timestamptz,
  created_at timestamptz not null default now(),
  -- An admin CSV upload without a named uploader, a file hash and an explicit,
  -- recorded attestation is unrepresentable (database-enforced, so a direct
  -- service-role insert cannot bypass it either).
  constraint ii_market_index_batches_csv_attested check (
    source_kind <> 'admin_csv'
    or (attested = true
        and uploader_user_id is not null
        and file_sha256 is not null
        and attested_at is not null
        and attestation_text is not null
        and length(trim(attestation_text)) >= 20)
  )
);
comment on table ii_market_index_batches is
  'Append-only ledger of market-index uploads and daily-feed runs. One row per committed admin CSV upload (uploader, SHA-256, counts, REQUIRED attestation text) and per feed run. UPDATE/DELETE/TRUNCATE are blocked by trigger.';

create unique index if not exists uidx_ii_market_index_batches_csv_file
  on ii_market_index_batches (benchmark_key, file_sha256) where source_kind = 'admin_csv';
create index if not exists idx_ii_market_index_batches_recent
  on ii_market_index_batches (benchmark_key, created_at desc);

alter table ii_market_index_batches enable row level security;
drop policy if exists "capability read ii_market_index_batches" on ii_market_index_batches;
create policy "capability read ii_market_index_batches" on ii_market_index_batches
  for select using (is_market_index_data_admin());
-- No insert/update/delete policy exists: writes happen only inside the two
-- SECURITY DEFINER functions below.
revoke insert, update, delete, truncate on ii_market_index_batches from anon, authenticated;

create or replace function ii_market_index_batches_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'ii_market_index_batches is append-only (% blocked)', tg_op using errcode = '42501';
end $$;
drop trigger if exists trg_ii_market_index_batches_no_update on ii_market_index_batches;
create trigger trg_ii_market_index_batches_no_update
  before update or delete on ii_market_index_batches
  for each row execute function ii_market_index_batches_append_only();
drop trigger if exists trg_ii_market_index_batches_no_truncate on ii_market_index_batches;
create trigger trg_ii_market_index_batches_no_truncate
  before truncate on ii_market_index_batches
  for each statement execute function ii_market_index_batches_append_only();

-- ---------------------------------------------------------------------------
-- 4. commit_market_index_upload — the admin CSV write path
-- ---------------------------------------------------------------------------
create or replace function commit_market_index_upload(
  p_benchmark_key text,
  p_file_sha256 text,
  p_file_name text,
  p_rows jsonb,
  p_attested boolean,
  p_attestation_text text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_bench uuid;
  v_existing public.ii_market_index_batches%rowtype;
  v_batch uuid := gen_random_uuid();
  v_count integer;
  v_distinct integer;
  v_bad integer;
  v_conflicts integer;
  v_inserted integer;
  v_from date;
  v_to date;
begin
  -- Database-layer authorisation (Admin Standard section 4): identity comes
  -- from the session, never from a parameter.
  if v_uid is null or not public.is_market_index_data_admin() then
    raise exception 'market index upload: not authorised' using errcode = '42501';
  end if;
  if p_benchmark_key not in ('IN_NIFTY_50_PRI', 'IN_SENSEX_PRI') then
    raise exception 'market index upload: unsupported index' using errcode = '22023';
  end if;
  if p_attested is distinct from true or p_attestation_text is null or length(trim(p_attestation_text)) < 20 then
    raise exception 'market index upload: the attestation that you hold the right to use this data is required' using errcode = '22023';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'market index upload: a SHA-256 file hash is required' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20000 then
    raise exception 'market index upload: rows must be a non-empty array of at most 20000 entries' using errcode = '22023';
  end if;

  select id into v_bench from public.ii_benchmarks where benchmark_key = p_benchmark_key;
  if v_bench is null then
    raise exception 'market index upload: benchmark row missing (apply migration 0232)' using errcode = '22023';
  end if;

  -- Idempotent: the same file for the same index is never applied twice.
  select * into v_existing from public.ii_market_index_batches
   where benchmark_key = p_benchmark_key and file_sha256 = p_file_sha256 and source_kind = 'admin_csv';
  if found then
    return jsonb_build_object('already_committed', true, 'batch_id', v_existing.id, 'inserted', v_existing.rows_inserted, 'identical', v_existing.rows_identical_skipped);
  end if;

  create temporary table pg_temp.mi_rows on commit drop as
    select (r ->> 'date')::date as d, (r ->> 'close')::numeric as v
      from jsonb_array_elements(p_rows) as r;

  select count(*), count(distinct d), count(*) filter (where d is null or v is null or v <= 0 or d > current_date or d < date '1979-01-01'),
         min(d), max(d)
    into v_count, v_distinct, v_bad, v_from, v_to
    from pg_temp.mi_rows;
  if v_bad > 0 then
    raise exception 'market index upload: % row(s) have a missing/invalid/future date or a non-positive value', v_bad using errcode = '22023';
  end if;
  if v_distinct <> v_count then
    raise exception 'market index upload: duplicate dates in the submitted rows' using errcode = '22023';
  end if;

  -- Never silently change a published value: a different close for an existing
  -- date is a correction, which this path does not perform.
  select count(*) into v_conflicts
    from pg_temp.mi_rows r
    join public.ii_benchmark_series s on s.benchmark_id = v_bench and s.series_date = r.d
   where s.quality_status <> 'superseded' and abs(s.value - r.v) > 0.000001;
  if v_conflicts > 0 then
    raise exception 'market index upload: % date(s) already hold a different published value; nothing was written', v_conflicts using errcode = '23505';
  end if;

  insert into public.ii_benchmark_series (benchmark_id, series_date, value, currency_code, data_version, quality_status, import_batch_id)
    select v_bench, d, v, 'INR', 'market-index-csv-v1', 'ok', v_batch from pg_temp.mi_rows
    on conflict (benchmark_id, series_date) do nothing;
  get diagnostics v_inserted = row_count;

  insert into public.ii_market_index_batches
    (id, benchmark_key, source_kind, file_name, file_sha256, row_count_submitted, rows_inserted, rows_identical_skipped,
     date_from, date_to, uploader_user_id, attested, attestation_text, attested_at)
  values
    (v_batch, p_benchmark_key, 'admin_csv', left(p_file_name, 255), p_file_sha256, v_count, v_inserted, v_count - v_inserted,
     v_from, v_to, v_uid, true, trim(p_attestation_text), now());

  return jsonb_build_object('already_committed', false, 'batch_id', v_batch, 'inserted', v_inserted, 'identical', v_count - v_inserted);
end $$;
comment on function commit_market_index_upload(text, text, text, jsonb, boolean, text) is
  'Admin CSV write path for Nifty 50 / BSE Sensex closes. Authorises with auth.uid() + is_market_index_data_admin() inside the function; requires the attestation; all-or-nothing; idempotent on (index, file SHA-256); never overwrites a published value.';
revoke all on function commit_market_index_upload(text, text, text, jsonb, boolean, text) from public, anon;
grant execute on function commit_market_index_upload(text, text, text, jsonb, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. record_market_index_feed_closes — the daily updater's write path
-- ---------------------------------------------------------------------------
create or replace function record_market_index_feed_closes(
  p_benchmark_key text,
  p_rows jsonb,
  p_source_host text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_bench uuid;
  v_batch uuid := gen_random_uuid();
  v_count integer;
  v_bad integer;
  v_identical integer;
  v_conflicts integer;
  v_inserted integer;
  v_from date;
  v_to date;
begin
  -- Only the service role (the cron route's server-side client) may call this.
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'market index feed: service role only' using errcode = '42501';
  end if;
  if p_benchmark_key not in ('IN_NIFTY_50_PRI', 'IN_SENSEX_PRI') then
    raise exception 'market index feed: unsupported index' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 400 then
    raise exception 'market index feed: rows must be a non-empty array of at most 400 entries' using errcode = '22023';
  end if;
  select id into v_bench from public.ii_benchmarks where benchmark_key = p_benchmark_key;
  if v_bench is null then
    raise exception 'market index feed: benchmark row missing (apply migration 0232)' using errcode = '22023';
  end if;

  create temporary table pg_temp.mi_feed on commit drop as
    select distinct on (d) (r ->> 'date')::date as d, (r ->> 'close')::numeric as v
      from jsonb_array_elements(p_rows) as r order by d;
  select count(*), count(*) filter (where d is null or v is null or v <= 0 or d > current_date or d < date '1979-01-01'), min(d), max(d)
    into v_count, v_bad, v_from, v_to from pg_temp.mi_feed;
  if v_bad > 0 then
    raise exception 'market index feed: % row(s) invalid', v_bad using errcode = '22023';
  end if;

  select count(*) filter (where abs(s.value - r.v) <= 0.000001),
         count(*) filter (where abs(s.value - r.v) > 0.000001)
    into v_identical, v_conflicts
    from pg_temp.mi_feed r join public.ii_benchmark_series s
      on s.benchmark_id = v_bench and s.series_date = r.d and s.quality_status <> 'superseded';

  insert into public.ii_benchmark_series (benchmark_id, series_date, value, currency_code, data_version, quality_status, import_batch_id)
    select v_bench, d, v, 'INR', 'market-index-feed-v1', 'ok', v_batch from pg_temp.mi_feed
    on conflict (benchmark_id, series_date) do nothing;
  get diagnostics v_inserted = row_count;

  insert into public.ii_market_index_batches
    (id, benchmark_key, source_kind, source_host, row_count_submitted, rows_inserted, rows_identical_skipped, rows_conflicts_skipped, date_from, date_to)
  values (v_batch, p_benchmark_key, 'daily_feed', left(p_source_host, 255), v_count, v_inserted, v_identical, v_conflicts, v_from, v_to);

  return jsonb_build_object('batch_id', v_batch, 'inserted', v_inserted, 'identical', v_identical, 'conflicts_skipped', v_conflicts);
end $$;
comment on function record_market_index_feed_closes(text, jsonb, text) is
  'Daily updater write path. service_role only. Inserts new trading-day closes, never overwrites an existing value (a different value is counted as a skipped conflict for an operator to review).';
revoke all on function record_market_index_feed_closes(text, jsonb, text) from public, anon, authenticated;
grant execute on function record_market_index_feed_closes(text, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The daily-feed job, SHIPPED DISABLED. No pg_cron schedule is created.
-- ---------------------------------------------------------------------------
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'market_index_daily_close', false,
  'Shipped disabled by migration 0232. NSE and BSE restrict automated scraping and redistribution of index data; the Product Owner must confirm NSE/BSE terms or hold a licence before this job is enabled. The cron route additionally requires MARKET_INDEX_FEED_ENABLED=true. No pg_cron schedule exists.'
where not exists (select 1 from ii_reference_job_control where job_key = 'market_index_daily_close');
