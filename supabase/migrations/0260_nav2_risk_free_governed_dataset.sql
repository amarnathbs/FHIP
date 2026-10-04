-- 0260 -- NAV2 Stage 2: the governed RISK-FREE dataset (RBI 91-day T-bill cut-off yield,
-- RBI policy repo rate): series registry, observations, append-only batch ledger,
-- review queue, correction ledger, state-change log, the two named admin capabilities,
-- their database predicates, the upload / refresh / review / state / correction RPCs, and
-- the job-control kill-switch rows (all SHIPPED DISABLED).
--
-- Forward-only, additive, idempotent. No existing CHECK constraint is dropped or
-- recreated. HAND-OVER ARTEFACT: NOT APPLIED anywhere (DEV or production). Apply order:
-- 0260, then 0261, then 0262 (see docs/nav2/po_apply_0260_0262/README.md).
--
-- MIGRATION NUMBER FRESHNESS. Scanned 2026-10-04 across every worktree and remote branch:
-- the highest taken number is 0252 (feat/factsheet-benchmark-reader-20261003); 0260 is free.
--
-- ADMIN ARCHITECTURE STANDARD (docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md), applied:
--   section 2  two SEPARATELY NAMED capabilities, each its own column and predicate:
--                can_upload_risk_free_data     upload, review-queue decisions, corrections
--                can_switch_risk_free_series   turn a series on / off, set its terms status
--              Neither is implied by admin_users membership, by each other, or by any
--              benchmark / reference-data capability.
--   section 4  database layer: every write is a SECURITY DEFINER function that checks
--              auth.uid() and the predicate INSIDE; no table grants INSERT / UPDATE / DELETE
--              to authenticated or anon.
--   section 6  fixed search_path, schema-qualified references, explicit return type (jsonb
--              with a documented shape), EXECUTE revoked from PUBLIC and anon.
--   section 8  an unauthorised caller gets an exception (42501), never an empty result.
--   section 9  the series and observations are GLOBAL reference data with no tenancy column.
--
-- TERMS (PO decision 2026-10-03): RBI publishes no explicit reuse licence ("All Rights
-- Reserved"). The PO accepted that risk; it is recorded per series as terms_review_status
-- 'po_accepted_2026-10-03', never as a granted licence.

-- ---------------------------------------------------------------------------
-- 1. Capabilities and predicates
-- ---------------------------------------------------------------------------
alter table admin_users add column if not exists can_upload_risk_free_data boolean not null default false;
comment on column admin_users.can_upload_risk_free_data is
  'Separately-named capability (Admin Architecture Standard section 2): upload risk-free observations (CSV), decide review-queue items, correct a published observation. NOT implied by admin_users membership nor by any other can_* column.';
alter table admin_users add column if not exists can_switch_risk_free_series boolean not null default false;
comment on column admin_users.can_switch_risk_free_series is
  'Separately-named capability (Admin Architecture Standard section 2): switch a risk-free series on or off and set its terms status. NOT implied by can_upload_risk_free_data, nor the reverse.';

create or replace function is_risk_free_data_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_users
    where admin_users.user_id = auth.uid() and admin_users.can_upload_risk_free_data = true
  );
$$;
revoke all on function is_risk_free_data_admin() from public, anon;
grant execute on function is_risk_free_data_admin() to authenticated, service_role;

create or replace function is_risk_free_series_switch_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_users
    where admin_users.user_id = auth.uid() and admin_users.can_switch_risk_free_series = true
  );
$$;
revoke all on function is_risk_free_series_switch_admin() from public, anon;
grant execute on function is_risk_free_series_switch_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The series registry (global reference data)
-- ---------------------------------------------------------------------------
create table if not exists ii_risk_free_series (
  series_id text primary key check (series_id in ('RBI_91D_TBILL_CUTOFF_YIELD', 'RBI_POLICY_REPO_RATE')),
  series_name text not null,
  role text not null check (role in ('primary', 'secondary')),
  source text not null,
  attribution_text text not null,
  cadence text not null check (cadence in ('weekly_auction', 'policy_change')),
  max_staleness_days integer not null check (max_staleness_days between 1 and 400),
  enabled boolean not null default true,
  terms_review_status text not null default 'po_accepted_2026-10-03'
    check (terms_review_status in ('po_accepted_2026-10-03', 'confirmed_in_writing', 'pending_confirmation', 'declined')),
  -- policy_change series only: the date the series was last confirmed complete.
  verified_through_date date,
  updated_at timestamptz not null default now()
);
comment on table ii_risk_free_series is
  'NAV2 risk-free series registry. One row per governed series; enabled and terms_review_status change ONLY through set_risk_free_series_state() (audited). Global reference data: readable by authenticated, never writable by a session.';
