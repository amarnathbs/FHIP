-- 0239 — BENCH-1 Phase 2: benchmark data governance, the ONE upload pipeline,
-- per-right entitlements, mapping governance and recurring-ingestion state.
--
-- THIS MIGRATION EXTENDS, IT DOES NOT REPLACE:
--   * ii_benchmarks / ii_benchmark_series / ii_instrument_benchmarks (0031,
--     0043, 0155) keep their shape and gain nullable catalogue / evidence /
--     revision columns.
--   * ii_reference_import_batches is the canonical publication ledger (PC6,
--     0155): every published upload writes ONE batch row there
--     (batch_kind 'benchmark_level'), so the existing PC6 Admin "import
--     batches" panel shows uploads without a second ledger.
--   * ii_reference_corrections (0155) is the append-only correction audit:
--     every corrected or restored level writes its before/after there.
--   * ii_reference_job_control (0155) carries the global and write kill
--     switches (both ship DISABLED).
--   * The two capabilities from 0155 (can_view_reference_data_quality) and
--     0232 (can_upload_market_index_data) are REUSED as the view and the
--     upload/stage capabilities. Four NEW, separately-named capabilities are
--     added, all default FALSE and never granted to anyone by this migration:
--       can_publish_benchmark_data, can_correct_benchmark_data,
--       can_manage_benchmark_catalogue, can_approve_benchmark_entitlements.
--
-- WHAT IS NEW
--   1. Per-right entitlement records (ii_benchmark_entitlements) and the one
--      central predicate benchmark_right_allowed(). NO new licence_status
--      value is invented: ii_benchmarks.licence_status keeps the 0155 set
--      ('public_open','licence_required','licensed_held','unknown') as a
--      coarse summary only; the AUTHORITATIVE gate is the per-right record.
--      A public_open string alone proves nothing; a licensed_held string
--      alone proves nothing; absence of an approved, in-term, in-scope record
--      for the exact benchmark / variant / currency means NO right (fail
--      closed).
--   2. The staged upload pipeline: ii_benchmark_import_jobs / _rows / _errors
--      and the RPCs create -> stage chunks -> finalize -> publish (atomic,
--      idempotent, revalidated, bound to file checksum + staging digest +
--      previewed counts) -> rollback.
--   3. RLS on ii_benchmark_series now requires the 'calculation' right (or
--      the viewer capability) and hides superseded rows, so an unentitled
--      series is invisible to every ordinary reader at the DATABASE layer.
--   4. Catalogue + mapping governance: evidence columns, a proposals queue,
--      deterministic auto-publish for adequately evidenced matches only, a
--      database-enforced no-overlap rule for PRIMARY mappings.
--   5. Selective-history demand table, per-benchmark ingestion state with
--      leases and the four independent watermarks, and a run history.
--   6. A generic, entitlement-gated feed write path. The 0232 single-step
--      upload RPC is revoked from `authenticated` (it bypassed entitlement
--      gating); the 0232 feed RPC now also requires the 'automation' and
--      'storage' rights.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It does not widen or drop-and-recreate ANY shared CHECK constraint
--     (the ii_audit_events list, ii_benchmarks.return_type, the batch_kind /
--     status lists are untouched), so it cannot revoke a sibling branch's
--     values. Variants are carried in a NEW column, return_variant.
--   * It does not load any index value, grant any capability, approve any
--     entitlement, enable any job or create any pg_cron schedule.
--
-- ROLLBACK (all statements idempotent / guarded): see
-- scripts/bench1_phase2_po_apply_0239.sql, which also carries the verify block.

-- Preconditions: this migration builds on 0155 (PC6 reference data) and 0232
-- (market-index upload capability). Fail loudly rather than half-apply.
do $$ begin
  if to_regprocedure('is_market_index_data_admin()') is null then
    raise exception '0239 requires migration 0232 (is_market_index_data_admin) to be applied first';
  end if;
  if to_regclass('public.ii_reference_import_batches') is null or to_regclass('public.ii_reference_job_control') is null or to_regclass('public.ii_reference_corrections') is null then
    raise exception '0239 requires migration 0155 (PC6 reference-data ledgers) to be applied first';
  end if;
end $$;

-- ===========================================================================
-- 1. Capabilities (Admin Architecture Standard sections 2 and 4, DB layer)
-- ===========================================================================
alter table admin_users add column if not exists can_publish_benchmark_data boolean not null default false;
alter table admin_users add column if not exists can_correct_benchmark_data boolean not null default false;
alter table admin_users add column if not exists can_manage_benchmark_catalogue boolean not null default false;
alter table admin_users add column if not exists can_approve_benchmark_entitlements boolean not null default false;
comment on column admin_users.can_publish_benchmark_data is 'BENCH-1: authorises review/approve/publish of a validated benchmark upload (new history only). Separately named; not implied by any other can_* column.';
comment on column admin_users.can_correct_benchmark_data is 'BENCH-1: authorises publishing a CORRECTION to already-published benchmark levels and rolling an import back. Separately named.';
comment on column admin_users.can_manage_benchmark_catalogue is 'BENCH-1: authorises catalogue entries, scheme-to-benchmark mapping review and drafting entitlement records. Separately named.';
comment on column admin_users.can_approve_benchmark_entitlements is 'BENCH-1: authorises APPROVING or revoking a benchmark entitlement record (the gate that decides what FHIP may do with a benchmark series). Separately named.';

create or replace function is_benchmark_publisher() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users where admin_users.user_id = auth.uid() and admin_users.can_publish_benchmark_data = true);
$$;
create or replace function is_benchmark_corrector() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users where admin_users.user_id = auth.uid() and admin_users.can_correct_benchmark_data = true);
$$;
create or replace function is_benchmark_catalogue_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users where admin_users.user_id = auth.uid() and admin_users.can_manage_benchmark_catalogue = true);
$$;
create or replace function is_benchmark_entitlement_approver() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users where admin_users.user_id = auth.uid() and admin_users.can_approve_benchmark_entitlements = true);
$$;
-- Read-only visibility into benchmark operational data: ANY of the five
-- capabilities (PC6 view, upload, publish, correct, catalogue, approve).
create or replace function is_benchmark_data_viewer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_users
    where admin_users.user_id = auth.uid()
      and (admin_users.can_view_reference_data_quality = true
        or admin_users.can_upload_market_index_data = true
        or admin_users.can_publish_benchmark_data = true
        or admin_users.can_correct_benchmark_data = true
        or admin_users.can_manage_benchmark_catalogue = true
        or admin_users.can_approve_benchmark_entitlements = true)
  );
$$;
revoke all on function is_benchmark_publisher(), is_benchmark_corrector(), is_benchmark_catalogue_admin(), is_benchmark_entitlement_approver(), is_benchmark_data_viewer() from public, anon;
grant execute on function is_benchmark_publisher(), is_benchmark_corrector(), is_benchmark_catalogue_admin(), is_benchmark_entitlement_approver(), is_benchmark_data_viewer() to authenticated, service_role;

-- ===========================================================================
-- 2. Append-only governance event log (this feature's own audit trail; no
--    shared audit-event constraint is widened)
-- ===========================================================================
create table if not exists ii_benchmark_governance_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (length(event_type) between 3 and 80),
  subject_table text not null,
  subject_id uuid,
  actor_user_id uuid,
  actor_kind text not null check (actor_kind in ('admin', 'service', 'system')),
  before_state jsonb,
  after_state jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ii_benchmark_governance_events_subject on ii_benchmark_governance_events (subject_table, subject_id, created_at desc);
create index if not exists idx_ii_benchmark_governance_events_recent on ii_benchmark_governance_events (created_at desc);
alter table ii_benchmark_governance_events enable row level security;
drop policy if exists "viewer read ii_benchmark_governance_events" on ii_benchmark_governance_events;
create policy "viewer read ii_benchmark_governance_events" on ii_benchmark_governance_events for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_benchmark_governance_events from anon, authenticated;
create or replace function ii_benchmark_governance_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'ii_benchmark_governance_events is append-only (% blocked)', tg_op using errcode = '42501';
end $$;
drop trigger if exists trg_ii_benchmark_governance_events_no_change on ii_benchmark_governance_events;
create trigger trg_ii_benchmark_governance_events_no_change before update or delete on ii_benchmark_governance_events for each row execute function ii_benchmark_governance_events_append_only();
drop trigger if exists trg_ii_benchmark_governance_events_no_truncate on ii_benchmark_governance_events;
create trigger trg_ii_benchmark_governance_events_no_truncate before truncate on ii_benchmark_governance_events for each statement execute function ii_benchmark_governance_events_append_only();

