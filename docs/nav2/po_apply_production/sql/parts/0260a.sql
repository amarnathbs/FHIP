-- 0260 -- Stage 2 of the fund analytics work: the governed RISK-FREE dataset (RBI 91-day T-bill cut-off yield,
-- RBI policy repo rate): series registry, observations, append-only batch ledger, review queue, correction ledger,
-- state-change log, the two named admin capabilities, their predicates, the upload / refresh / review / state /
-- correction functions, and the job-control kill-switch rows (all shipped DISABLED).
--
-- Forward-only, additive, idempotent: every statement can be run again. No existing CHECK constraint is dropped or
-- recreated. HAND-OVER ARTEFACT: not applied anywhere. Apply order: this file (or its parts a to e in order),
-- then 0261, then 0262. See docs/nav2/po_apply_0260_0262/README.md.
--
-- HOW TO RUN IT. This whole file is the migration (supabase CLI). The same text is also shipped as five parts under
-- docs/nav2/po_apply_0260_0262/parts/ (0260a to 0260e), each an exact slice of this file, each safe to run on its own and
-- again, to be run in order a, b, c, d, e in the Supabase SQL editor. A test proves that the parts joined equal this file.
--   part a: admin_users columns, the two predicate functions, the series table (with its two seed rows), the batches table
--   part b: the append-only function, the batch triggers, the observations table with its guard
--   part c: the review queue, correction ledger and state log tables
--   part d: commit_risk_free_upload and record_risk_free_refresh_results
--   part e: resolve_risk_free_review_item, correct_risk_free_observation, set_risk_free_series_state, the job-control rows
--
-- Migration number freshness: scanned 04-10-2026 across every worktree and remote branch, the highest number taken
-- by anyone else is 0252, so 0260 is free.
--
-- ADMIN ARCHITECTURE STANDARD (docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md), applied:
--   section 2  two separately named capabilities, each its own column and predicate:
--                can_upload_risk_free_data     upload, review-queue decisions, corrections
--                can_switch_risk_free_series   turn a series on or off, set its terms status
--              Neither is implied by admin_users membership, by each other, or by any benchmark or reference-data capability.
--   section 4  database layer: every write is a SECURITY DEFINER function that checks auth.uid() and the predicate INSIDE.
--              No table grants INSERT, UPDATE or DELETE to authenticated or anon.
--   section 6  fixed search_path, schema-qualified references, explicit return type, EXECUTE revoked from PUBLIC and anon.
--   section 8  an unauthorised caller gets an exception (42501), never an empty result.
--   section 9  the series and observations are GLOBAL reference data with no tenancy column.
--
-- TERMS (PO decision 2026-10-03): RBI publishes no explicit reuse licence (its pages say All Rights Reserved).
-- The PO accepted that risk. It is recorded per series as terms_review_status po_accepted_2026-10-03, never as a granted licence.

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
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.admin_users
    where admin_users.user_id = auth.uid() and admin_users.can_upload_risk_free_data = true
  );
$fn$;
revoke all on function is_risk_free_data_admin() from public, anon;
grant execute on function is_risk_free_data_admin() to authenticated, service_role;

create or replace function is_risk_free_series_switch_admin() returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.admin_users
    where admin_users.user_id = auth.uid() and admin_users.can_switch_risk_free_series = true
  );
$fn$;
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
  'Risk-free series registry. One row per governed series, enabled and terms_review_status change ONLY through set_risk_free_series_state() (audited). Global reference data: readable by authenticated, never writable by a session.';
alter table ii_risk_free_series enable row level security;
drop policy if exists read_ii_risk_free_series on ii_risk_free_series;
create policy read_ii_risk_free_series on ii_risk_free_series for select using (true);
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
drop policy if exists capability_read_ii_risk_free_batches on ii_risk_free_batches;
create policy capability_read_ii_risk_free_batches on ii_risk_free_batches
  for select using (is_risk_free_data_admin() or is_risk_free_series_switch_admin());
revoke insert, update, delete, truncate on ii_risk_free_batches from anon, authenticated;