alter table ii_risk_free_series enable row level security;
drop policy if exists "read ii_risk_free_series" on ii_risk_free_series;
create policy "read ii_risk_free_series" on ii_risk_free_series for select using (true);
revoke insert, update, delete, truncate on ii_risk_free_series from anon, authenticated;

insert into ii_risk_free_series (series_id, series_name, role, source, attribution_text, cadence, max_staleness_days)
select 'RBI_91D_TBILL_CUTOFF_YIELD', 'RBI 91-day Treasury bill auction cut-off yield', 'primary', 'Reserve Bank of India', 'Source: Reserve Bank of India', 'weekly_auction', 21
where not exists (select 1 from ii_risk_free_series where series_id = 'RBI_91D_TBILL_CUTOFF_YIELD');
insert into ii_risk_free_series (series_id, series_name, role, source, attribution_text, cadence, max_staleness_days)
select 'RBI_POLICY_REPO_RATE', 'RBI policy repo rate', 'secondary', 'Reserve Bank of India', 'Source: Reserve Bank of India', 'policy_change', 90
where not exists (select 1 from ii_risk_free_series where series_id = 'RBI_POLICY_REPO_RATE');

-- ---------------------------------------------------------------------------
-- 3. The append-only batch ledger
-- ---------------------------------------------------------------------------
create table if not exists ii_risk_free_batches (
  id uuid primary key default gen_random_uuid(),
  series_id text not null references ii_risk_free_series(series_id),
  source_kind text not null check (source_kind in ('admin_csv', 'weekly_refresh')),
  file_name text,
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  rows_submitted integer not null check (rows_submitted >= 0),
  rows_inserted integer not null check (rows_inserted >= 0),
  rows_identical_skipped integer not null default 0 check (rows_identical_skipped >= 0),
  rows_review_queued integer not null default 0 check (rows_review_queued >= 0),
  date_from date,
  date_to date,
  uploader_user_id uuid,
  attested boolean not null default false,
  attestation_text text,
  attested_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ii_risk_free_batches_csv_attested check (
    source_kind <> 'admin_csv'
    or (attested = true and uploader_user_id is not null and file_sha256 is not null
        and attested_at is not null and attestation_text is not null and length(trim(attestation_text)) >= 20)
  )
);
create unique index if not exists uidx_ii_risk_free_batches_csv_file
  on ii_risk_free_batches (series_id, file_sha256) where source_kind = 'admin_csv';
create index if not exists idx_ii_risk_free_batches_recent on ii_risk_free_batches (series_id, created_at desc);
alter table ii_risk_free_batches enable row level security;
drop policy if exists "capability read ii_risk_free_batches" on ii_risk_free_batches;
create policy "capability read ii_risk_free_batches" on ii_risk_free_batches
  for select using (is_risk_free_data_admin() or is_risk_free_series_switch_admin());
revoke insert, update, delete, truncate on ii_risk_free_batches from anon, authenticated;

create or replace function ii_risk_free_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only (% blocked)', tg_table_name, tg_op using errcode = '42501';
end $$;
drop trigger if exists trg_ii_risk_free_batches_no_change on ii_risk_free_batches;
create trigger trg_ii_risk_free_batches_no_change before update or delete on ii_risk_free_batches
  for each row execute function ii_risk_free_append_only();
drop trigger if exists trg_ii_risk_free_batches_no_truncate on ii_risk_free_batches;
create trigger trg_ii_risk_free_batches_no_truncate before truncate on ii_risk_free_batches
  for each statement execute function ii_risk_free_append_only();