create or replace function ii_bm_log_event(p_type text, p_table text, p_subject uuid, p_before jsonb, p_after jsonb, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.ii_benchmark_governance_events (event_type, subject_table, subject_id, actor_user_id, actor_kind, before_state, after_state, reason)
  values (p_type, p_table, p_subject, auth.uid(), case when auth.uid() is not null then 'admin' when coalesce(auth.role(), '') = 'service_role' then 'service' else 'system' end, p_before, p_after, p_reason);
end $$;
revoke all on function ii_bm_log_event(text, text, uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- ===========================================================================
-- 3. Catalogue columns on ii_benchmarks (additive, all nullable / defaulted)
--    The exact return VARIANT lives in its own column. ii_benchmarks.return_type
--    (0043) is untouched: it stays the engine's TRI/PRI/DEBT_INDEX class.
-- ===========================================================================
alter table ii_benchmarks add column if not exists return_variant text
  check (return_variant is null or return_variant in ('price', 'total_return', 'net_total_return'));
alter table ii_benchmarks add column if not exists official_name text;
alter table ii_benchmarks add column if not exists owner_name text;
alter table ii_benchmarks add column if not exists official_identifier text;
alter table ii_benchmarks add column if not exists asset_class text
  check (asset_class is null or asset_class in ('equity', 'debt', 'hybrid', 'gold', 'silver', 'commodity', 'international_equity', 'money_market', 'other'));
alter table ii_benchmarks add column if not exists base_date date;
alter table ii_benchmarks add column if not exists base_value numeric(18, 6);
alter table ii_benchmarks add column if not exists launch_date date;
alter table ii_benchmarks add column if not exists history_start_date date;
alter table ii_benchmarks add column if not exists history_class text not null default 'unknown'
  check (history_class in ('live', 'backtested', 'mixed', 'unknown'));
alter table ii_benchmarks add column if not exists backtested_through date;
alter table ii_benchmarks add column if not exists calendar_code text;
alter table ii_benchmarks add column if not exists methodology_url text;
alter table ii_benchmarks add column if not exists source_url text;
alter table ii_benchmarks add column if not exists evidence_ref text;
alter table ii_benchmarks add column if not exists evidence_retrieved_at date;
alter table ii_benchmarks add column if not exists catalogue_status text not null default 'draft'
  check (catalogue_status in ('draft', 'verified', 'deprecated'));
alter table ii_benchmarks add column if not exists verified_by uuid;
alter table ii_benchmarks add column if not exists verified_at timestamptz;

update ii_benchmarks set return_variant = case return_type when 'PRI' then 'price' when 'TRI' then 'total_return' end
 where return_variant is null and return_type in ('PRI', 'TRI');

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ii_benchmarks_variant_matches_type') then
    alter table ii_benchmarks add constraint ii_benchmarks_variant_matches_type check (
      return_variant is null
      or return_type is null
      or return_type not in ('TRI', 'PRI')
      or (return_type = 'TRI' and return_variant = 'total_return')
      or (return_type = 'PRI' and return_variant = 'price')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ii_benchmarks_verified_complete') then
    alter table ii_benchmarks add constraint ii_benchmarks_verified_complete check (
      catalogue_status <> 'verified'
      or (official_name is not null and owner_name is not null and return_variant is not null and currency_code is not null
          and asset_class is not null and evidence_ref is not null and evidence_retrieved_at is not null
          and verified_by is not null and verified_at is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ii_benchmarks_history_dates_order') then
    alter table ii_benchmarks add constraint ii_benchmarks_history_dates_order check (
      (launch_date is null or base_date is null or launch_date >= base_date)
      and (history_start_date is null or launch_date is null or history_start_date <= launch_date or history_class <> 'live')
    );
  end if;
end $$;
comment on column ii_benchmarks.return_variant is 'BENCH-1: exact variant (price / total_return / net_total_return). A price series must never be silently used for a total-return benchmark.';
comment on column ii_benchmarks.history_class is 'BENCH-1: live / backtested / mixed / unknown. Published backtested history is distinguished from live history; unavailable pre-inception levels are never reconstructed.';
comment on column ii_benchmarks.catalogue_status is 'BENCH-1: draft until a named catalogue admin verifies the record with evidence (CHECK ii_benchmarks_verified_complete).';

-- Series: revision lineage + provenance (unique(benchmark_id, series_date) from
-- 0031 stays: one canonical row per date; its history lives in revision_no and
-- ii_reference_corrections).
alter table ii_benchmark_series add column if not exists revision_no integer not null default 1 check (revision_no >= 1);
alter table ii_benchmark_series add column if not exists import_job_id uuid;
alter table ii_benchmark_series add column if not exists history_class text not null default 'unknown'
  check (history_class in ('live', 'backtested', 'unknown'));
create index if not exists idx_ii_benchmark_series_import_job on ii_benchmark_series (import_job_id) where import_job_id is not null;

-- ===========================================================================
-- 4. Per-right entitlements
-- ===========================================================================
create table if not exists ii_benchmark_entitlements (
  id uuid primary key default gen_random_uuid(),
  benchmark_id uuid not null references ii_benchmarks(id),
  source_id uuid references ii_sources(id),
  entitlement_kind text not null check (entitlement_kind in ('public_use_permission', 'commercial_licence')),
  status text not null default 'draft' check (status in ('draft', 'approved', 'revoked')),
  return_variant text not null check (return_variant in ('price', 'total_return', 'net_total_return')),
  currency_code char(3) not null references currencies(currency_code),
  allow_manual_ingest boolean not null default false,
  allow_automation boolean not null default false,
  allow_storage boolean not null default false,
  allow_calculation boolean not null default false,
  allow_customer_display boolean not null default false,
  allow_report_export boolean not null default false,
  data_from date,
  data_to date,
  valid_from date not null,
  valid_to date,
  post_expiry_storage text not null default 'unknown' check (post_expiry_storage in ('retain', 'delete', 'unknown')),
  post_expiry_calculation boolean not null default false,
  post_expiry_display boolean not null default false,
  evidence_reference text not null check (length(trim(evidence_reference)) >= 5),
  evidence_url text,
  evidence_document_date date,
  evidence_retrieved_at date,
  attribution_text text,
  notes text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  self_approved boolean not null default false,
  revoked_by uuid,
  revoked_at timestamptz,
  revoked_reason text,
  constraint ii_benchmark_entitlements_term check (valid_to is null or valid_to >= valid_from),
  constraint ii_benchmark_entitlements_data_range check (data_to is null or data_from is null or data_to >= data_from),
  constraint ii_benchmark_entitlements_approved_attributed check (status <> 'approved' or (approved_by is not null and approved_at is not null)),
  constraint ii_benchmark_entitlements_revoked_attributed check (status <> 'revoked' or (revoked_by is not null and revoked_at is not null and length(trim(coalesce(revoked_reason, ''))) >= 10)),
  -- Verified public-use permission needs a document, not a checkbox.
  constraint ii_benchmark_entitlements_public_needs_evidence check (
    entitlement_kind <> 'public_use_permission'
    or (evidence_url is not null and evidence_retrieved_at is not null and evidence_document_date is not null)
  ),
  -- Calculation / display / export use stored data, so they imply the storage right.
  constraint ii_benchmark_entitlements_rights_coherent check (
    (not allow_calculation or allow_storage)
    and (not allow_customer_display or allow_calculation)
    and (not allow_report_export or allow_customer_display)
    and (not allow_automation or allow_storage)
    and (not allow_manual_ingest or allow_storage)
  )
);
create index if not exists idx_ii_benchmark_entitlements_benchmark on ii_benchmark_entitlements (benchmark_id, status);
alter table ii_benchmark_entitlements enable row level security;
drop policy if exists "viewer read ii_benchmark_entitlements" on ii_benchmark_entitlements;
create policy "viewer read ii_benchmark_entitlements" on ii_benchmark_entitlements for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_benchmark_entitlements from anon, authenticated;
comment on table ii_benchmark_entitlements is
  'BENCH-1: one row per (benchmark, grant). Each RIGHT is separate: manual ingest, automation, storage, calculation, customer display, report export. Written only through propose/approve/revoke RPCs; evaluated only through benchmark_right_allowed().';

-- The single rights evaluator over ONE entitlement row.
create or replace function benchmark_entitlement_grants(e ii_benchmark_entitlements, p_right text, p_on date)
returns boolean language plpgsql immutable set search_path = public as $$
declare
  in_term boolean := p_on >= e.valid_from and (e.valid_to is null or p_on <= e.valid_to);
  -- Post-expiry retention applies ONLY after the term has ended (never before valid_from).
  retained boolean := e.post_expiry_storage = 'retain' and e.valid_to is not null and p_on > e.valid_to;
begin
  if e.status <> 'approved' then return false; end if;
  case p_right
    when 'ingest_manual' then return e.allow_manual_ingest and in_term;
    when 'automation' then return e.allow_automation and in_term;
    when 'storage' then return e.allow_storage and (in_term or retained);
    when 'calculation' then return e.allow_calculation and (in_term or (retained and e.post_expiry_calculation));
    when 'customer_display' then return e.allow_customer_display and (in_term or (retained and e.post_expiry_display));
    when 'report_export' then return e.allow_report_export and (in_term or (retained and e.post_expiry_display));
    else raise exception 'benchmark_entitlement_grants: unknown right %', p_right using errcode = '22023';
  end case;
end $$;
revoke all on function benchmark_entitlement_grants(ii_benchmark_entitlements, text, date) from public, anon;
grant execute on function benchmark_entitlement_grants(ii_benchmark_entitlements, text, date) to authenticated, service_role;

-- The ONE central predicate: may <right> be exercised on <benchmark> today for
-- data dates [p_data_from, p_data_to]? Requires an approved record for the EXACT
-- benchmark whose variant and currency equal the catalogue row's. Anything else
-- (no record, draft, revoked, expired without retention, out of data scope,
-- variant/currency mismatch, benchmark without a declared variant) is FALSE.
create or replace function benchmark_right_allowed(p_benchmark_id uuid, p_right text, p_on date default current_date, p_data_from date default null, p_data_to date default null)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  ok boolean;
begin
  if p_right not in ('ingest_manual', 'automation', 'storage', 'calculation', 'customer_display', 'report_export') then
    raise exception 'benchmark_right_allowed: unknown right %', p_right using errcode = '22023';
  end if;
  select exists (
    select 1
      from public.ii_benchmark_entitlements e
      join public.ii_benchmarks b on b.id = e.benchmark_id
     where e.benchmark_id = p_benchmark_id
       and e.status = 'approved'
       and b.return_variant is not null and e.return_variant = b.return_variant
       and b.currency_code is not null and e.currency_code = b.currency_code
       and (p_data_from is null or e.data_from is null or p_data_from >= e.data_from)
       and (p_data_to is null or e.data_to is null or p_data_to <= e.data_to)
       and public.benchmark_entitlement_grants(e, p_right, coalesce(p_on, current_date))
  ) into ok;
  return coalesce(ok, false);
end $$;
revoke all on function benchmark_right_allowed(uuid, text, date, date, date) from public, anon;
grant execute on function benchmark_right_allowed(uuid, text, date, date, date) to authenticated, service_role;

-- Same check pinned to ONE entitlement id (used at publication to prove the
-- entitlement chosen at staging is STILL valid, i.e. revocation/expiry between
-- staging and publication is caught).
create or replace function benchmark_entitlement_id_allows(p_entitlement uuid, p_right text, p_on date, p_data_from date, p_data_to date)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  e public.ii_benchmark_entitlements%rowtype;
  b public.ii_benchmarks%rowtype;
begin
  select * into e from public.ii_benchmark_entitlements where id = p_entitlement;
  if not found then return false; end if;
  select * into b from public.ii_benchmarks where id = e.benchmark_id;
  if b.return_variant is null or e.return_variant <> b.return_variant or b.currency_code is null or e.currency_code <> b.currency_code then return false; end if;
  if p_data_from is not null and e.data_from is not null and p_data_from < e.data_from then return false; end if;
  if p_data_to is not null and e.data_to is not null and p_data_to > e.data_to then return false; end if;
  return public.benchmark_entitlement_grants(e, p_right, coalesce(p_on, current_date));
end $$;
revoke all on function benchmark_entitlement_id_allows(uuid, text, date, date, date) from public, anon;
grant execute on function benchmark_entitlement_id_allows(uuid, text, date, date, date) to authenticated, service_role;

-- Consumer-facing, aggregate-only boolean view of the rights (Standard section 6:
-- no contract references or evidence are returned, only booleans and date scope).
create or replace function benchmark_entitled_actions(p_benchmark_ids uuid[], p_on date default current_date)
returns table (benchmark_id uuid, can_calculate boolean, can_display boolean, can_export boolean, data_from date, data_to date)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'benchmark_entitled_actions: authentication required' using errcode = '42501';
  end if;
  if p_benchmark_ids is null or cardinality(p_benchmark_ids) > 500 then
    raise exception 'benchmark_entitled_actions: between 1 and 500 benchmark ids are required' using errcode = '22023';
  end if;
  return query
    select b.id,
           coalesce(bool_or(public.benchmark_entitlement_grants(e, 'calculation', coalesce(p_on, current_date))), false),
           coalesce(bool_or(public.benchmark_entitlement_grants(e, 'customer_display', coalesce(p_on, current_date))), false),
           coalesce(bool_or(public.benchmark_entitlement_grants(e, 'report_export', coalesce(p_on, current_date))), false),
           case when bool_or(e.data_from is null) then null else min(e.data_from) end,
           case when bool_or(e.data_to is null) then null else max(e.data_to) end
      from public.ii_benchmarks b
      left join public.ii_benchmark_entitlements e
        on e.benchmark_id = b.id and e.status = 'approved'
       and b.return_variant is not null and e.return_variant = b.return_variant
       and b.currency_code is not null and e.currency_code = b.currency_code
     where b.id = any (p_benchmark_ids)
     group by b.id;
end $$;
revoke all on function benchmark_entitled_actions(uuid[], date) from public, anon;
grant execute on function benchmark_entitled_actions(uuid[], date) to authenticated, service_role;

-- Benchmarks whose series may be READ for calculation by an ordinary session.
-- Evaluated ONCE per statement through the (select ...) wrapper in the policy.
create or replace function benchmark_calc_readable_ids() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct e.benchmark_id), '{}'::uuid[])
    from public.ii_benchmark_entitlements e
    join public.ii_benchmarks b on b.id = e.benchmark_id
   where e.status = 'approved'
     and b.return_variant is not null and e.return_variant = b.return_variant
     and b.currency_code is not null and e.currency_code = b.currency_code
     and public.benchmark_entitlement_grants(e, 'calculation', current_date);
$$;
revoke all on function benchmark_calc_readable_ids() from public, anon;
grant execute on function benchmark_calc_readable_ids() to authenticated, service_role;

-- DATABASE-LAYER READER GATE. The 0031 policy was `using (true)`: every signed-in
-- user could read every series. Now: the viewer capability, or an approved
-- in-term 'calculation' entitlement for that exact benchmark, and never a
-- superseded (retracted) row. (The data-date SCOPE of an entitlement is applied
-- by the application read layer via benchmark_entitled_actions(); ingestion
-- applies it in the publish RPC.)
drop policy if exists "read ii_benchmark_series" on ii_benchmark_series;
create policy "read ii_benchmark_series" on ii_benchmark_series for select using (
  (select is_benchmark_data_viewer())
  or (quality_status <> 'superseded' and benchmark_id = any ((select benchmark_calc_readable_ids())::uuid[]))
);

-- Entitlement lifecycle RPCs ------------------------------------------------
create or replace function propose_benchmark_entitlement(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  b public.ii_benchmarks%rowtype;
begin
  if v_uid is null or not public.is_benchmark_catalogue_admin() then
    raise exception 'benchmark entitlement: catalogue admin capability required' using errcode = '42501';
  end if;
  select * into b from public.ii_benchmarks where id = (p ->> 'benchmark_id')::uuid;
  if not found then raise exception 'benchmark entitlement: unknown benchmark' using errcode = '22023'; end if;
  if b.return_variant is null or b.currency_code is null then
    raise exception 'benchmark entitlement: the catalogue row has no declared variant/currency; complete the catalogue entry first' using errcode = '22023';
  end if;
  if (p ->> 'return_variant') is distinct from b.return_variant or (p ->> 'currency_code') is distinct from b.currency_code::text then
    raise exception 'benchmark entitlement: variant/currency must equal the catalogue row (% / %)', b.return_variant, b.currency_code using errcode = '22023';
  end if;
  insert into public.ii_benchmark_entitlements (
    benchmark_id, source_id, entitlement_kind, return_variant, currency_code,
    allow_manual_ingest, allow_automation, allow_storage, allow_calculation, allow_customer_display, allow_report_export,
    data_from, data_to, valid_from, valid_to, post_expiry_storage, post_expiry_calculation, post_expiry_display,
    evidence_reference, evidence_url, evidence_document_date, evidence_retrieved_at, attribution_text, notes, created_by)
  values (
    b.id, nullif(p ->> 'source_id', '')::uuid, p ->> 'entitlement_kind', b.return_variant, b.currency_code,
    coalesce((p ->> 'allow_manual_ingest')::boolean, false), coalesce((p ->> 'allow_automation')::boolean, false),
    coalesce((p ->> 'allow_storage')::boolean, false), coalesce((p ->> 'allow_calculation')::boolean, false),
    coalesce((p ->> 'allow_customer_display')::boolean, false), coalesce((p ->> 'allow_report_export')::boolean, false),
    nullif(p ->> 'data_from', '')::date, nullif(p ->> 'data_to', '')::date, (p ->> 'valid_from')::date, nullif(p ->> 'valid_to', '')::date,
    coalesce(p ->> 'post_expiry_storage', 'unknown'), coalesce((p ->> 'post_expiry_calculation')::boolean, false), coalesce((p ->> 'post_expiry_display')::boolean, false),
    p ->> 'evidence_reference', nullif(p ->> 'evidence_url', ''), nullif(p ->> 'evidence_document_date', '')::date, nullif(p ->> 'evidence_retrieved_at', '')::date,
    nullif(p ->> 'attribution_text', ''), nullif(p ->> 'notes', ''), v_uid)
  returning id into v_id;
  perform public.ii_bm_log_event('entitlement_proposed', 'ii_benchmark_entitlements', v_id, null, p, null);
  return v_id;
end $$;
revoke all on function propose_benchmark_entitlement(jsonb) from public, anon;
grant execute on function propose_benchmark_entitlement(jsonb) to authenticated;

create or replace function approve_benchmark_entitlement(p_id uuid, p_note text, p_self_approval_ack boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  e public.ii_benchmark_entitlements%rowtype;
begin
  if v_uid is null or not public.is_benchmark_entitlement_approver() then
    raise exception 'benchmark entitlement: approver capability required' using errcode = '42501';
  end if;
  select * into e from public.ii_benchmark_entitlements where id = p_id for update;
  if not found then raise exception 'benchmark entitlement: not found' using errcode = 'P0002'; end if;
  if e.status <> 'draft' then raise exception 'benchmark entitlement: only a draft can be approved (is %)', e.status using errcode = '55000'; end if;
  if e.created_by = v_uid and p_self_approval_ack is not true then
    raise exception 'benchmark entitlement: separation of duties - the proposer may approve only with an explicit self-approval acknowledgement' using errcode = '42501';
  end if;
  update public.ii_benchmark_entitlements
     set status = 'approved', approved_by = v_uid, approved_at = now(), self_approved = (e.created_by = v_uid)
   where id = p_id;
  perform public.ii_bm_log_event('entitlement_approved', 'ii_benchmark_entitlements', p_id, to_jsonb(e), jsonb_build_object('self_approved', e.created_by = v_uid), p_note);
end $$;
revoke all on function approve_benchmark_entitlement(uuid, text, boolean) from public, anon;
grant execute on function approve_benchmark_entitlement(uuid, text, boolean) to authenticated;

create or replace function revoke_benchmark_entitlement(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  e public.ii_benchmark_entitlements%rowtype;
begin
  if v_uid is null or not public.is_benchmark_entitlement_approver() then
    raise exception 'benchmark entitlement: approver capability required' using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'benchmark entitlement: a revocation reason of at least 10 characters is required' using errcode = '22023';
  end if;
  select * into e from public.ii_benchmark_entitlements where id = p_id for update;
  if not found then raise exception 'benchmark entitlement: not found' using errcode = 'P0002'; end if;
  if e.status = 'revoked' then return; end if;
  update public.ii_benchmark_entitlements set status = 'revoked', revoked_by = v_uid, revoked_at = now(), revoked_reason = trim(p_reason) where id = p_id;
  perform public.ii_bm_log_event('entitlement_revoked', 'ii_benchmark_entitlements', p_id, to_jsonb(e), null, p_reason);
end $$;
revoke all on function revoke_benchmark_entitlement(uuid, text) from public, anon;
grant execute on function revoke_benchmark_entitlement(uuid, text) to authenticated;

-- ===========================================================================
-- 5. The upload pipeline: jobs, staged rows, errors
-- ===========================================================================
create table if not exists ii_benchmark_import_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'staging' check (status in ('staging', 'validated', 'published', 'rolled_back', 'failed', 'stale', 'cancelled', 'expired')),
  mode text not null check (mode in ('new_history', 'correction')),
  shape text not null check (shape in ('single', 'multi', 'provider_export')),
  layout_id text,
  file_format text not null check (file_format in ('csv', 'xlsx')),
  file_name text not null check (length(file_name) between 1 and 255),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes integer not null check (file_bytes > 0),
  sheet_name text,
  source_owner text not null check (length(trim(source_owner)) >= 2),
  source_reference text not null check (length(trim(source_reference)) >= 5),
  source_id uuid references ii_sources(id),
  benchmark_keys text[] not null check (cardinality(benchmark_keys) between 1 and 50),
  benchmark_ids uuid[] not null,
  return_variant text not null check (return_variant in ('price', 'total_return', 'net_total_return')),
  currency_code char(3) not null references currencies(currency_code),
  history_class text not null check (history_class in ('live', 'backtested', 'mixed', 'unknown')),
  date_format text,
  number_locale text,
  data_as_of date,
  reason text,
  validator_version text not null,
  entitlement_refs jsonb not null default '{}'::jsonb,
  rows_total integer not null default 0,
  rows_invalid integer not null default 0,
  rows_new integer not null default 0,
  rows_identical integer not null default 0,
  rows_correction integer not null default 0,
  rows_revive integer not null default 0,
  client_hard_errors integer not null default 0,
  hard_error_total integer not null default 0,
  warning_count integer not null default 0,
  required_acks text[] not null default '{}',
  eligible boolean,
  eligibility_detail jsonb,
  preview jsonb,
  staging_digest text,
  duplicate_of uuid,
  staged_by uuid not null,
  staged_at timestamptz not null default now(),
  validated_at timestamptz,
  published_by uuid,
  published_at timestamptz,
  self_published boolean not null default false,
  approved_counts jsonb,
  acknowledged text[],
  result jsonb,
  ledger_batch_id uuid references ii_reference_import_batches(id),
  rolled_back_by uuid,
  rolled_back_at timestamptz,
  rollback_reason text,
  error_code text,
  error_detail text,
  expires_at timestamptz not null default (now() + interval '14 days'),
  constraint ii_benchmark_import_jobs_correction_reasoned check (mode <> 'correction' or length(trim(coalesce(reason, ''))) >= 20),
  constraint ii_benchmark_import_jobs_published_attributed check (status not in ('published', 'rolled_back') or (published_by is not null and published_at is not null and staging_digest is not null))
);
create index if not exists idx_ii_benchmark_import_jobs_recent on ii_benchmark_import_jobs (staged_at desc);
create index if not exists idx_ii_benchmark_import_jobs_sha on ii_benchmark_import_jobs (file_sha256, mode) where status in ('published');
alter table ii_benchmark_import_jobs enable row level security;
drop policy if exists "viewer read ii_benchmark_import_jobs" on ii_benchmark_import_jobs;
create policy "viewer read ii_benchmark_import_jobs" on ii_benchmark_import_jobs for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_benchmark_import_jobs from anon, authenticated;

create table if not exists ii_benchmark_import_rows (
  job_id uuid not null references ii_benchmark_import_jobs(id) on delete cascade,
  benchmark_id uuid not null references ii_benchmarks(id),
  series_date date not null,
  row_no integer not null check (row_no >= 0),
  value numeric(18, 6) not null check (value > 0),
  classification text not null check (classification in ('new', 'identical', 'correction', 'revive', 'conflict', 'missing_target')),
  existing_value numeric(18, 6),
  existing_revision integer,
  primary key (job_id, benchmark_id, series_date)
);
alter table ii_benchmark_import_rows enable row level security;
drop policy if exists "viewer read ii_benchmark_import_rows" on ii_benchmark_import_rows;
create policy "viewer read ii_benchmark_import_rows" on ii_benchmark_import_rows for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_benchmark_import_rows from anon, authenticated;

create table if not exists ii_benchmark_import_errors (
  id bigserial primary key,
  job_id uuid not null references ii_benchmark_import_jobs(id) on delete cascade,
  row_no integer,
  severity text not null check (severity in ('error', 'warning')),
  code text not null check (length(code) between 2 and 80),
  message text not null,
  raw_excerpt text
);
create index if not exists idx_ii_benchmark_import_errors_job on ii_benchmark_import_errors (job_id, severity, row_no);
alter table ii_benchmark_import_errors enable row level security;
drop policy if exists "viewer read ii_benchmark_import_errors" on ii_benchmark_import_errors;
create policy "viewer read ii_benchmark_import_errors" on ii_benchmark_import_errors for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_benchmark_import_errors from anon, authenticated;

-- 5a. create ----------------------------------------------------------------
create or replace function create_benchmark_import_job(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid := gen_random_uuid();
  v_keys text[];
  v_ids uuid[];
  v_found integer;
  v_bad integer;
  v_prior uuid;
  v_mode text := p ->> 'mode';
begin
  if v_uid is null or not public.is_market_index_data_admin() then
    raise exception 'benchmark import: upload capability required' using errcode = '42501';
  end if;
  if v_mode not in ('new_history', 'correction') then raise exception 'benchmark import: unknown mode' using errcode = '22023'; end if;
  if v_mode = 'correction' and length(trim(coalesce(p ->> 'reason', ''))) < 20 then
    raise exception 'benchmark import: a correction needs a reason of at least 20 characters' using errcode = '22023';
  end if;
  select array_agg(distinct x) into v_keys from jsonb_array_elements_text(p -> 'benchmark_keys') as t(x);
  if v_keys is null or cardinality(v_keys) = 0 or cardinality(v_keys) > 50 then
    raise exception 'benchmark import: between 1 and 50 benchmark keys are required' using errcode = '22023';
  end if;
  select count(*), array_agg(b.id order by b.benchmark_key),
         count(*) filter (where b.lifecycle_status <> 'active' or b.return_variant is distinct from (p ->> 'return_variant') or b.currency_code::text is distinct from (p ->> 'currency_code'))
    into v_found, v_ids, v_bad
    from public.ii_benchmarks b where b.benchmark_key = any (v_keys);
  if v_found <> cardinality(v_keys) then
    raise exception 'benchmark import: % of the named benchmarks do not exist in the catalogue (an upload never creates a benchmark)', cardinality(v_keys) - v_found using errcode = '22023';
  end if;
  if v_bad > 0 then
    raise exception 'benchmark import: % benchmark(s) are inactive or their declared variant/currency differs from the upload form', v_bad using errcode = '22023';
  end if;
  select id into v_prior from public.ii_benchmark_import_jobs
   where file_sha256 = p ->> 'file_sha256' and mode = v_mode and status = 'published' and benchmark_keys @> v_keys and benchmark_keys <@ v_keys
   order by published_at desc limit 1;
  insert into public.ii_benchmark_import_jobs (
    id, mode, shape, layout_id, file_format, file_name, file_sha256, file_bytes, sheet_name, source_owner, source_reference, source_id,
    benchmark_keys, benchmark_ids, return_variant, currency_code, history_class, date_format, number_locale, data_as_of, reason,
    validator_version, entitlement_refs, duplicate_of, staged_by)
  values (
    v_id, v_mode, p ->> 'shape', p ->> 'layout_id', p ->> 'file_format', left(p ->> 'file_name', 255), p ->> 'file_sha256', (p ->> 'file_bytes')::integer,
    nullif(p ->> 'sheet_name', ''), p ->> 'source_owner', p ->> 'source_reference', nullif(p ->> 'source_id', '')::uuid,
    v_keys, v_ids, p ->> 'return_variant', p ->> 'currency_code', p ->> 'history_class', p ->> 'date_format', p ->> 'number_locale',
    nullif(p ->> 'data_as_of', '')::date, nullif(trim(coalesce(p ->> 'reason', '')), ''),
    p ->> 'validator_version', coalesce(p -> 'entitlement_refs', '{}'::jsonb), v_prior, v_uid);
  perform public.ii_bm_log_event('import_job_created', 'ii_benchmark_import_jobs', v_id, null, jsonb_build_object('mode', v_mode, 'benchmarks', v_keys, 'sha256', p ->> 'file_sha256'), null);
  return v_id;
end $$;
revoke all on function create_benchmark_import_job(jsonb) from public, anon;
grant execute on function create_benchmark_import_job(jsonb) to authenticated;

-- 5b. stage a chunk ---------------------------------------------------------
create or replace function stage_benchmark_import_rows(p_job uuid, p_rows jsonb, p_errors jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  j public.ii_benchmark_import_jobs%rowtype;
  v_n integer;
  v_bad integer;
  v_total integer;
  v_err integer;
begin
  select * into j from public.ii_benchmark_import_jobs where id = p_job for update;
  if not found then raise exception 'benchmark import: job not found' using errcode = 'P0002'; end if;
  if v_uid is null or j.staged_by <> v_uid or not public.is_market_index_data_admin() then
    raise exception 'benchmark import: only the staging admin (still holding the upload capability) may stage rows' using errcode = '42501';
  end if;
  if j.status <> 'staging' then raise exception 'benchmark import: job is % (rows can only be staged while staging)', j.status using errcode = '55000'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'benchmark import: rows must be an array of at most 5000 entries per chunk' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_rows);

  -- Structural validation (the database never trusts the caller's checks).
  select count(*) into v_bad
    from jsonb_to_recordset(p_rows) as r(row_no integer, benchmark_key text, series_date date, value numeric)
   where r.series_date is null or r.value is null or r.value <= 0 or r.series_date > current_date or r.series_date < date '1900-01-01'
      or r.row_no is null or r.benchmark_key is null or not (r.benchmark_key = any (j.benchmark_keys));
  if v_bad > 0 then
    raise exception 'benchmark import: % row(s) are structurally invalid (missing/invalid/future date, non-positive value, or a benchmark outside this job)', v_bad using errcode = '22023';
  end if;
  select count(*) into v_total from public.ii_benchmark_import_rows where job_id = p_job;
  if v_total + v_n > 20000 then raise exception 'benchmark import: more than 20000 staged rows' using errcode = '22023'; end if;

  insert into public.ii_benchmark_import_rows (job_id, benchmark_id, series_date, row_no, value, classification, existing_value, existing_revision)
  select p_job, b.id, r.series_date, r.row_no, round(r.value, 6),
         case
           when s.id is null then case when j.mode = 'correction' then 'missing_target' else 'new' end
           when s.quality_status = 'superseded' then case when j.mode = 'correction' then 'missing_target' else 'revive' end
           when abs(s.value - round(r.value, 6)) <= 0.000001 then 'identical'
           when j.mode = 'correction' then 'correction'
           else 'conflict'
         end,
         s.value, s.revision_no
    from jsonb_to_recordset(p_rows) as r(row_no integer, benchmark_key text, series_date date, value numeric)
    join public.ii_benchmarks b on b.benchmark_key = r.benchmark_key
    left join public.ii_benchmark_series s on s.benchmark_id = b.id and s.series_date = r.series_date;

  if p_errors is not null and jsonb_typeof(p_errors) = 'array' and jsonb_array_length(p_errors) > 0 then
    select count(*) into v_err from public.ii_benchmark_import_errors where job_id = p_job;
    insert into public.ii_benchmark_import_errors (job_id, row_no, severity, code, message, raw_excerpt)
    select p_job, e.row_no, e.severity, left(e.code, 80), left(e.message, 500), left(e.raw_excerpt, 200)
      from jsonb_to_recordset(p_errors) as e(row_no integer, severity text, code text, message text, raw_excerpt text)
     where e.severity in ('error', 'warning') and e.code is not null and e.message is not null
     limit greatest(0, 2000 - v_err);
  end if;
  return jsonb_build_object('staged', v_n, 'total_staged', v_total + v_n);
end $$;
revoke all on function stage_benchmark_import_rows(uuid, jsonb, jsonb) from public, anon;
grant execute on function stage_benchmark_import_rows(uuid, jsonb, jsonb) to authenticated;

-- 5c. digest helper ---------------------------------------------------------
create or replace function ii_bm_staging_digest(p_job uuid) returns text
language sql stable security definer set search_path = public as $$
  select encode(sha256(convert_to(
    coalesce((select j.mode || '|' || j.file_sha256 || '|' || j.return_variant || '|' || j.currency_code || '|' || j.validator_version from public.ii_benchmark_import_jobs j where j.id = p_job), '')
    || E'\n' ||
    coalesce((select string_agg(b.benchmark_key || ',' || r.series_date::text || ',' || r.value::text || ',' || r.classification, E'\n' order by b.benchmark_key, r.series_date)
                from public.ii_benchmark_import_rows r join public.ii_benchmarks b on b.id = r.benchmark_id where r.job_id = p_job), ''),
    'UTF8')), 'hex');
$$;
revoke all on function ii_bm_staging_digest(uuid) from public, anon, authenticated;

-- 5d. finalize (validate) ---------------------------------------------------
create or replace function finalize_benchmark_import_job(p_job uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  j public.ii_benchmark_import_jobs%rowtype;
  v_new integer; v_ident integer; v_corr integer; v_rev integer; v_conf integer; v_miss integer; v_total integer;
  v_client_hard integer := greatest(0, coalesce((p ->> 'hard_error_count')::integer, 0));
  v_hard integer;
  v_digest text;
  v_detail jsonb := '{}'::jsonb;
  v_eligible boolean := true;
  rec record;
  v_ok boolean;
  v_ent uuid;
begin
  select * into j from public.ii_benchmark_import_jobs where id = p_job for update;
  if not found then raise exception 'benchmark import: job not found' using errcode = 'P0002'; end if;
  if v_uid is null or j.staged_by <> v_uid or not public.is_market_index_data_admin() then
    raise exception 'benchmark import: only the staging admin may finalize' using errcode = '42501';
  end if;
  if j.status <> 'staging' then raise exception 'benchmark import: job is % (cannot finalize)', j.status using errcode = '55000'; end if;

  select count(*), count(*) filter (where classification = 'new'), count(*) filter (where classification = 'identical'),
         count(*) filter (where classification = 'correction'), count(*) filter (where classification = 'revive'),
         count(*) filter (where classification = 'conflict'), count(*) filter (where classification = 'missing_target')
    into v_total, v_new, v_ident, v_corr, v_rev, v_conf, v_miss
    from public.ii_benchmark_import_rows where job_id = p_job;
  v_hard := v_client_hard + v_conf + v_miss;

  -- Eligibility (advisory at staging, authoritative at publication): per
  -- benchmark, the exact entitlement must grant ingest_manual AND storage for
  -- the date range being published.
  for rec in
    select r.benchmark_id, b.benchmark_key, min(r.series_date) as mn, max(r.series_date) as mx
      from public.ii_benchmark_import_rows r join public.ii_benchmarks b on b.id = r.benchmark_id
     where r.job_id = p_job group by r.benchmark_id, b.benchmark_key
  loop
    v_ok := public.benchmark_right_allowed(rec.benchmark_id, 'ingest_manual', current_date, rec.mn, rec.mx)
        and public.benchmark_right_allowed(rec.benchmark_id, 'storage', current_date, rec.mn, rec.mx);
    v_ent := nullif(j.entitlement_refs ->> rec.benchmark_key, '')::uuid;
    if v_ok and v_ent is not null then
      v_ok := public.benchmark_entitlement_id_allows(v_ent, 'ingest_manual', current_date, rec.mn, rec.mx)
          and public.benchmark_entitlement_id_allows(v_ent, 'storage', current_date, rec.mn, rec.mx);
    end if;
    if v_ent is null then v_ok := false; end if;
    v_detail := v_detail || jsonb_build_object(rec.benchmark_key, jsonb_build_object('eligible', v_ok, 'entitlement_id', v_ent, 'from', rec.mn, 'to', rec.mx));
    v_eligible := v_eligible and v_ok;
  end loop;
  if v_total = 0 then v_eligible := false; end if;

  v_digest := public.ii_bm_staging_digest(p_job);
  update public.ii_benchmark_import_jobs set
    status = 'validated', validated_at = now(),
    rows_total = greatest(coalesce((p ->> 'rows_total')::integer, 0), v_total),
    rows_invalid = greatest(0, coalesce((p ->> 'rows_invalid')::integer, 0)),
    rows_new = v_new, rows_identical = v_ident, rows_correction = v_corr, rows_revive = v_rev,
    client_hard_errors = v_client_hard, hard_error_total = v_hard,
    warning_count = greatest(0, coalesce((p ->> 'warning_count')::integer, 0)),
    required_acks = coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'required_acks', '[]'::jsonb)) t(x)), '{}'),
    eligible = v_eligible, eligibility_detail = v_detail,
    preview = p -> 'preview', staging_digest = v_digest
  where id = p_job;
  perform public.ii_bm_log_event('import_job_validated', 'ii_benchmark_import_jobs', p_job, null, jsonb_build_object('digest', v_digest, 'new', v_new, 'identical', v_ident, 'correction', v_corr, 'hard_errors', v_hard, 'eligible', v_eligible), null);
  return jsonb_build_object('staging_digest', v_digest, 'rows_new', v_new, 'rows_identical', v_ident, 'rows_correction', v_corr, 'rows_revive', v_rev,
                            'hard_error_total', v_hard, 'eligible', v_eligible, 'eligibility', v_detail);
end $$;
revoke all on function finalize_benchmark_import_job(uuid, jsonb) from public, anon;
grant execute on function finalize_benchmark_import_job(uuid, jsonb) to authenticated;

-- 5e. publish (approve + publish, atomic, revalidated) -------------------------
create or replace function publish_benchmark_import(p_job uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  j public.ii_benchmark_import_jobs%rowtype;
  v_acks text[];
  v_mismatch integer;
  v_exp jsonb := coalesce(p -> 'expected_counts', '{}'::jsonb);
  v_batch uuid := gen_random_uuid();
  v_ins integer := 0; v_rev integer := 0; v_cor integer := 0; v_ident integer := 0;
  v_from date; v_to date;
  v_prior uuid;
  rec record;
  v_source_key text;
  v_series_id uuid;
begin
  if v_uid is null then raise exception 'benchmark import: authentication required' using errcode = '42501'; end if;
  select * into j from public.ii_benchmark_import_jobs where id = p_job for update;
  if not found then raise exception 'benchmark import: job not found' using errcode = 'P0002'; end if;
  if j.mode = 'correction' then
    if not public.is_benchmark_corrector() then raise exception 'benchmark import: correction capability required' using errcode = '42501'; end if;
  else
    if not public.is_benchmark_publisher() then raise exception 'benchmark import: publish capability required' using errcode = '42501'; end if;
  end if;
  if j.status = 'published' then
    return coalesce(j.result, '{}'::jsonb) || jsonb_build_object('already_published', true);
  end if;
  if j.status <> 'validated' then raise exception 'benchmark import: job is % (must be validated)', j.status using errcode = '55000'; end if;
  if j.expires_at < now() then raise exception 'benchmark import: the staged job has expired; stage it again' using errcode = '55000'; end if;
  if (p ->> 'expected_sha256') is distinct from j.file_sha256 then raise exception 'benchmark import: file checksum differs from the previewed file' using errcode = '40001'; end if;
  if (p ->> 'expected_digest') is distinct from j.staging_digest then raise exception 'benchmark import: stale preview (staging digest differs)' using errcode = '40001'; end if;
  if public.ii_bm_staging_digest(p_job) is distinct from j.staging_digest then raise exception 'benchmark import: staged rows changed after validation' using errcode = '40001'; end if;
  if j.hard_error_total > 0 then raise exception 'benchmark import: % hard validation error(s) remain; nothing is published' , j.hard_error_total using errcode = '22023'; end if;
  v_acks := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'acknowledged', '[]'::jsonb)) t(x)), '{}');
  if not (j.required_acks <@ v_acks) then raise exception 'benchmark import: required acknowledgements missing: %', (select string_agg(x, ',') from unnest(j.required_acks) x where not (x = any (v_acks))) using errcode = '22023'; end if;
  if j.staged_by = v_uid and coalesce((p ->> 'self_publish_ack')::boolean, false) is not true then
    raise exception 'benchmark import: separation of duties - the staging admin may publish only with an explicit self-publish acknowledgement' using errcode = '42501';
  end if;
  if j.mode = 'correction' and length(trim(coalesce(j.reason, ''))) < 20 then raise exception 'benchmark import: a correction needs a recorded reason' using errcode = '22023'; end if;
  if (v_exp ->> 'new')::integer is distinct from j.rows_new + j.rows_revive
     or (v_exp ->> 'identical')::integer is distinct from j.rows_identical
     or (v_exp ->> 'correction')::integer is distinct from j.rows_correction then
    raise exception 'benchmark import: the approved counts differ from the previewed counts' using errcode = '40001';
  end if;
  select id into v_prior from public.ii_benchmark_import_jobs
   where id <> p_job and file_sha256 = j.file_sha256 and mode = j.mode and status = 'published' and benchmark_keys @> j.benchmark_keys and benchmark_keys <@ j.benchmark_keys limit 1;
  if v_prior is not null then
    raise exception 'benchmark import: this exact file was already published by job % (publishing it again would duplicate the import)', v_prior using errcode = '23505';
  end if;

  -- Serialise concurrent publishes per benchmark, then revalidate EVERYTHING.
  for rec in select distinct benchmark_id from public.ii_benchmark_import_rows where job_id = p_job order by benchmark_id loop
    perform pg_advisory_xact_lock(hashtextextended(rec.benchmark_id::text, 7));
  end loop;

  for rec in
    select r.benchmark_id, b.benchmark_key, min(r.series_date) as mn, max(r.series_date) as mx
      from public.ii_benchmark_import_rows r join public.ii_benchmarks b on b.id = r.benchmark_id
     where r.job_id = p_job group by r.benchmark_id, b.benchmark_key
  loop
    if not (public.benchmark_right_allowed(rec.benchmark_id, 'ingest_manual', current_date, rec.mn, rec.mx)
            and public.benchmark_right_allowed(rec.benchmark_id, 'storage', current_date, rec.mn, rec.mx)) then
      raise exception 'benchmark import: no approved, in-term entitlement permits ingest+storage for % (% to %)', rec.benchmark_key, rec.mn, rec.mx using errcode = '42501';
    end if;
    if nullif(j.entitlement_refs ->> rec.benchmark_key, '') is null
       or not (public.benchmark_entitlement_id_allows((j.entitlement_refs ->> rec.benchmark_key)::uuid, 'ingest_manual', current_date, rec.mn, rec.mx)
               and public.benchmark_entitlement_id_allows((j.entitlement_refs ->> rec.benchmark_key)::uuid, 'storage', current_date, rec.mn, rec.mx)) then
      raise exception 'benchmark import: the entitlement chosen at staging for % is no longer valid (revoked, expired or out of scope)', rec.benchmark_key using errcode = '42501';
    end if;
  end loop;

  -- Revalidate classification against the CURRENT series (stale-preview and
  -- concurrent-import guard): every staged row must classify exactly as staged.
  select count(*) into v_mismatch
    from public.ii_benchmark_import_rows r
    left join public.ii_benchmark_series s on s.benchmark_id = r.benchmark_id and s.series_date = r.series_date
   where r.job_id = p_job
     and (r.classification is distinct from (
            case
              when s.id is null then case when j.mode = 'correction' then 'missing_target' else 'new' end
              when s.quality_status = 'superseded' then case when j.mode = 'correction' then 'missing_target' else 'revive' end
              when abs(s.value - r.value) <= 0.000001 then 'identical'
              when j.mode = 'correction' then 'correction'
              else 'conflict'
            end)
          or (r.classification = 'correction' and (s.value is distinct from r.existing_value or s.revision_no is distinct from r.existing_revision)));
  if v_mismatch > 0 then
    raise exception 'benchmark import: % row(s) changed in the published series since the preview; stage the file again', v_mismatch using errcode = '40001';
  end if;

  select min(series_date), max(series_date) into v_from, v_to from public.ii_benchmark_import_rows where job_id = p_job;
  select coalesce(s2.source_key, 'bench1_admin_upload') into v_source_key from (select 1) d left join public.ii_sources s2 on s2.id = j.source_id;

  insert into public.ii_reference_import_batches
    (id, source_key, source_config_id, batch_kind, window_from, window_to, as_of_date, source_sha256, source_retrieved_at, parser_version, status, started_at, finished_at,
     rows_read, rows_accepted, rows_rejected, rows_inserted, rows_unchanged, rows_superseded, notes)
  values (v_batch, left(v_source_key, 100), 'bench1_admin_upload', 'benchmark_level', v_from, v_to, coalesce(j.data_as_of, v_to), j.file_sha256, now(), j.validator_version,
          'succeeded', j.staged_at, now(), j.rows_total, j.rows_new + j.rows_identical + j.rows_correction + j.rows_revive, j.rows_invalid,
          j.rows_new + j.rows_revive, j.rows_identical, j.rows_correction,
          jsonb_build_object('import_job_id', p_job, 'mode', j.mode, 'benchmarks', j.benchmark_keys, 'source_owner', j.source_owner, 'source_reference', j.source_reference,
                             'staged_by', j.staged_by, 'published_by', v_uid, 'history_class', j.history_class));

  -- New rows.
  insert into public.ii_benchmark_series (benchmark_id, series_date, value, currency_code, source_id, data_version, quality_status, import_batch_id, import_job_id, history_class, source_as_of, revision_no)
  select r.benchmark_id, r.series_date, r.value, j.currency_code, j.source_id, 'bench1-upload-v1', 'ok', v_batch, p_job,
         case when j.history_class in ('live', 'backtested') then j.history_class else 'unknown' end, j.data_as_of::timestamptz, 1
    from public.ii_benchmark_import_rows r where r.job_id = p_job and r.classification = 'new';
  get diagnostics v_ins = row_count;

  -- Revived (previously retracted) rows: new revision, recorded.
  for rec in select r.*, s.id as sid, s.value as old_value, s.revision_no as old_rev, s.data_version as old_dv from public.ii_benchmark_import_rows r
               join public.ii_benchmark_series s on s.benchmark_id = r.benchmark_id and s.series_date = r.series_date
              where r.job_id = p_job and r.classification = 'revive' loop
    insert into public.ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_admin_id, actor_kind, reason, batch_id)
    values ('ii_benchmark_series', rec.sid, 'quality_status_change',
            jsonb_build_object('quality_status', 'superseded', 'value', rec.old_value, 'revision_no', rec.old_rev),
            jsonb_build_object('quality_status', 'ok', 'value', rec.value, 'revision_no', rec.old_rev + 1, 'import_job_id', p_job),
            v_uid, 'admin', 'Retracted row re-published by import job ' || p_job::text || ' (' || left(j.source_reference, 120) || ')', v_batch);
    update public.ii_benchmark_series set value = rec.value, quality_status = 'ok', revision_no = rec.old_rev + 1, import_job_id = p_job,
           import_batch_id = v_batch, data_version = 'bench1-upload-v1', currency_code = j.currency_code where id = rec.sid;
    v_rev := v_rev + 1;
  end loop;

  -- Corrections: before/after evidence, new revision, never a silent overwrite.
  for rec in select r.*, s.id as sid, s.value as old_value, s.revision_no as old_rev, s.data_version as old_dv, s.import_job_id as old_job from public.ii_benchmark_import_rows r
               join public.ii_benchmark_series s on s.benchmark_id = r.benchmark_id and s.series_date = r.series_date
              where r.job_id = p_job and r.classification = 'correction' loop
    insert into public.ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_admin_id, actor_kind, reason, batch_id)
    values ('ii_benchmark_series', rec.sid, 'source_correction',
            jsonb_build_object('value', rec.old_value, 'revision_no', rec.old_rev, 'data_version', rec.old_dv, 'import_job_id', rec.old_job),
            jsonb_build_object('value', rec.value, 'revision_no', rec.old_rev + 1, 'import_job_id', p_job),
            v_uid, 'admin', j.reason, v_batch);
    update public.ii_benchmark_series set value = rec.value, revision_no = rec.old_rev + 1, import_job_id = p_job, import_batch_id = v_batch,
           data_version = 'bench1-upload-v1', currency_code = j.currency_code where id = rec.sid;
    v_cor := v_cor + 1;
  end loop;

  select count(*) into v_ident from public.ii_benchmark_import_rows where job_id = p_job and classification = 'identical';

  -- Watermark: latest valid data date per benchmark (kept honest by the DB).
  insert into public.ii_benchmark_ingestion_state (benchmark_id, latest_valid_data_date, last_manual_import_at)
  select r.benchmark_id, (select max(s.series_date) from public.ii_benchmark_series s where s.benchmark_id = r.benchmark_id and s.quality_status = 'ok'), now()
    from (select distinct benchmark_id from public.ii_benchmark_import_rows where job_id = p_job) r
  on conflict (benchmark_id) do update
    set latest_valid_data_date = excluded.latest_valid_data_date, last_manual_import_at = excluded.last_manual_import_at, updated_at = now();

  update public.ii_benchmark_import_jobs set
    status = 'published', published_by = v_uid, published_at = now(), self_published = (j.staged_by = v_uid),
    approved_counts = jsonb_build_object('new', j.rows_new, 'revive', j.rows_revive, 'identical', j.rows_identical, 'correction', j.rows_correction),
    acknowledged = v_acks, ledger_batch_id = v_batch,
    result = jsonb_build_object('already_published', false, 'job_id', p_job, 'batch_id', v_batch, 'inserted', v_ins, 'revived', v_rev, 'corrected', v_cor,
                                'identical_skipped', v_ident, 'date_from', v_from, 'date_to', v_to)
  where id = p_job;
  perform public.ii_bm_log_event('import_job_published', 'ii_benchmark_import_jobs', p_job, null,
    jsonb_build_object('batch_id', v_batch, 'inserted', v_ins, 'revived', v_rev, 'corrected', v_cor, 'identical', v_ident, 'sha256', j.file_sha256, 'digest', j.staging_digest), j.reason);
  return jsonb_build_object('already_published', false, 'job_id', p_job, 'batch_id', v_batch, 'inserted', v_ins, 'revived', v_rev, 'corrected', v_cor,
                            'identical_skipped', v_ident, 'date_from', v_from, 'date_to', v_to);
end $$;
revoke all on function publish_benchmark_import(uuid, jsonb) from public, anon;
grant execute on function publish_benchmark_import(uuid, jsonb) to authenticated;

-- 5f. rollback --------------------------------------------------------------
create or replace function rollback_benchmark_import(p_job uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  j public.ii_benchmark_import_jobs%rowtype;
  v_touched integer;
  v_owned integer;
  v_restored integer := 0;
  v_retracted integer := 0;
  rec record;
  v_prev numeric;
  v_kind text;
begin
  if v_uid is null or not public.is_benchmark_corrector() then
    raise exception 'benchmark import: correction capability required for rollback' using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 20 then raise exception 'benchmark import: a rollback reason of at least 20 characters is required' using errcode = '22023'; end if;
  select * into j from public.ii_benchmark_import_jobs where id = p_job for update;
  if not found then raise exception 'benchmark import: job not found' using errcode = 'P0002'; end if;
  if j.status = 'rolled_back' then return jsonb_build_object('already_rolled_back', true, 'job_id', p_job); end if;
  if j.status <> 'published' then raise exception 'benchmark import: only a published job can be rolled back (is %)', j.status using errcode = '55000'; end if;
  for rec in select distinct unnest(j.benchmark_ids) as bid order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended(rec.bid::text, 7));
  end loop;
  v_touched := coalesce((j.result ->> 'inserted')::integer, 0) + coalesce((j.result ->> 'revived')::integer, 0) + coalesce((j.result ->> 'corrected')::integer, 0);
  select count(*) into v_owned from public.ii_benchmark_series where import_job_id = p_job;
  if v_owned <> v_touched then
    raise exception 'benchmark import: % of % row(s) written by this job have since been revised by a later import; roll those back first', v_touched - v_owned, v_touched using errcode = '55000';
  end if;
  for rec in select s.* from public.ii_benchmark_series s where s.import_job_id = p_job loop
    select c.previous_value ->> 'value', c.correction_kind into v_prev, v_kind
      from public.ii_reference_corrections c
     where c.target_table = 'ii_benchmark_series' and c.target_row_id = rec.id and c.batch_id = j.ledger_batch_id
     order by c.created_at desc limit 1;
    if v_kind = 'source_correction' then
      insert into public.ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_admin_id, actor_kind, reason, batch_id)
      values ('ii_benchmark_series', rec.id, 'source_correction', jsonb_build_object('value', rec.value, 'revision_no', rec.revision_no),
              jsonb_build_object('value', v_prev, 'revision_no', rec.revision_no + 1, 'rollback_of_job', p_job), v_uid, 'admin', 'Rollback of import job ' || p_job::text || ': ' || trim(p_reason), j.ledger_batch_id);
      update public.ii_benchmark_series set value = v_prev::numeric, revision_no = rec.revision_no + 1, import_job_id = null, data_version = 'bench1-rollback-v1' where id = rec.id;
      v_restored := v_restored + 1;
    else
      insert into public.ii_reference_corrections (target_table, target_row_id, correction_kind, previous_value, new_value, actor_admin_id, actor_kind, reason, batch_id)
      values ('ii_benchmark_series', rec.id, 'quality_status_change', jsonb_build_object('quality_status', rec.quality_status, 'value', rec.value, 'revision_no', rec.revision_no),
              jsonb_build_object('quality_status', 'superseded', 'revision_no', rec.revision_no + 1, 'rollback_of_job', p_job), v_uid, 'admin', 'Rollback of import job ' || p_job::text || ': ' || trim(p_reason), j.ledger_batch_id);
      update public.ii_benchmark_series set quality_status = 'superseded', revision_no = rec.revision_no + 1, import_job_id = null, data_version = 'bench1-rollback-v1' where id = rec.id;
      v_retracted := v_retracted + 1;
    end if;
  end loop;
  update public.ii_benchmark_import_jobs set status = 'rolled_back', rolled_back_by = v_uid, rolled_back_at = now(), rollback_reason = trim(p_reason) where id = p_job;
  update public.ii_reference_import_batches set status = 'rolled_back', error_code = 'ROLLED_BACK_BY_ADMIN' where id = j.ledger_batch_id;
  update public.ii_benchmark_ingestion_state s set
         latest_valid_data_date = (select max(x.series_date) from public.ii_benchmark_series x where x.benchmark_id = s.benchmark_id and x.quality_status = 'ok'),
         completeness_watermark = least(s.completeness_watermark, (select max(x.series_date) from public.ii_benchmark_series x where x.benchmark_id = s.benchmark_id and x.quality_status = 'ok')),
         updated_at = now()
   where s.benchmark_id = any (j.benchmark_ids);
  perform public.ii_bm_log_event('import_job_rolled_back', 'ii_benchmark_import_jobs', p_job, null, jsonb_build_object('restored', v_restored, 'retracted', v_retracted), p_reason);
  return jsonb_build_object('already_rolled_back', false, 'job_id', p_job, 'restored', v_restored, 'retracted', v_retracted);