-- ---------------------------------------------------------------------------
-- 4. Observations (one value or gap per series and date; changed only through the correction RPC)
-- ---------------------------------------------------------------------------
create table if not exists ii_risk_free_observations (
  id uuid primary key default gen_random_uuid(),
  series_id text not null references ii_risk_free_series(series_id),
  observation_date date not null,
  kind text not null default 'value' check (kind in ('value', 'gap')),
  value_percent numeric(9, 4),
  gap_reason text check (gap_reason is null or gap_reason in ('no_accepted_bids', 'no_auction_held', 'no_row_in_source')),
  source_document text not null check (length(trim(source_document)) > 0),
  source_url text,
  retrieved_on date not null,
  notes text,
  entry_kind text not null check (entry_kind in ('first_load_csv', 'admin_upload', 'weekly_refresh_job')),
  extraction jsonb,
  batch_id uuid references ii_risk_free_batches(id),
  created_at timestamptz not null default now(),
  constraint ii_risk_free_obs_unique unique (series_id, observation_date),
  constraint ii_risk_free_obs_value_range check (value_percent is null or (value_percent >= 0 and value_percent <= 100)),
  -- A gap row never carries a value; a value row always does.
  constraint ii_risk_free_obs_kind_consistent check (
    (kind = 'value' and value_percent is not null and gap_reason is null)
    or (kind = 'gap' and value_percent is null and gap_reason is not null)
  ),
  -- An observation cannot be dated after the day it was retrieved (a future-dated rate).
  constraint ii_risk_free_obs_not_future check (observation_date <= retrieved_on)
);
create index if not exists idx_ii_risk_free_obs_series_date on ii_risk_free_observations (series_id, observation_date desc);
alter table ii_risk_free_observations enable row level security;
drop policy if exists "read ii_risk_free_observations" on ii_risk_free_observations;
create policy "read ii_risk_free_observations" on ii_risk_free_observations for select using (true);
revoke insert, update, delete, truncate on ii_risk_free_observations from anon, authenticated;

-- Updates are allowed ONLY inside correct_risk_free_observation(), which sets this transaction-local flag;
-- deletes and truncates are never allowed.
create or replace function ii_risk_free_obs_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ii_risk_free_observations rows are never deleted' using errcode = '42501';
  end if;
  if coalesce(current_setting('nav2.risk_free_correction', true), '') <> 'on' then
    raise exception 'ii_risk_free_observations is append-only: use correct_risk_free_observation()' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_ii_risk_free_obs_guard on ii_risk_free_observations;
create trigger trg_ii_risk_free_obs_guard before update or delete on ii_risk_free_observations
  for each row execute function ii_risk_free_obs_guard();
drop trigger if exists trg_ii_risk_free_obs_no_truncate on ii_risk_free_observations;
create trigger trg_ii_risk_free_obs_no_truncate before truncate on ii_risk_free_observations
  for each statement execute function ii_risk_free_append_only();