end $$;
revoke all on function rollback_benchmark_import(uuid, text) from public, anon;
grant execute on function rollback_benchmark_import(uuid, text) to authenticated;

-- 5g. failure bookkeeping, cancel, expiry -------------------------------------
create or replace function record_benchmark_import_failure(p_job uuid, p_code text, p_detail text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  j public.ii_benchmark_import_jobs%rowtype;
begin
  select * into j from public.ii_benchmark_import_jobs where id = p_job for update;
  if not found then return; end if;
  if v_uid is null or not (j.staged_by = v_uid or public.is_benchmark_publisher() or public.is_benchmark_corrector()) then
    raise exception 'benchmark import: not permitted to record a failure on this job' using errcode = '42501';
  end if;
  if j.status not in ('staging', 'validated') then return; end if;
  update public.ii_benchmark_import_jobs set status = case when p_code = 'STALE' then 'stale' else 'failed' end, error_code = left(p_code, 80), error_detail = left(p_detail, 500) where id = p_job;
  perform public.ii_bm_log_event('import_job_failed', 'ii_benchmark_import_jobs', p_job, null, jsonb_build_object('code', p_code), left(p_detail, 500));
end $$;
revoke all on function record_benchmark_import_failure(uuid, text, text) from public, anon;
grant execute on function record_benchmark_import_failure(uuid, text, text) to authenticated;

create or replace function cancel_benchmark_import_job(p_job uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  j public.ii_benchmark_import_jobs%rowtype;
begin
  select * into j from public.ii_benchmark_import_jobs where id = p_job for update;
  if not found then raise exception 'benchmark import: job not found' using errcode = 'P0002'; end if;
  if v_uid is null or not (j.staged_by = v_uid or public.is_benchmark_publisher() or public.is_benchmark_corrector()) then
    raise exception 'benchmark import: not permitted to cancel this job' using errcode = '42501';
  end if;
  if j.status not in ('staging', 'validated', 'failed', 'stale') then raise exception 'benchmark import: job is % and cannot be cancelled', j.status using errcode = '55000'; end if;
  delete from public.ii_benchmark_import_rows where job_id = p_job;
  update public.ii_benchmark_import_jobs set status = 'cancelled' where id = p_job;
  perform public.ii_bm_log_event('import_job_cancelled', 'ii_benchmark_import_jobs', p_job, null, null, null);
end $$;
revoke all on function cancel_benchmark_import_job(uuid) from public, anon;
grant execute on function cancel_benchmark_import_job(uuid) to authenticated;

-- Retention: unpublished staging copies expire after 14 days; staged-row copies
-- of PUBLISHED jobs are purged after 90 days (the canonical rows and the
-- before/after evidence in ii_reference_corrections remain; rollback does not
-- need the staged rows). The raw uploaded FILE is never stored at all.
create or replace function expire_benchmark_import_jobs() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_expired integer; v_purged integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'benchmark import: service role only' using errcode = '42501'; end if;
  with e as (update public.ii_benchmark_import_jobs set status = 'expired' where status in ('staging', 'validated', 'failed', 'stale') and expires_at < now() returning id)
  select count(*) into v_expired from e;
  delete from public.ii_benchmark_import_rows r using public.ii_benchmark_import_jobs j
   where r.job_id = j.id and ((j.status = 'expired') or (j.status in ('published', 'rolled_back') and j.published_at < now() - interval '90 days'));
  get diagnostics v_purged = row_count;
  return jsonb_build_object('expired_jobs', v_expired, 'purged_staged_rows', v_purged);
end $$;
revoke all on function expire_benchmark_import_jobs() from public, anon, authenticated;
grant execute on function expire_benchmark_import_jobs() to service_role;

-- ===========================================================================
-- 6. Selective-history demand + ingestion state + run history
-- ===========================================================================
create table if not exists ii_benchmark_history_demand (
  benchmark_id uuid primary key references ii_benchmarks(id),
  required_from date not null,
  required_from_investor date,
  required_to date not null,
  scheme_count integer not null default 0 check (scheme_count >= 0),
  family_count integer not null default 0 check (family_count >= 0),
  demand_basis jsonb not null default '{}'::jsonb,
  demand_version text not null,
  computed_at timestamptz not null default now(),
  constraint ii_benchmark_history_demand_range check (required_to >= required_from)
);
alter table ii_benchmark_history_demand enable row level security;
drop policy if exists "viewer read ii_benchmark_history_demand" on ii_benchmark_history_demand;
create policy "viewer read ii_benchmark_history_demand" on ii_benchmark_history_demand for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_benchmark_history_demand from anon, authenticated;
comment on table ii_benchmark_history_demand is 'BENCH-1: GLOBAL, aggregate-only demand per exact benchmark (earliest date any held scheme needs, latest expected session). Contains no user, account or holding detail. Written only by the service-role demand job.';

create or replace function upsert_benchmark_history_demand(p_rows jsonb, p_demand_version text) returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'benchmark demand: service role only' using errcode = '42501'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'benchmark demand: rows must be an array of at most 500' using errcode = '22023'; end if;
  insert into public.ii_benchmark_history_demand (benchmark_id, required_from, required_from_investor, required_to, scheme_count, family_count, demand_basis, demand_version, computed_at)
  select r.benchmark_id, r.required_from, r.required_from_investor, r.required_to, coalesce(r.scheme_count, 0), coalesce(r.family_count, 0), coalesce(r.demand_basis, '{}'::jsonb), p_demand_version, now()
    from jsonb_to_recordset(p_rows) as r(benchmark_id uuid, required_from date, required_from_investor date, required_to date, scheme_count integer, family_count integer, demand_basis jsonb)
  on conflict (benchmark_id) do update set required_from = excluded.required_from, required_from_investor = excluded.required_from_investor, required_to = excluded.required_to,
     scheme_count = excluded.scheme_count, family_count = excluded.family_count, demand_basis = excluded.demand_basis, demand_version = excluded.demand_version, computed_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function upsert_benchmark_history_demand(jsonb, text) from public, anon, authenticated;
grant execute on function upsert_benchmark_history_demand(jsonb, text) to service_role;

create table if not exists ii_benchmark_ingestion_state (
  benchmark_id uuid primary key references ii_benchmarks(id),
  ingestion_mode text not null default 'disabled' check (ingestion_mode in ('disabled', 'manual_import', 'automated')),
  source_key text,
  adapter_id text,
  automation_enabled boolean not null default false,
  mode_reason text,
  mode_changed_by uuid,
  mode_changed_at timestamptz,
  publication_lag_days integer not null default 1 check (publication_lag_days between 0 and 30),
  last_attempt_at timestamptz,
  last_successful_run_at timestamptz,
  last_manual_import_at timestamptz,
  latest_valid_data_date date,
  completeness_watermark date,
  last_run_status text,
  last_error_code text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  next_attempt_not_before timestamptz,
  retry_budget_window_date date,
  retries_used_in_window integer not null default 0 check (retries_used_in_window >= 0),
  lease_holder text,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  -- Automation can only be on when the mode says so AND a reason is recorded.
  constraint ii_benchmark_ingestion_state_automation_mode check (not automation_enabled or ingestion_mode = 'automated'),
  constraint ii_benchmark_ingestion_state_watermark_order check (completeness_watermark is null or latest_valid_data_date is null or completeness_watermark <= latest_valid_data_date)
);
alter table ii_benchmark_ingestion_state enable row level security;
drop policy if exists "viewer read ii_benchmark_ingestion_state" on ii_benchmark_ingestion_state;
create policy "viewer read ii_benchmark_ingestion_state" on ii_benchmark_ingestion_state for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_benchmark_ingestion_state from anon, authenticated;

create table if not exists ii_benchmark_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  benchmark_id uuid not null references ii_benchmarks(id),
  run_kind text not null check (run_kind in ('daily', 'late_retry', 'weekly_gap', 'monthly_reconcile', 'history_expansion', 'probe')),
  status text not null check (status in ('succeeded', 'complete_no_new_data', 'empty_response', 'partial', 'failed', 'blocked', 'skipped_global_kill', 'skipped_source_disabled', 'skipped_not_entitled', 'skipped_lease', 'skipped_backoff', 'skipped_write_kill', 'dry_run')),
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  window_from date,
  window_to date,
  http_status integer,
  rows_fetched integer not null default 0,
  rows_inserted integer not null default 0,
  rows_identical integer not null default 0,
  rows_conflicting integer not null default 0,
  latest_valid_data_date_after date,
  completeness_watermark_after date,
  error_code text,
  error_detail text,
  lease_holder text,
  ledger_batch_id uuid
);
create index if not exists idx_ii_benchmark_ingestion_runs_recent on ii_benchmark_ingestion_runs (benchmark_id, started_at desc);
alter table ii_benchmark_ingestion_runs enable row level security;
drop policy if exists "viewer read ii_benchmark_ingestion_runs" on ii_benchmark_ingestion_runs;
create policy "viewer read ii_benchmark_ingestion_runs" on ii_benchmark_ingestion_runs for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_benchmark_ingestion_runs from anon, authenticated;

-- Admin sets the MODE (manual_import / automated / disabled). Automation additionally
-- needs the global switch, the write switch AND an approved 'automation' entitlement
-- at run time; flagging a benchmark 'automated' here grants nothing by itself.
create or replace function set_benchmark_ingestion_mode(p_benchmark uuid, p_mode text, p_source_key text, p_adapter text, p_automation_enabled boolean, p_lag_days integer, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); old public.ii_benchmark_ingestion_state%rowtype;
begin
  if v_uid is null or not public.is_benchmark_catalogue_admin() then raise exception 'benchmark ingestion: catalogue admin capability required' using errcode = '42501'; end if;
  if p_mode not in ('disabled', 'manual_import', 'automated') then raise exception 'benchmark ingestion: unknown mode' using errcode = '22023'; end if;
  if p_reason is null or length(trim(p_reason)) < 10 then raise exception 'benchmark ingestion: a reason of at least 10 characters is required' using errcode = '22023'; end if;
  if p_automation_enabled and p_mode <> 'automated' then raise exception 'benchmark ingestion: automation can only be enabled in automated mode' using errcode = '22023'; end if;
  if p_automation_enabled and not public.benchmark_right_allowed(p_benchmark, 'automation') then
    raise exception 'benchmark ingestion: no approved, in-term entitlement grants the automation right for this benchmark' using errcode = '42501';
  end if;
  select * into old from public.ii_benchmark_ingestion_state where benchmark_id = p_benchmark;
  insert into public.ii_benchmark_ingestion_state (benchmark_id, ingestion_mode, source_key, adapter_id, automation_enabled, mode_reason, mode_changed_by, mode_changed_at, publication_lag_days)
  values (p_benchmark, p_mode, p_source_key, p_adapter, p_automation_enabled, trim(p_reason), v_uid, now(), coalesce(p_lag_days, 1))
  on conflict (benchmark_id) do update set ingestion_mode = excluded.ingestion_mode, source_key = excluded.source_key, adapter_id = excluded.adapter_id,
     automation_enabled = excluded.automation_enabled, mode_reason = excluded.mode_reason, mode_changed_by = excluded.mode_changed_by, mode_changed_at = now(),
     publication_lag_days = excluded.publication_lag_days, updated_at = now();
  perform public.ii_bm_log_event('ingestion_mode_set', 'ii_benchmark_ingestion_state', p_benchmark, to_jsonb(old), jsonb_build_object('mode', p_mode, 'automation_enabled', p_automation_enabled, 'adapter', p_adapter), p_reason);
end $$;
revoke all on function set_benchmark_ingestion_mode(uuid, text, text, text, boolean, integer, text) from public, anon;
grant execute on function set_benchmark_ingestion_mode(uuid, text, text, text, boolean, integer, text) to authenticated;

-- Single-flight lease.
create or replace function claim_benchmark_ingestion_lease(p_benchmark uuid, p_holder text, p_ttl_seconds integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row public.ii_benchmark_ingestion_state%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'benchmark ingestion: service role only' using errcode = '42501'; end if;
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 3600 then raise exception 'benchmark ingestion: lease ttl must be 30..3600 seconds' using errcode = '22023'; end if;
  insert into public.ii_benchmark_ingestion_state (benchmark_id) values (p_benchmark) on conflict (benchmark_id) do nothing;
  update public.ii_benchmark_ingestion_state
     set lease_holder = p_holder, lease_expires_at = now() + make_interval(secs => p_ttl_seconds), updated_at = now()
   where benchmark_id = p_benchmark and (lease_expires_at is null or lease_expires_at < now() or lease_holder = p_holder)
   returning * into v_row;
  if found then return jsonb_build_object('claimed', true, 'holder', v_row.lease_holder, 'expires_at', v_row.lease_expires_at); end if;
  select * into v_row from public.ii_benchmark_ingestion_state where benchmark_id = p_benchmark;
  return jsonb_build_object('claimed', false, 'holder', v_row.lease_holder, 'expires_at', v_row.lease_expires_at);
end $$;
revoke all on function claim_benchmark_ingestion_lease(uuid, text, integer) from public, anon, authenticated;
grant execute on function claim_benchmark_ingestion_lease(uuid, text, integer) to service_role;

create or replace function release_benchmark_ingestion_lease(p_benchmark uuid, p_holder text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'benchmark ingestion: service role only' using errcode = '42501'; end if;
  update public.ii_benchmark_ingestion_state set lease_holder = null, lease_expires_at = null, updated_at = now() where benchmark_id = p_benchmark and lease_holder = p_holder;
end $$;
revoke all on function release_benchmark_ingestion_lease(uuid, text) from public, anon, authenticated;
grant execute on function release_benchmark_ingestion_lease(uuid, text) to service_role;

-- Records one attempt. last_attempt_at ALWAYS moves; last_successful_run_at moves
-- only when p_success is true (the caller decides success under the
-- "HTTP 200 with no expected data is not success" rule); latest_valid_data_date
-- is recomputed from the table; the completeness watermark is supplied by the
-- caller's calendar logic but can never exceed the latest valid data date.
create or replace function record_benchmark_ingestion_attempt(p_benchmark uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_run uuid := gen_random_uuid();
  v_latest date;
  v_wm date := nullif(p ->> 'completeness_watermark', '')::date;
  v_success boolean := coalesce((p ->> 'success')::boolean, false);
  v_fail integer;
  v_status text := p ->> 'status';
  v_now timestamptz := now();
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'benchmark ingestion: service role only' using errcode = '42501'; end if;
  select max(series_date) into v_latest from public.ii_benchmark_series where benchmark_id = p_benchmark and quality_status = 'ok';
  if v_wm is not null and v_latest is not null and v_wm > v_latest then v_wm := v_latest; end if;
  if v_wm is not null and v_latest is null then v_wm := null; end if;
  insert into public.ii_benchmark_ingestion_runs (id, benchmark_id, run_kind, status, started_at, finished_at, window_from, window_to, http_status, rows_fetched, rows_inserted, rows_identical, rows_conflicting,
     latest_valid_data_date_after, completeness_watermark_after, error_code, error_detail, lease_holder, ledger_batch_id)
  values (v_run, p_benchmark, p ->> 'run_kind', v_status, coalesce((p ->> 'started_at')::timestamptz, v_now), v_now, nullif(p ->> 'window_from', '')::date, nullif(p ->> 'window_to', '')::date,
     nullif(p ->> 'http_status', '')::integer, coalesce((p ->> 'rows_fetched')::integer, 0), coalesce((p ->> 'rows_inserted')::integer, 0), coalesce((p ->> 'rows_identical')::integer, 0),
     coalesce((p ->> 'rows_conflicting')::integer, 0), v_latest, v_wm, left(p ->> 'error_code', 80), left(p ->> 'error_detail', 500), left(p ->> 'lease_holder', 120), nullif(p ->> 'ledger_batch_id', '')::uuid);
  insert into public.ii_benchmark_ingestion_state (benchmark_id) values (p_benchmark) on conflict (benchmark_id) do nothing;
  update public.ii_benchmark_ingestion_state s set
    last_attempt_at = v_now,
    last_successful_run_at = case when v_success then v_now else s.last_successful_run_at end,
    latest_valid_data_date = v_latest,
    completeness_watermark = least(coalesce(v_wm, s.completeness_watermark), v_latest),
    last_run_status = v_status, last_error_code = case when v_success then null else left(p ->> 'error_code', 80) end,
    consecutive_failures = case when v_success then 0 when v_status in ('failed', 'blocked', 'empty_response', 'partial') then s.consecutive_failures + 1 else s.consecutive_failures end,
    next_attempt_not_before = nullif(p ->> 'next_attempt_not_before', '')::timestamptz,
    retry_budget_window_date = case when p ->> 'run_kind' = 'late_retry' then current_date else s.retry_budget_window_date end,
    retries_used_in_window = case when p ->> 'run_kind' = 'late_retry' then (case when s.retry_budget_window_date = current_date then s.retries_used_in_window + 1 else 1 end) else s.retries_used_in_window end,
    updated_at = v_now
  where s.benchmark_id = p_benchmark;
  return v_run;
end $$;
revoke all on function record_benchmark_ingestion_attempt(uuid, jsonb) from public, anon, authenticated;
grant execute on function record_benchmark_ingestion_attempt(uuid, jsonb) to service_role;

-- Generic feed write path (automation). Entitlement-gated, never overwrites.
create or replace function publish_benchmark_feed_rows(p_benchmark uuid, p_rows jsonb, p_source_host text, p_run_kind text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.ii_benchmarks%rowtype;
  v_batch uuid := gen_random_uuid();
  v_count integer; v_bad integer; v_identical integer; v_conflicts integer; v_inserted integer;
  v_from date; v_to date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'benchmark feed: service role only' using errcode = '42501'; end if;
  select * into b from public.ii_benchmarks where id = p_benchmark;
  if not found then raise exception 'benchmark feed: unknown benchmark' using errcode = '22023'; end if;
  -- Defence in depth: the kill switches are enforced HERE too (fail closed when a row is missing).
  if (select count(*) from public.ii_reference_job_control where job_key in ('benchmark_ingestion_global', 'benchmark_ingestion_write') and enabled = true) <> 2 then
    raise exception 'benchmark feed: the global and write kill switches are not both on' using errcode = '55000';
  end if;
  if not exists (select 1 from public.ii_benchmark_ingestion_state where benchmark_id = p_benchmark and ingestion_mode = 'automated' and automation_enabled = true) then
    raise exception 'benchmark feed: automation is not enabled for this benchmark' using errcode = '55000';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 1000 then
    raise exception 'benchmark feed: rows must be a non-empty array of at most 1000 entries' using errcode = '22023';
  end if;
  select count(*), count(*) filter (where d is null or v is null or v <= 0 or d > current_date or d < date '1900-01-01'), min(d), max(d)
    into v_count, v_bad, v_from, v_to
    from (select distinct on ((r ->> 'date')) (r ->> 'date')::date as d, (r ->> 'value')::numeric as v from jsonb_array_elements(p_rows) as r order by (r ->> 'date')) x;
  if v_bad > 0 then raise exception 'benchmark feed: % row(s) invalid', v_bad using errcode = '22023'; end if;
  if not (public.benchmark_right_allowed(p_benchmark, 'automation', current_date, v_from, v_to) and public.benchmark_right_allowed(p_benchmark, 'storage', current_date, v_from, v_to)) then
    raise exception 'benchmark feed: no approved, in-term entitlement grants automation+storage for this benchmark and date range' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_benchmark::text, 7));
  select count(*) filter (where abs(s.value - round(x.v, 6)) <= 0.000001), count(*) filter (where abs(s.value - round(x.v, 6)) > 0.000001)
    into v_identical, v_conflicts
    from (select distinct on ((r ->> 'date')) (r ->> 'date')::date as d, (r ->> 'value')::numeric as v from jsonb_array_elements(p_rows) as r order by (r ->> 'date')) x
    join public.ii_benchmark_series s on s.benchmark_id = p_benchmark and s.series_date = x.d and s.quality_status <> 'superseded';
  insert into public.ii_reference_import_batches (id, source_key, source_config_id, batch_kind, window_from, window_to, as_of_date, status, started_at, finished_at, rows_read, rows_accepted, rows_rejected, rows_inserted, rows_unchanged, notes)
  values (v_batch, left(coalesce(p_source_host, 'feed'), 100), 'bench1_feed_' || left(coalesce(p_run_kind, 'daily'), 30), 'benchmark_level', v_from, v_to, v_to, 'succeeded', now(), now(), v_count, v_count, 0, 0, v_identical,
          jsonb_build_object('benchmark', b.benchmark_key, 'run_kind', p_run_kind));
  insert into public.ii_benchmark_series (benchmark_id, series_date, value, currency_code, data_version, quality_status, import_batch_id, history_class, revision_no)
  select p_benchmark, x.d, round(x.v, 6), b.currency_code, 'bench1-feed-v1', 'ok', v_batch, 'live', 1
    from (select distinct on ((r ->> 'date')) (r ->> 'date')::date as d, (r ->> 'value')::numeric as v from jsonb_array_elements(p_rows) as r order by (r ->> 'date')) x
  on conflict (benchmark_id, series_date) do nothing;
  get diagnostics v_inserted = row_count;
  update public.ii_reference_import_batches set rows_inserted = v_inserted where id = v_batch;
  return jsonb_build_object('batch_id', v_batch, 'inserted', v_inserted, 'identical', v_identical, 'conflicts_skipped', v_conflicts);
end $$;
revoke all on function publish_benchmark_feed_rows(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function publish_benchmark_feed_rows(uuid, jsonb, text, text) to service_role;

-- ===========================================================================
-- 7. Catalogue + mapping governance
-- ===========================================================================
alter table ii_instrument_benchmarks add column if not exists evidence_url text;
alter table ii_instrument_benchmarks add column if not exists evidence_title text;
alter table ii_instrument_benchmarks add column if not exists evidence_document_date date;
alter table ii_instrument_benchmarks add column if not exists evidence_retrieved_at date;
alter table ii_instrument_benchmarks add column if not exists evidence_excerpt text;
alter table ii_instrument_benchmarks add column if not exists resolution_method text
  check (resolution_method is null or resolution_method in ('deterministic_exact', 'identifier_match', 'admin_judgement'));
alter table ii_instrument_benchmarks add column if not exists resolution_confidence text
  check (resolution_confidence is null or resolution_confidence in ('high', 'medium', 'low'));
alter table ii_instrument_benchmarks add column if not exists reviewed_by uuid;
alter table ii_instrument_benchmarks add column if not exists reviewed_at timestamptz;
alter table ii_instrument_benchmarks add column if not exists proposal_id uuid;

-- Overlapping PRIMARY mappings are refused by the DATABASE (0043 left this to the
-- application layer). A benchmark CHANGE is a new effective-dated row, never an
-- overwrite of the old one's meaning.
create or replace function ii_instrument_benchmarks_no_primary_overlap() returns trigger
language plpgsql as $$
begin
  if new.relationship_type = 'primary' and new.quality_status is distinct from 'superseded' then
    if exists (
      select 1 from public.ii_instrument_benchmarks o
       where o.instrument_id = new.instrument_id and o.relationship_type = 'primary'
         and o.quality_status is distinct from 'superseded' and o.id <> new.id
         and daterange(o.effective_from, coalesce(o.effective_to, 'infinity'::date), '[]') && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
    ) then
      raise exception 'overlapping PRIMARY benchmark mapping for instrument % (close the previous mapping first)', new.instrument_id using errcode = '23P01';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_ii_instrument_benchmarks_no_primary_overlap on ii_instrument_benchmarks;
create trigger trg_ii_instrument_benchmarks_no_primary_overlap
  before insert or update on ii_instrument_benchmarks
  for each row execute function ii_instrument_benchmarks_no_primary_overlap();

create table if not exists ii_benchmark_mapping_proposals (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id),
  benchmark_id uuid references ii_benchmarks(id),
  proposed_benchmark_name text not null check (length(trim(proposed_benchmark_name)) >= 2),
  relationship_type text not null default 'primary' check (relationship_type in ('primary', 'secondary', 'category_average')),
  effective_from date not null,
  effective_to date,
  evidence_source text not null check (evidence_source in ('amc_sid', 'amc_kim', 'amc_factsheet', 'amc_addendum', 'amfi_disclosure', 'other')),
  evidence_url text not null check (length(trim(evidence_url)) >= 8),
  evidence_title text,
  evidence_document_date date not null,
  evidence_retrieved_at date not null,
  evidence_excerpt text check (evidence_excerpt is null or length(evidence_excerpt) <= 400),
  resolution_method text not null check (resolution_method in ('deterministic_exact', 'identifier_match', 'admin_judgement')),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  ambiguity_reason text,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'superseded')),
  proposed_by uuid,
  proposed_at timestamptz not null default now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  auto_published boolean not null default false,
  resulting_mapping_id uuid references ii_instrument_benchmarks(id),
  constraint ii_benchmark_mapping_proposals_range check (effective_to is null or effective_to >= effective_from),
  constraint ii_benchmark_mapping_proposals_decided check (status = 'proposed' or (reviewed_at is not null and (reviewed_by is not null or auto_published)))
);
create index if not exists idx_ii_benchmark_mapping_proposals_open on ii_benchmark_mapping_proposals (status, proposed_at desc);
alter table ii_benchmark_mapping_proposals enable row level security;
drop policy if exists "viewer read ii_benchmark_mapping_proposals" on ii_benchmark_mapping_proposals;
create policy "viewer read ii_benchmark_mapping_proposals" on ii_benchmark_mapping_proposals for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_benchmark_mapping_proposals from anon, authenticated;
comment on table ii_benchmark_mapping_proposals is 'BENCH-1: every scheme->benchmark mapping starts as a proposal WITH evidence. Only deterministic, adequately evidenced, high-confidence matches to a VERIFIED catalogue entry auto-publish; everything else waits for a catalogue admin.';

create or replace function propose_benchmark_mapping(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_uid uuid := auth.uid();
begin
  if not ((v_uid is not null and public.is_benchmark_catalogue_admin()) or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'benchmark mapping: catalogue admin or service role required' using errcode = '42501';
  end if;
  insert into public.ii_benchmark_mapping_proposals (instrument_id, benchmark_id, proposed_benchmark_name, relationship_type, effective_from, effective_to, evidence_source, evidence_url, evidence_title,
      evidence_document_date, evidence_retrieved_at, evidence_excerpt, resolution_method, confidence, ambiguity_reason, proposed_by)
  values ((p ->> 'instrument_id')::uuid, nullif(p ->> 'benchmark_id', '')::uuid, p ->> 'proposed_benchmark_name', coalesce(p ->> 'relationship_type', 'primary'),
      (p ->> 'effective_from')::date, nullif(p ->> 'effective_to', '')::date, p ->> 'evidence_source', p ->> 'evidence_url', p ->> 'evidence_title',
      (p ->> 'evidence_document_date')::date, (p ->> 'evidence_retrieved_at')::date, left(p ->> 'evidence_excerpt', 400), p ->> 'resolution_method', p ->> 'confidence',
      nullif(p ->> 'ambiguity_reason', ''), v_uid)
  returning id into v_id;
  perform public.ii_bm_log_event('mapping_proposed', 'ii_benchmark_mapping_proposals', v_id, null, p, null);
  return v_id;
end $$;
revoke all on function propose_benchmark_mapping(jsonb) from public, anon;
grant execute on function propose_benchmark_mapping(jsonb) to authenticated, service_role;

-- Internal: turn an approved proposal into the canonical effective-dated mapping.
create or replace function ii_bm_apply_mapping(p_proposal uuid, p_reviewer uuid, p_auto boolean, p_close_previous boolean, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  pr public.ii_benchmark_mapping_proposals%rowtype;
  v_map uuid;
  prev record;
begin
  select * into pr from public.ii_benchmark_mapping_proposals where id = p_proposal for update;
  if not found then raise exception 'benchmark mapping: proposal not found' using errcode = 'P0002'; end if;
  if pr.status <> 'proposed' then raise exception 'benchmark mapping: proposal is already %', pr.status using errcode = '55000'; end if;
  if pr.benchmark_id is null then raise exception 'benchmark mapping: the proposal names no catalogue benchmark yet (resolve it first)' using errcode = '22023'; end if;
  perform 1 from public.ii_benchmarks where id = pr.benchmark_id and lifecycle_status = 'active' and catalogue_status = 'verified';
  if not found then raise exception 'benchmark mapping: the benchmark must be an ACTIVE, VERIFIED catalogue entry' using errcode = '22023'; end if;
  if pr.relationship_type = 'primary' then
    for prev in select * from public.ii_instrument_benchmarks o where o.instrument_id = pr.instrument_id and o.relationship_type = 'primary' and o.quality_status is distinct from 'superseded'
                   and daterange(o.effective_from, coalesce(o.effective_to, 'infinity'::date), '[]') && daterange(pr.effective_from, coalesce(pr.effective_to, 'infinity'::date), '[]') loop
      if prev.benchmark_id = pr.benchmark_id and prev.effective_from = pr.effective_from then
        raise exception 'benchmark mapping: an identical mapping already exists' using errcode = '23505';
      end if;
      if not p_close_previous or p_auto then
        raise exception 'benchmark mapping: it overlaps the existing primary mapping (benchmark %, from %); a benchmark CHANGE needs an explicit reviewed close of the previous mapping', prev.benchmark_id, prev.effective_from using errcode = '23P01';
      end if;
      if prev.effective_from >= pr.effective_from then
        raise exception 'benchmark mapping: the existing mapping starts on/after the new effective date; correct the dates' using errcode = '22023';
      end if;
      update public.ii_instrument_benchmarks set effective_to = pr.effective_from - 1 where id = prev.id;
      perform public.ii_bm_log_event('mapping_closed', 'ii_instrument_benchmarks', prev.id, to_jsonb(prev), jsonb_build_object('effective_to', pr.effective_from - 1), p_note);
    end loop;
  end if;
  insert into public.ii_instrument_benchmarks (instrument_id, benchmark_id, relationship_type, effective_from, effective_to, mapping_basis, mapping_version, quality_status,
      evidence_url, evidence_title, evidence_document_date, evidence_retrieved_at, evidence_excerpt, resolution_method, resolution_confidence, reviewed_by, reviewed_at, proposal_id)
  values (pr.instrument_id, pr.benchmark_id, pr.relationship_type, pr.effective_from, pr.effective_to, 'scheme_disclosed', 'bench1-v1', 'ok',
      pr.evidence_url, pr.evidence_title, pr.evidence_document_date, pr.evidence_retrieved_at, pr.evidence_excerpt, pr.resolution_method, pr.confidence, p_reviewer, now(), pr.id)
  returning id into v_map;
  update public.ii_benchmark_mapping_proposals set status = 'approved', reviewed_by = p_reviewer, reviewed_at = now(), review_note = p_note, auto_published = p_auto, resulting_mapping_id = v_map where id = p_proposal;
  perform public.ii_bm_log_event(case when p_auto then 'mapping_auto_published' else 'mapping_approved' end, 'ii_instrument_benchmarks', v_map, null, jsonb_build_object('proposal', p_proposal, 'benchmark_id', pr.benchmark_id, 'effective_from', pr.effective_from), p_note);
  return v_map;
end $$;
revoke all on function ii_bm_apply_mapping(uuid, uuid, boolean, boolean, text) from public, anon, authenticated;

create or replace function review_benchmark_mapping(p_proposal uuid, p_decision text, p_note text, p_close_previous boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_map uuid;
begin
  if v_uid is null or not public.is_benchmark_catalogue_admin() then raise exception 'benchmark mapping: catalogue admin capability required' using errcode = '42501'; end if;
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'benchmark mapping: a review note of at least 10 characters is required' using errcode = '22023'; end if;
  if p_decision = 'approve' then
    return public.ii_bm_apply_mapping(p_proposal, v_uid, false, p_close_previous, p_note);
  elsif p_decision = 'reject' then
    update public.ii_benchmark_mapping_proposals set status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = p_note where id = p_proposal and status = 'proposed';
    if not found then raise exception 'benchmark mapping: proposal not found or already decided' using errcode = '55000'; end if;
    perform public.ii_bm_log_event('mapping_rejected', 'ii_benchmark_mapping_proposals', p_proposal, null, null, p_note);
    return null;
  end if;
  raise exception 'benchmark mapping: decision must be approve or reject' using errcode = '22023';
end $$;
revoke all on function review_benchmark_mapping(uuid, text, text, boolean) from public, anon;
grant execute on function review_benchmark_mapping(uuid, text, text, boolean) to authenticated;

-- Deterministic auto-publish. ONLY: service role, deterministic exact/identifier
-- match, HIGH confidence, no ambiguity, evidence URL + document date + retrieval date,
-- a resolved VERIFIED catalogue benchmark, and no overlap. Anything else stays a
-- proposal for a human (it never half-publishes).
create or replace function auto_publish_benchmark_mapping(p_proposal uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pr public.ii_benchmark_mapping_proposals%rowtype; v_map uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'benchmark mapping: service role only' using errcode = '42501'; end if;
  select * into pr from public.ii_benchmark_mapping_proposals where id = p_proposal;
  if not found then raise exception 'benchmark mapping: proposal not found' using errcode = 'P0002'; end if;
  if pr.status <> 'proposed' or pr.resolution_method not in ('deterministic_exact', 'identifier_match') or pr.confidence <> 'high'
     or pr.ambiguity_reason is not null or pr.benchmark_id is null or pr.relationship_type <> 'primary' or pr.evidence_source = 'other' then
    return jsonb_build_object('auto_published', false, 'reason', 'routed to admin review: not a deterministic, high-confidence, unambiguous primary match with authoritative evidence');
  end if;
  begin
    v_map := public.ii_bm_apply_mapping(p_proposal, null, true, false, 'auto-published: deterministic match with evidence');
  exception when others then
    return jsonb_build_object('auto_published', false, 'reason', 'routed to admin review: ' || sqlerrm);
  end;
  return jsonb_build_object('auto_published', true, 'mapping_id', v_map);
end $$;
revoke all on function auto_publish_benchmark_mapping(uuid) from public, anon, authenticated;
grant execute on function auto_publish_benchmark_mapping(uuid) to service_role;

-- Catalogue entry upsert (draft) and verification.
create or replace function upsert_benchmark_catalogue_entry(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid; v_key text := p ->> 'benchmark_key'; existing public.ii_benchmarks%rowtype;
begin
  if v_uid is null or not public.is_benchmark_catalogue_admin() then raise exception 'benchmark catalogue: catalogue admin capability required' using errcode = '42501'; end if;
  if v_key is null or v_key !~ '^[A-Z0-9_]{3,64}$' then raise exception 'benchmark catalogue: benchmark_key must be 3-64 chars of A-Z, 0-9, _' using errcode = '22023'; end if;
  select * into existing from public.ii_benchmarks where benchmark_key = v_key;
  if found and existing.catalogue_status = 'verified' and (p ->> 'return_variant') is distinct from existing.return_variant then
    raise exception 'benchmark catalogue: the variant of a verified benchmark is immutable (create a new key for a different variant)' using errcode = '55000';
  end if;
  insert into public.ii_benchmarks (benchmark_key, benchmark_label, benchmark_category, country_code, return_type, return_variant, frequency, currency_code, official_name, owner_name, official_identifier,
      asset_class, base_date, base_value, launch_date, history_start_date, history_class, backtested_through, calendar_code, methodology_url, source_url, evidence_ref, evidence_retrieved_at, catalogue_status)
  values (v_key, coalesce(p ->> 'benchmark_label', p ->> 'official_name'), coalesce(p ->> 'benchmark_category', 'index'), p ->> 'country_code', p ->> 'return_type', p ->> 'return_variant', coalesce(p ->> 'frequency', 'business_daily'),
      p ->> 'currency_code', p ->> 'official_name', p ->> 'owner_name', p ->> 'official_identifier', p ->> 'asset_class', nullif(p ->> 'base_date', '')::date, nullif(p ->> 'base_value', '')::numeric,
      nullif(p ->> 'launch_date', '')::date, nullif(p ->> 'history_start_date', '')::date, coalesce(p ->> 'history_class', 'unknown'), nullif(p ->> 'backtested_through', '')::date,
      p ->> 'calendar_code', p ->> 'methodology_url', p ->> 'source_url', p ->> 'evidence_ref', nullif(p ->> 'evidence_retrieved_at', '')::date, 'draft')
  on conflict (benchmark_key) do update set
      return_type = case when ii_benchmarks.catalogue_status = 'verified' then ii_benchmarks.return_type else excluded.return_type end,
      return_variant = case when ii_benchmarks.catalogue_status = 'verified' then ii_benchmarks.return_variant else excluded.return_variant end,
      currency_code = case when ii_benchmarks.catalogue_status = 'verified' then ii_benchmarks.currency_code else excluded.currency_code end,
      country_code = case when ii_benchmarks.catalogue_status = 'verified' then ii_benchmarks.country_code else excluded.country_code end,
      benchmark_label = excluded.benchmark_label, official_name = excluded.official_name, owner_name = excluded.owner_name, official_identifier = excluded.official_identifier, asset_class = excluded.asset_class,
      base_date = excluded.base_date, base_value = excluded.base_value, launch_date = excluded.launch_date, history_start_date = excluded.history_start_date, history_class = excluded.history_class,
      backtested_through = excluded.backtested_through, calendar_code = excluded.calendar_code, methodology_url = excluded.methodology_url, source_url = excluded.source_url,
      evidence_ref = excluded.evidence_ref, evidence_retrieved_at = excluded.evidence_retrieved_at,
      catalogue_status = case when ii_benchmarks.catalogue_status = 'verified' then 'draft' else ii_benchmarks.catalogue_status end,
      verified_by = case when ii_benchmarks.catalogue_status = 'verified' then null else ii_benchmarks.verified_by end,
      verified_at = case when ii_benchmarks.catalogue_status = 'verified' then null else ii_benchmarks.verified_at end,
      updated_at = now()
  returning id into v_id;
  perform public.ii_bm_log_event('catalogue_upserted', 'ii_benchmarks', v_id, to_jsonb(existing), p, null);
  return v_id;
end $$;
revoke all on function upsert_benchmark_catalogue_entry(jsonb) from public, anon;
grant execute on function upsert_benchmark_catalogue_entry(jsonb) to authenticated;

create or replace function verify_benchmark_catalogue_entry(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_benchmark_catalogue_admin() then raise exception 'benchmark catalogue: catalogue admin capability required' using errcode = '42501'; end if;
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'benchmark catalogue: a verification note of at least 10 characters is required' using errcode = '22023'; end if;
  update public.ii_benchmarks set catalogue_status = 'verified', verified_by = v_uid, verified_at = now(), updated_at = now() where id = p_id and catalogue_status = 'draft';
  if not found then raise exception 'benchmark catalogue: entry not found or not in draft' using errcode = '55000'; end if;
  perform public.ii_bm_log_event('catalogue_verified', 'ii_benchmarks', p_id, null, null, p_note);
end $$;
revoke all on function verify_benchmark_catalogue_entry(uuid, text) from public, anon;
grant execute on function verify_benchmark_catalogue_entry(uuid, text) to authenticated;

-- ===========================================================================
-- 8. Tighten the 0232 write paths so none bypasses the entitlement gate
-- ===========================================================================
-- The 0232 single-step upload RPC wrote series rows on an attestation checkbox
-- alone. It is superseded by the staged pipeline and is no longer callable by
-- an authenticated session.
do $$ begin
  if to_regprocedure('commit_market_index_upload(text,text,text,jsonb,boolean,text)') is not null then
    revoke execute on function commit_market_index_upload(text, text, text, jsonb, boolean, text) from authenticated;
  end if;
end $$;

-- The 0232 feed RPC now also requires the 'automation' + 'storage' rights.
do $$ begin
  if to_regprocedure('record_market_index_feed_closes(text,jsonb,text)') is not null then
    execute $f$
      create or replace function record_market_index_feed_closes(p_benchmark_key text, p_rows jsonb, p_source_host text) returns jsonb
      language plpgsql security definer set search_path = public as $body$
      declare
        v_bench uuid; v_batch uuid := gen_random_uuid();
        v_count integer; v_bad integer; v_identical integer; v_conflicts integer; v_inserted integer; v_from date; v_to date;
      begin
        if coalesce(auth.role(), '') <> 'service_role' then raise exception 'market index feed: service role only' using errcode = '42501'; end if;
        if p_benchmark_key not in ('IN_NIFTY_50_PRI', 'IN_SENSEX_PRI') then raise exception 'market index feed: unsupported index' using errcode = '22023'; end if;
        if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 400 then
          raise exception 'market index feed: rows must be a non-empty array of at most 400 entries' using errcode = '22023';
        end if;
        select id into v_bench from public.ii_benchmarks where benchmark_key = p_benchmark_key;
        if v_bench is null then raise exception 'market index feed: benchmark row missing' using errcode = '22023'; end if;
        select count(*), count(*) filter (where d is null or v is null or v <= 0 or d > current_date or d < date '1979-01-01'), min(d), max(d)
          into v_count, v_bad, v_from, v_to
          from (select distinct on ((r ->> 'date')) (r ->> 'date')::date as d, (r ->> 'close')::numeric as v from jsonb_array_elements(p_rows) as r order by (r ->> 'date')) x;
        if v_bad > 0 then raise exception 'market index feed: % row(s) invalid', v_bad using errcode = '22023'; end if;
        if not (public.benchmark_right_allowed(v_bench, 'automation', current_date, v_from, v_to) and public.benchmark_right_allowed(v_bench, 'storage', current_date, v_from, v_to)) then
          raise exception 'market index feed: no approved, in-term entitlement grants automation+storage for this index' using errcode = '42501';
        end if;
        select count(*) filter (where abs(s.value - x.v) <= 0.000001), count(*) filter (where abs(s.value - x.v) > 0.000001)
          into v_identical, v_conflicts
          from (select distinct on ((r ->> 'date')) (r ->> 'date')::date as d, (r ->> 'close')::numeric as v from jsonb_array_elements(p_rows) as r order by (r ->> 'date')) x
          join public.ii_benchmark_series s on s.benchmark_id = v_bench and s.series_date = x.d and s.quality_status <> 'superseded';
        insert into public.ii_benchmark_series (benchmark_id, series_date, value, currency_code, data_version, quality_status, import_batch_id)
          select v_bench, x.d, x.v, 'INR', 'market-index-feed-v1', 'ok', v_batch
            from (select distinct on ((r ->> 'date')) (r ->> 'date')::date as d, (r ->> 'close')::numeric as v from jsonb_array_elements(p_rows) as r order by (r ->> 'date')) x
          on conflict (benchmark_id, series_date) do nothing;
        get diagnostics v_inserted = row_count;
        insert into public.ii_market_index_batches (id, benchmark_key, source_kind, source_host, row_count_submitted, rows_inserted, rows_identical_skipped, rows_conflicts_skipped, date_from, date_to)
        values (v_batch, p_benchmark_key, 'daily_feed', left(p_source_host, 255), v_count, v_inserted, v_identical, v_conflicts, v_from, v_to);
        return jsonb_build_object('batch_id', v_batch, 'inserted', v_inserted, 'identical', v_identical, 'conflicts_skipped', v_conflicts);
      end $body$;
    $f$;
  end if;
end $$;

-- ===========================================================================
-- 9. Kill switches (SHIPPED DISABLED; no pg_cron schedule is created here)
-- ===========================================================================
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'benchmark_ingestion_global', false,
  'Shipped disabled by migration 0239 (BENCH-1 Phase 2). Master switch for ALL benchmark-specific recurring ingestion. No source has a verified automation right; enabling is a deliberate, human-present step after an automation entitlement is approved.'
where not exists (select 1 from ii_reference_job_control where job_key = 'benchmark_ingestion_global');
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'benchmark_ingestion_write', false,
  'Shipped disabled by migration 0239. While off, a run may fetch and validate but writes NOTHING (dry run). Both this and benchmark_ingestion_global must be on, per benchmark, with an approved automation entitlement, for any recurring write.'
where not exists (select 1 from ii_reference_job_control where job_key = 'benchmark_ingestion_write');