-- ---------------------------------------------------------------------------
-- 5. Review queue, correction ledger, state log
-- ---------------------------------------------------------------------------
create table if not exists ii_risk_free_review_items (
  id uuid primary key default gen_random_uuid(),
  series_id text not null references ii_risk_free_series(series_id),
  observation_date date,
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
  reasons text[] not null default '{}',
  candidate jsonb,
  evidence jsonb,
  batch_id uuid references ii_risk_free_batches(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  constraint ii_risk_free_review_resolved_has_actor check (status = 'open' or (resolved_at is not null and resolved_by is not null))
);
-- The same unresolved case is queued once (idempotent weekly runs).
create unique index if not exists uidx_ii_risk_free_review_open
  on ii_risk_free_review_items (series_id, coalesce(observation_date, date '0001-01-01')) where status = 'open';
alter table ii_risk_free_review_items enable row level security;
drop policy if exists "capability read ii_risk_free_review_items" on ii_risk_free_review_items;
create policy "capability read ii_risk_free_review_items" on ii_risk_free_review_items for select using (is_risk_free_data_admin());
revoke insert, update, delete, truncate on ii_risk_free_review_items from anon, authenticated;

create table if not exists ii_risk_free_corrections (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references ii_risk_free_observations(id),
  series_id text not null,
  observation_date date not null,
  previous_value_percent numeric(9, 4),
  new_value_percent numeric(9, 4) not null,
  reason text not null check (length(trim(reason)) >= 20),
  actor_user_id uuid not null,
  created_at timestamptz not null default now()
);
alter table ii_risk_free_corrections enable row level security;
drop policy if exists "capability read ii_risk_free_corrections" on ii_risk_free_corrections;
create policy "capability read ii_risk_free_corrections" on ii_risk_free_corrections for select using (is_risk_free_data_admin());
revoke insert, update, delete, truncate on ii_risk_free_corrections from anon, authenticated;
drop trigger if exists trg_ii_risk_free_corrections_no_change on ii_risk_free_corrections;
create trigger trg_ii_risk_free_corrections_no_change before update or delete on ii_risk_free_corrections
  for each row execute function ii_risk_free_append_only();

create table if not exists ii_risk_free_series_state_log (
  id uuid primary key default gen_random_uuid(),
  series_id text not null,
  previous_enabled boolean not null,
  new_enabled boolean not null,
  previous_terms_status text not null,
  new_terms_status text not null,
  reason text not null check (length(trim(reason)) >= 20),
  actor_user_id uuid not null,
  created_at timestamptz not null default now()
);
alter table ii_risk_free_series_state_log enable row level security;
drop policy if exists "capability read ii_risk_free_series_state_log" on ii_risk_free_series_state_log;
create policy "capability read ii_risk_free_series_state_log" on ii_risk_free_series_state_log
  for select using (is_risk_free_data_admin() or is_risk_free_series_switch_admin());
revoke insert, update, delete, truncate on ii_risk_free_series_state_log from anon, authenticated;
drop trigger if exists trg_ii_risk_free_state_log_no_change on ii_risk_free_series_state_log;
create trigger trg_ii_risk_free_state_log_no_change before update or delete on ii_risk_free_series_state_log
  for each row execute function ii_risk_free_append_only();

-- ---------------------------------------------------------------------------
-- 6. commit_risk_free_upload -- the admin CSV write path
--    p_rows: [{ "date": "yyyy-mm-dd", "value_percent": 5.5199 | null, "kind": "value"|"gap",
--               "gap_reason": null|"no_accepted_bids"|"no_auction_held"|"no_row_in_source", "source_document": "...",
--               "source_url": "..."|null, "retrieved_on": "yyyy-mm-dd", "notes": "..."|null }]
--    A row for an existing (series, date) with the SAME value is an identical skip; with a DIFFERENT
--    value the whole upload is refused (a published value is changed only by correct_risk_free_observation()).
-- ---------------------------------------------------------------------------
create or replace function commit_risk_free_upload(
  p_series_id text,
  p_file_sha256 text,
  p_file_name text,
  p_rows jsonb,
  p_attested boolean,
  p_attestation_text text,
  p_entry_kind text default 'admin_upload',
  p_verified_through date default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.ii_risk_free_batches%rowtype;
  v_batch uuid := gen_random_uuid();
  v_count integer;
  v_distinct integer;
  v_bad integer;
  v_conflicts integer;
  v_inserted integer;
  v_identical integer;
  v_from date;
  v_to date;
begin
  if v_uid is null or not public.is_risk_free_data_admin() then
    raise exception 'risk-free upload: not authorised' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ii_risk_free_series where series_id = p_series_id) then
    raise exception 'risk-free upload: unknown series' using errcode = '22023';
  end if;
  if p_entry_kind not in ('first_load_csv', 'admin_upload') then
    raise exception 'risk-free upload: invalid entry kind' using errcode = '22023';
  end if;
  if p_attested is distinct from true or p_attestation_text is null or length(trim(p_attestation_text)) < 20 then
    raise exception 'risk-free upload: the attestation is required' using errcode = '22023';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'risk-free upload: a SHA-256 file hash is required' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 5000 then
    raise exception 'risk-free upload: rows must be a non-empty array of at most 5000 entries' using errcode = '22023';
  end if;
  if p_verified_through is not null and p_verified_through > current_date then
    raise exception 'risk-free upload: the verified-through date cannot be in the future' using errcode = '22023';
  end if;

  select * into v_existing from public.ii_risk_free_batches
   where series_id = p_series_id and file_sha256 = p_file_sha256 and source_kind = 'admin_csv';
  if found then
    -- The same file again. Its rows are already in; only a NEW "verified through" confirmation (the day a policy-change
    -- series was last confirmed complete) is applied, and it is recorded in the append-only state log (who, when, to what).
    if p_verified_through is not null
       and exists (select 1 from public.ii_risk_free_series x where x.series_id = p_series_id and (x.verified_through_date is null or x.verified_through_date < p_verified_through)) then
      -- Only a date that moves the confirmation FORWARD is applied and logged; an earlier or equal date is a no-op.
      update public.ii_risk_free_series
         set verified_through_date = p_verified_through, updated_at = now()
       where series_id = p_series_id;
      insert into public.ii_risk_free_series_state_log (series_id, previous_enabled, new_enabled, previous_terms_status, new_terms_status, reason, actor_user_id)
      select s.series_id, s.enabled, s.enabled, s.terms_review_status, s.terms_review_status,
             'Verified-through date confirmed through ' || to_char(p_verified_through, 'DD-MM-YYYY') || ' (re-submitted file).', v_uid
        from public.ii_risk_free_series s where s.series_id = p_series_id;
    end if;
    return jsonb_build_object('already_committed', true, 'batch_id', v_existing.id, 'inserted', v_existing.rows_inserted, 'identical', v_existing.rows_identical_skipped, 'verified_through_recorded', p_verified_through is not null);
  end if;

  create temporary table if not exists tmp_rf_in (
    d date, kind text, v numeric(9,4), gap_reason text, doc text, url text, retrieved date, notes text
  ) on commit drop;
  truncate tmp_rf_in;
  insert into tmp_rf_in
    select (r->>'date')::date, coalesce(r->>'kind', 'value'),
           case when r->>'value_percent' is null then null else (r->>'value_percent')::numeric(9,4) end,
           nullif(r->>'gap_reason', ''), r->>'source_document', nullif(r->>'source_url', ''),
           (r->>'retrieved_on')::date, nullif(r->>'notes', '')
    from jsonb_array_elements(p_rows) r;

  select count(*), count(distinct d) into v_count, v_distinct from tmp_rf_in;
  if v_count <> v_distinct then
    raise exception 'risk-free upload: duplicate dates inside the file' using errcode = '22023';
  end if;
  select count(*) into v_bad from tmp_rf_in
   where d is null or retrieved is null or d > retrieved
      or doc is null or length(trim(doc)) = 0
      or kind not in ('value', 'gap')
      or (kind = 'value' and (v is null or v < 0 or v > 100 or gap_reason is not null))
      or (kind = 'gap' and (v is not null or gap_reason not in ('no_accepted_bids', 'no_auction_held', 'no_row_in_source')));
  if v_bad > 0 then
    raise exception 'risk-free upload: % row(s) fail validation (date, value range, future date, source document or gap rules)', v_bad using errcode = '22023';
  end if;

  select count(*) into v_conflicts
    from tmp_rf_in t join public.ii_risk_free_observations o on o.series_id = p_series_id and o.observation_date = t.d
   where o.kind is distinct from t.kind or o.value_percent is distinct from t.v;
  if v_conflicts > 0 then
    raise exception 'risk-free upload: % date(s) already hold a different published value; a published value is changed only by an explicit correction', v_conflicts using errcode = '22023';
  end if;

  select count(*) into v_identical
    from tmp_rf_in t join public.ii_risk_free_observations o on o.series_id = p_series_id and o.observation_date = t.d;
  select min(d), max(d) into v_from, v_to from tmp_rf_in;

  insert into public.ii_risk_free_batches (id, series_id, source_kind, file_name, file_sha256, rows_submitted, rows_inserted, rows_identical_skipped, date_from, date_to, uploader_user_id, attested, attestation_text, attested_at)
  values (v_batch, p_series_id, 'admin_csv', left(p_file_name, 255), p_file_sha256, v_count, v_count - v_identical, v_identical, v_from, v_to, v_uid, true, p_attestation_text, now());

  insert into public.ii_risk_free_observations (series_id, observation_date, kind, value_percent, gap_reason, source_document, source_url, retrieved_on, notes, entry_kind, batch_id)
  select p_series_id, t.d, t.kind, t.v, t.gap_reason, t.doc, t.url, t.retrieved, t.notes, p_entry_kind, v_batch
    from tmp_rf_in t
   where not exists (select 1 from public.ii_risk_free_observations o where o.series_id = p_series_id and o.observation_date = t.d);
  get diagnostics v_inserted = row_count;

  if p_verified_through is not null then
    update public.ii_risk_free_series
       set verified_through_date = greatest(coalesce(verified_through_date, p_verified_through), p_verified_through), updated_at = now()
     where series_id = p_series_id;
  end if;
  return jsonb_build_object('already_committed', false, 'batch_id', v_batch, 'inserted', v_inserted, 'identical', v_identical);
end $$;
revoke all on function commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date) from public, anon;
grant execute on function commit_risk_free_upload(text, text, text, jsonb, boolean, text, text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. record_risk_free_refresh_results -- the weekly job's write path (service role only)
--    p_rows: same shape as above plus "extraction" (jsonb). A value row for an existing date with a
--    DIFFERENT value is never written: it becomes a review item. Same value = identical skip.
--    p_review_items: [{ "observation_date": "...", "reasons": ["..."], "candidate": {...}, "evidence": {...} }]
-- ---------------------------------------------------------------------------
create or replace function record_risk_free_refresh_results(
  p_series_id text,
  p_rows jsonb,
  p_review_items jsonb,
  p_verified_through date
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_batch uuid := gen_random_uuid();
  v_inserted integer := 0;
  v_identical integer := 0;
  v_queued integer := 0;
  v_row jsonb;
  v_rev jsonb;
  v_existing public.ii_risk_free_observations%rowtype;
  v_date date;
  v_kind text;
  v_val numeric(9,4);
  v_n integer;
begin
  -- Database layer: only the service role (the cron route) may call this.
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'risk-free refresh: service role only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ii_risk_free_series where series_id = p_series_id) then
    raise exception 'risk-free refresh: unknown series' using errcode = '22023';
  end if;
  insert into public.ii_risk_free_batches (id, series_id, source_kind, rows_submitted, rows_inserted)
  values (v_batch, p_series_id, 'weekly_refresh', coalesce(jsonb_array_length(p_rows), 0), 0);

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_date := (v_row->>'date')::date;
    v_kind := coalesce(v_row->>'kind', 'value');
    v_val := case when v_row->>'value_percent' is null then null else (v_row->>'value_percent')::numeric(9,4) end;
    select * into v_existing from public.ii_risk_free_observations where series_id = p_series_id and observation_date = v_date;
    if found then
      if v_existing.kind is not distinct from v_kind and v_existing.value_percent is not distinct from v_val then
        v_identical := v_identical + 1;
      else
        insert into public.ii_risk_free_review_items (series_id, observation_date, reasons, candidate, evidence, batch_id)
        values (p_series_id, v_date, array['conflicts_with_stored_value'], v_row, jsonb_build_object('stored', to_jsonb(v_existing)), v_batch)
        on conflict do nothing;
        v_queued := v_queued + 1;
      end if;
    else
      insert into public.ii_risk_free_observations (series_id, observation_date, kind, value_percent, gap_reason, source_document, source_url, retrieved_on, notes, entry_kind, extraction, batch_id)
      values (p_series_id, v_date, v_kind, v_val, nullif(v_row->>'gap_reason', ''), v_row->>'source_document', nullif(v_row->>'source_url', ''),
              (v_row->>'retrieved_on')::date, nullif(v_row->>'notes', ''), 'weekly_refresh_job', v_row->'extraction', v_batch);
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  for v_rev in select * from jsonb_array_elements(coalesce(p_review_items, '[]'::jsonb)) loop
    insert into public.ii_risk_free_review_items (series_id, observation_date, reasons, candidate, evidence, batch_id)
    values (p_series_id, nullif(v_rev->>'observation_date', '')::date,
            coalesce(array(select jsonb_array_elements_text(v_rev->'reasons')), '{}'), v_rev->'candidate', v_rev->'evidence', v_batch)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_queued := v_queued + v_n;
  end loop;

  if p_verified_through is not null then
    update public.ii_risk_free_series
       set verified_through_date = greatest(coalesce(verified_through_date, p_verified_through), p_verified_through), updated_at = now()
     where series_id = p_series_id;
  end if;
  return jsonb_build_object('batch_id', v_batch, 'inserted', v_inserted, 'identical', v_identical, 'queued', v_queued);
end $$;
revoke all on function record_risk_free_refresh_results(text, jsonb, jsonb, date) from public, anon, authenticated;
grant execute on function record_risk_free_refresh_results(text, jsonb, jsonb, date) to service_role;

-- ---------------------------------------------------------------------------
-- 8. resolve_risk_free_review_item
-- ---------------------------------------------------------------------------
create or replace function resolve_risk_free_review_item(p_item_id uuid, p_decision text, p_note text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_item public.ii_risk_free_review_items%rowtype;
  v_c jsonb;
  v_inserted boolean := false;
begin
  if v_uid is null or not public.is_risk_free_data_admin() then
    raise exception 'risk-free review: not authorised' using errcode = '42501';
  end if;
  if p_decision not in ('accept', 'reject') then
    raise exception 'risk-free review: decision must be accept or reject' using errcode = '22023';
  end if;
  if p_note is null or length(trim(p_note)) < 20 then
    raise exception 'risk-free review: a note of at least 20 characters is required' using errcode = '22023';
  end if;
  select * into v_item from public.ii_risk_free_review_items where id = p_item_id for update;
  if not found or v_item.status <> 'open' then
    raise exception 'risk-free review: item not found or already resolved' using errcode = '22023';
  end if;
  if p_decision = 'accept' then
    v_c := v_item.candidate;
    if v_c is null or v_c->>'date' is null then
      raise exception 'risk-free review: this item has no publishable candidate; reject it and upload the value' using errcode = '22023';
    end if;
    if exists (select 1 from public.ii_risk_free_observations where series_id = v_item.series_id and observation_date = (v_c->>'date')::date) then
      raise exception 'risk-free review: a value already exists for that date; use a correction' using errcode = '22023';
    end if;
    insert into public.ii_risk_free_observations (series_id, observation_date, kind, value_percent, gap_reason, source_document, source_url, retrieved_on, notes, entry_kind, extraction)
    values (v_item.series_id, (v_c->>'date')::date, coalesce(v_c->>'kind', 'value'),
            case when v_c->>'value_percent' is null then null else (v_c->>'value_percent')::numeric(9,4) end,
            nullif(v_c->>'gap_reason', ''), v_c->>'source_document', nullif(v_c->>'source_url', ''), (v_c->>'retrieved_on')::date,
            left('Accepted from the review queue: ' || p_note, 500), 'admin_upload', v_c->'extraction');
    v_inserted := true;
  end if;
  update public.ii_risk_free_review_items
     set status = case when p_decision = 'accept' then 'accepted' else 'rejected' end,
         resolved_at = now(), resolved_by = v_uid, resolution_note = left(p_note, 500)
   where id = p_item_id;
  return jsonb_build_object('item_id', p_item_id, 'decision', p_decision, 'observation_inserted', v_inserted);
end $$;
revoke all on function resolve_risk_free_review_item(uuid, text, text) from public, anon;
grant execute on function resolve_risk_free_review_item(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. correct_risk_free_observation -- the ONLY way a published value changes
-- ---------------------------------------------------------------------------
create or replace function correct_risk_free_observation(p_series_id text, p_date date, p_new_value numeric, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_obs public.ii_risk_free_observations%rowtype;
begin
  if v_uid is null or not public.is_risk_free_data_admin() then
    raise exception 'risk-free correction: not authorised' using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 20 then
    raise exception 'risk-free correction: a reason of at least 20 characters is required' using errcode = '22023';
  end if;
  if p_new_value is null or p_new_value < 0 or p_new_value > 100 then
    raise exception 'risk-free correction: the value must be a percent between 0 and 100' using errcode = '22023';
  end if;
  select * into v_obs from public.ii_risk_free_observations where series_id = p_series_id and observation_date = p_date and kind = 'value' for update;
  if not found then
    raise exception 'risk-free correction: no published value for that series and date' using errcode = '22023';
  end if;
  insert into public.ii_risk_free_corrections (observation_id, series_id, observation_date, previous_value_percent, new_value_percent, reason, actor_user_id)
  values (v_obs.id, p_series_id, p_date, v_obs.value_percent, round(p_new_value, 4), p_reason, v_uid);
  perform set_config('nav2.risk_free_correction', 'on', true);
  update public.ii_risk_free_observations set value_percent = round(p_new_value, 4) where id = v_obs.id;
  perform set_config('nav2.risk_free_correction', 'off', true);
  return jsonb_build_object('observation_id', v_obs.id, 'previous', v_obs.value_percent, 'new', round(p_new_value, 4));
end $$;
revoke all on function correct_risk_free_observation(text, date, numeric, text) from public, anon;
grant execute on function correct_risk_free_observation(text, date, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. set_risk_free_series_state -- enabled flag and terms status, audited
-- ---------------------------------------------------------------------------
create or replace function set_risk_free_series_state(p_series_id text, p_enabled boolean, p_terms_status text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_s public.ii_risk_free_series%rowtype;
begin
  if v_uid is null or not public.is_risk_free_series_switch_admin() then
    raise exception 'risk-free series state: not authorised' using errcode = '42501';
  end if;
  if p_enabled is null or p_terms_status not in ('po_accepted_2026-10-03', 'confirmed_in_writing', 'pending_confirmation', 'declined') then
    raise exception 'risk-free series state: invalid enabled flag or terms status' using errcode = '22023';
  end if;
  if p_reason is null or length(trim(p_reason)) < 20 then
    raise exception 'risk-free series state: a reason of at least 20 characters is required' using errcode = '22023';
  end if;
  select * into v_s from public.ii_risk_free_series where series_id = p_series_id for update;
  if not found then
    raise exception 'risk-free series state: unknown series' using errcode = '22023';
  end if;
  insert into public.ii_risk_free_series_state_log (series_id, previous_enabled, new_enabled, previous_terms_status, new_terms_status, reason, actor_user_id)
  values (p_series_id, v_s.enabled, p_enabled, v_s.terms_review_status, p_terms_status, p_reason, v_uid);
  update public.ii_risk_free_series set enabled = p_enabled, terms_review_status = p_terms_status, updated_at = now() where series_id = p_series_id;
  return jsonb_build_object('series_id', p_series_id, 'enabled', p_enabled, 'terms_review_status', p_terms_status);
end $$;
revoke all on function set_risk_free_series_state(text, boolean, text, text) from public, anon;
grant execute on function set_risk_free_series_state(text, boolean, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 11. Job-control rows: ALL SHIPPED DISABLED (the kill switches are the existing mechanism)
-- ---------------------------------------------------------------------------
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'nav2_risk_free_weekly_refresh', false, 'Ships DISABLED (PO decision 2026-10-03: automated weekly RBI read, default OFF with dry run). Enabling is a deliberate human step after a DEV dry run.'
where not exists (select 1 from ii_reference_job_control where job_key = 'nav2_risk_free_weekly_refresh');
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'nav2_fund_analytics', false, 'Ships DISABLED: the NAV2 Fund analytics report feature switch. Enabling is a deliberate human step after Stage 3 DEV certification.'
where not exists (select 1 from ii_reference_job_control where job_key = 'nav2_fund_analytics');
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'nav2_trigger_planner', false, 'Ships DISABLED: when off the existing user-scoped NAV fetch runs exactly as before; when on the NAV2 required-window planner sizes the fetch.'
where not exists (select 1 from ii_reference_job_control where job_key = 'nav2_trigger_planner');
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'nav2_correction_worker', false, 'Ships DISABLED: processes ii_reference_corrections events into NAV2 cache invalidation. Enabling is a deliberate human step.'
where not exists (select 1 from ii_reference_job_control where job_key = 'nav2_correction_worker');

-- ROLLBACK: drop the functions, tables (in reverse dependency order), the two admin_users columns and the four
-- job-control rows. Nothing else depends on them. No NAV data is touched by this migration.
