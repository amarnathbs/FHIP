-- 0252 - BENCH-1: monthly FACTSHEET BENCHMARK READER (declared benchmarks, effective-dated, append-only).
--
-- WHAT THIS ADDS (all NEW objects; nothing existing is altered, dropped or re-created; no CHECK constraint on an
-- existing table is touched, so there is no "drop-and-recreate" step that could revoke a sibling branch's values):
--   ii_factsheet_sources                    registry of fund-house documents the reader may read, each with a
--                                           terms_review_status ('not_reviewed' by default). The job REFUSES to fetch from
--                                           any source whose status is not 'approved'.
--   ii_factsheet_attempts                   append-only attempt ledger (one row per scheme per source per month result).
--   ii_scheme_declared_benchmark_versions   append-only history of the benchmark each fund house DECLARES for a scheme
--                                           (names and composition as stated, source document, checksum, extraction
--                                           method, confidence). A change is a NEW version; the old one is never altered.
--   ii_factsheet_version_events             append-only decisions and links on a version (proposal created, auto-published,
--                                           approved, rejected, entered manually, acknowledged).
--   functions                               narrow SECURITY DEFINER writers for the job (service role only), the admin
--                                           review (catalogue capability), the terms-status setter (entitlement-approver
--                                           capability) and a read function for the end-user comparison surfaces.
--   kill switch                             ii_reference_job_control row 'factsheet_benchmark_reader', SHIPPED OFF.
--
-- WHAT IT NEVER STORES: factsheet performance / return figures or index levels. Facts only.
--
-- NO NEW ADMIN CAPABILITY. Reads use is_benchmark_data_viewer(); the review uses is_benchmark_catalogue_admin();
-- changing a source's terms status uses is_benchmark_entitlement_approver() (the existing "may we use this source"
-- capability). The job runs as the service role.
--
-- NO SCHEDULE IS CREATED HERE. The job is a route (/api/investment-intelligence/cron/factsheet-benchmark-reader)
-- protected by CRON_SECRET; scheduling is a deliberate, human-present step.
--
-- APPLY ORDER: after 0241 (mapping governance) and 0251 (held-schemes list). ADDITIVE and IDEMPOTENT.

do $$ begin
  if to_regprocedure('public.is_benchmark_data_viewer()') is null
     or to_regprocedure('public.propose_benchmark_mapping(jsonb)') is null
     or to_regprocedure('public.auto_publish_benchmark_mapping(uuid)') is null
     or to_regprocedure('public.review_benchmark_mapping(uuid,text,text,boolean)') is null then
    raise exception '0252 requires migration 0241 (benchmark mapping governance) to be applied first';
  end if;
  if to_regclass('public.ii_benchmark_mapping_proposals') is null or to_regclass('public.ii_reference_job_control') is null or to_regclass('public.ii_instrument_benchmarks') is null then
    raise exception '0252 requires migrations 0155 and 0241 to be applied first';
  end if;
end $$;

-- ===========================================================================
-- 1. Shared append-only guard
-- ===========================================================================
create or replace function ii_factsheet_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only (% blocked): a changed benchmark is recorded as a NEW row, never an edit', tg_table_name, tg_op using errcode = '42501';
end $$;

-- ===========================================================================
-- 2. Source registry
-- ===========================================================================
create table if not exists ii_factsheet_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique check (source_key ~ '^[a-z0-9_]{3,80}$'),
  amc_key text not null,
  amc_name text not null,
  document_type text not null check (document_type in ('amc_factsheet', 'amc_sid', 'amc_kim', 'amc_addendum', 'amfi_disclosure', 'other')),
  url_kind text not null default 'fixed' check (url_kind in ('fixed', 'monthly_template')),
  url text not null check (url ~ '^https://[^/ ]+/'),
  host text not null,
  amfi_scheme_codes text[] not null default '{}',
  document_scheme_name text not null check (length(trim(document_scheme_name)) >= 3),
  document_scope text not null default 'single_scheme' check (document_scope in ('single_scheme', 'multi_scheme')),
  priority integer not null default 100,
  enabled boolean not null default true,
  terms_review_status text not null default 'not_reviewed' check (terms_review_status in ('not_reviewed', 'under_review', 'approved', 'declined')),
  terms_reviewed_by uuid,
  terms_reviewed_at timestamptz,
  terms_review_note text,
  note text,
  -- Conditional-request state, updated by the job through touch_factsheet_source() only.
  last_etag text,
  last_modified text,
  last_checksum text,
  last_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ii_factsheet_sources_approved_has_review check (
    terms_review_status <> 'approved' or (terms_reviewed_by is not null and terms_reviewed_at is not null and length(coalesce(terms_review_note, '')) >= 10)
  )
);
alter table ii_factsheet_sources enable row level security;
drop policy if exists "viewer read ii_factsheet_sources" on ii_factsheet_sources;
create policy "viewer read ii_factsheet_sources" on ii_factsheet_sources for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_factsheet_sources from anon, authenticated;
comment on table ii_factsheet_sources is 'BENCH-1 (0252): fund-house documents the factsheet benchmark reader may read. terms_review_status defaults to not_reviewed; the job refuses to fetch unless it is approved.';

-- Seed: ONLY the official domains confirmed in the 2026-10-03 six-funds research. Every row is 'not_reviewed'.
-- (No AMFI-hosted SID is seeded: none of the two read in research belongs to a held scheme. No monthly URL template:
--  SBI's per-file "sfvrsn" token cannot be predicted.)
insert into ii_factsheet_sources (source_key, amc_key, amc_name, document_type, url, host, amfi_scheme_codes, document_scheme_name, document_scope, priority, terms_review_status, note) values
  ('hdfc_baf_fund_facts_2026_03', 'hdfc', 'HDFC Mutual Fund', 'amc_factsheet',
   'https://files.hdfcfund.com/s3fs-public/Others/2026-03/Fund%20Facts%20-%20HDFC%20Balanced%20Advantage%20Fund_March%2026.pdf', 'files.hdfcfund.com', array['100119'], 'HDFC Balanced Advantage Fund', 'single_scheme', 10, 'not_reviewed',
   'Fund Facts, March 2026 (research: benchmark line NIFTY 50 Hybrid Composite Debt 50:50 TRI).'),
  ('hdfc_baf_sid_2024_06', 'hdfc', 'HDFC Mutual Fund', 'amc_sid',
   'https://files.hdfcfund.com/s3fs-public/SID/2024-06/SID%20-%20HDFC%20Balanced%20Advantage%20Fund%20dated%20June%2028,%202024.pdf', 'files.hdfcfund.com', array['100119'], 'HDFC Balanced Advantage Fund', 'single_scheme', 50, 'not_reviewed',
   'SID dated 28 June 2024. Older than the Fund Facts above, so it can never supersede it.'),
  ('hdfc_gold_fof_sid_2025_11', 'hdfc', 'HDFC Mutual Fund', 'amc_sid',
   'https://files.hdfcfund.com/s3fs-public/SID/2025-11/SID%20-%20HDFC%20Gold%20ETF%20Fund%20of%20Fund%20dated%20November%2021,%202025.pdf', 'files.hdfcfund.com', array['115934'], 'HDFC Gold ETF Fund of Fund', 'single_scheme', 10, 'not_reviewed',
   'SID dated 21 November 2025. Benchmark is a commodity price: recorded as unsupported, never published.'),
  ('sbi_multi_asset_factsheet_2026_04', 'sbi', 'SBI Mutual Fund', 'amc_factsheet',
   'https://www.sbimf.com/docs/default-source/scheme-factsheets/sbi-multi-asset-allocation-fund-factsheet-april-2026.pdf?sfvrsn=829ed1fb_2', 'www.sbimf.com', array['103408'], 'SBI Multi Asset Allocation Fund', 'single_scheme', 10, 'not_reviewed',
   'Factsheet, report as on 30 April 2026. Four-leg composite with a stated effective date: recorded as unsupported composite, never published.'),
  ('sbi_contra_factsheet_2025_08', 'sbi', 'SBI Mutual Fund', 'amc_factsheet',
   'https://www.sbimf.com/docs/default-source/scheme-factsheets/sbi-contra-fund-factsheet-august-2025.pdf?sfvrsn=6d2d8066_2', 'www.sbimf.com', array['102414'], 'SBI Contra Fund', 'single_scheme', 10, 'not_reviewed',
   'Factsheet, report as on 31 August 2025 (research: First Tier Benchmark BSE 500 TRI).'),
  ('sbi_contra_sid_2025_10', 'sbi', 'SBI Mutual Fund', 'amc_sid',
   'https://www.sbimf.com/docs/default-source/sif-forms/sid---sbi-contra-fund.pdf?sfvrsn=4a20c1ae_0', 'www.sbimf.com', array['102414'], 'SBI Contra Fund', 'single_scheme', 50, 'not_reviewed',
   'SID dated 31 October 2025.'),
  ('nippon_power_infra_presentation', 'nippon', 'Nippon India Mutual Fund', 'other',
   'https://mf.nipponindiaim.com/FundsAndPerformance/Presentation/NipponIndia-Power-Infra-Fund-Presentation.pdf', 'mf.nipponindiaim.com', array['101262'], 'Nippon India Power & Infra Fund', 'single_scheme', 10, 'not_reviewed',
   'Fund presentation (research read a copy with data as on 30 July 2021). Document type is "other", so it can never auto-publish: a human decides.'),
  ('icici_dividend_yield_complete_factsheet', 'icici', 'ICICI Prudential Mutual Fund', 'amc_factsheet',
   'https://www.icicipruamc.com/blob/knowledgecentre/factsheet-complete/Complete.pdf', 'www.icicipruamc.com', array['129310'], 'ICICI Prudential Dividend Yield Equity Fund', 'multi_scheme', 10, 'not_reviewed',
   'Complete factsheet. Research found these PDFs exceed 10 MB, so this row is EXPECTED to end as "document too large" (skipped, not truncated); it is registered so the gap is visible, not hidden.')
on conflict (source_key) do nothing;

-- ===========================================================================
-- 3. Declared-benchmark versions (APPEND-ONLY)
-- ===========================================================================
create table if not exists ii_scheme_declared_benchmark_versions (
  id uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references ii_instruments(id),
  version_no integer not null check (version_no >= 1),
  supersedes_version_id uuid references ii_scheme_declared_benchmark_versions(id),
  tier1_name text not null check (length(trim(tier1_name)) >= 3 and length(tier1_name) <= 400),
  tier1_variant_hint text check (tier1_variant_hint is null or tier1_variant_hint in ('total_return', 'price', 'net_total_return')),
  additional_names text[] not null default '{}',
  benchmark_kind text not null check (benchmark_kind in ('single_index', 'composite', 'commodity_price')),
  composition jsonb not null default '[]'::jsonb,
  catalogue_state text not null check (catalogue_state in ('matched_verified', 'matched_other', 'unsupported_composite', 'unsupported_commodity', 'no_catalogue_match')),
  matched_benchmark_id uuid references ii_benchmarks(id),
  match_confidence text check (match_confidence is null or match_confidence in ('high', 'medium', 'low')),
  effective_from date not null,
  effective_from_basis text not null check (effective_from_basis in ('document_stated', 'estimated_document_month')),
  source_id uuid not null references ii_factsheet_sources(id),
  source_url text not null check (source_url ~ '^https://'),
  source_title text,
  source_document_type text not null check (source_document_type in ('amc_factsheet', 'amc_sid', 'amc_kim', 'amc_addendum', 'amfi_disclosure', 'other')),
  document_date date,
  document_date_precision text check (document_date_precision is null or document_date_precision in ('day', 'month')),
  document_month date not null check (extract(day from document_month) = 1),
  retrieved_at timestamptz not null,
  document_checksum text not null,
  extraction_method text not null check (extraction_method in ('text_pattern', 'ai', 'text_pattern_and_ai', 'manual')),
  extractor_version text not null,
  ai_model text,
  extraction_confidence text not null check (extraction_confidence in ('high', 'medium', 'low')),
  extractors_agree boolean,
  evidence_excerpt text check (evidence_excerpt is null or length(evidence_excerpt) <= 400),
  review_state text not null check (review_state in ('awaiting_confirmation', 'pending_review', 'recorded_only', 'consistent_with_mapping')),
  review_reason text,
  created_at timestamptz not null default now(),
  constraint ii_scheme_declared_benchmark_versions_unique_no unique (instrument_id, version_no),
  constraint ii_scheme_declared_benchmark_versions_ai_model check (extraction_method = 'text_pattern' or ai_model is not null or extraction_method = 'manual')
);
create index if not exists idx_ii_scheme_declared_versions_instrument on ii_scheme_declared_benchmark_versions (instrument_id, version_no desc);
create index if not exists idx_ii_scheme_declared_versions_review on ii_scheme_declared_benchmark_versions (review_state, created_at desc);
alter table ii_scheme_declared_benchmark_versions enable row level security;
drop policy if exists "viewer read ii_scheme_declared_benchmark_versions" on ii_scheme_declared_benchmark_versions;
create policy "viewer read ii_scheme_declared_benchmark_versions" on ii_scheme_declared_benchmark_versions for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_scheme_declared_benchmark_versions from anon, authenticated;
drop trigger if exists trg_ii_scheme_declared_versions_no_change on ii_scheme_declared_benchmark_versions;
create trigger trg_ii_scheme_declared_versions_no_change before update or delete on ii_scheme_declared_benchmark_versions for each row execute function ii_factsheet_append_only();
drop trigger if exists trg_ii_scheme_declared_versions_no_truncate on ii_scheme_declared_benchmark_versions;
create trigger trg_ii_scheme_declared_versions_no_truncate before truncate on ii_scheme_declared_benchmark_versions for each statement execute function ii_factsheet_append_only();
comment on table ii_scheme_declared_benchmark_versions is 'BENCH-1 (0252): append-only history of the benchmark a fund house DECLARES for a scheme (facts only: names, composition, source, checksum, method, confidence). A change is a NEW version; no row is ever edited or deleted.';

-- ===========================================================================
-- 4. Version events (APPEND-ONLY)
-- ===========================================================================
create table if not exists ii_factsheet_version_events (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references ii_scheme_declared_benchmark_versions(id),
  event_type text not null check (event_type in ('proposal_created', 'auto_published', 'auto_publish_refused', 'approved', 'rejected', 'manual_entry', 'acknowledged')),
  proposal_id uuid references ii_benchmark_mapping_proposals(id),
  mapping_id uuid references ii_instrument_benchmarks(id),
  actor_user_id uuid,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ii_factsheet_version_events_version on ii_factsheet_version_events (version_id, created_at);
alter table ii_factsheet_version_events enable row level security;
drop policy if exists "viewer read ii_factsheet_version_events" on ii_factsheet_version_events;
create policy "viewer read ii_factsheet_version_events" on ii_factsheet_version_events for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_factsheet_version_events from anon, authenticated;
drop trigger if exists trg_ii_factsheet_version_events_no_change on ii_factsheet_version_events;
create trigger trg_ii_factsheet_version_events_no_change before update or delete on ii_factsheet_version_events for each row execute function ii_factsheet_append_only();
drop trigger if exists trg_ii_factsheet_version_events_no_truncate on ii_factsheet_version_events;
create trigger trg_ii_factsheet_version_events_no_truncate before truncate on ii_factsheet_version_events for each statement execute function ii_factsheet_append_only();

-- ===========================================================================
-- 5. Attempt ledger (APPEND-ONLY) and the idempotency guard
-- ===========================================================================
create table if not exists ii_factsheet_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  run_month date not null check (extract(day from run_month) = 1),
  source_id uuid not null references ii_factsheet_sources(id),
  instrument_id uuid not null references ii_instruments(id),
  attempted_at timestamptz not null,
  outcome text not null check (outcome in (
    'refused_terms_not_approved', 'refused_robots', 'document_too_large', 'source_blocked', 'fetch_failed', 'text_extraction_failed',
    'scheme_not_in_document', 'benchmark_not_found', 'extraction_ambiguous', 'ai_rejected', 'older_document_ignored',
    'recorded_first_observation', 'confirmed_unchanged', 'recorded_change', 'recorded_additional_change', 'auto_published', 'error')),
  detail text check (detail is null or length(detail) <= 500),
  http_status integer,
  bytes bigint,
  document_checksum text,
  document_date date,
  version_id uuid references ii_scheme_declared_benchmark_versions(id),
  review_required boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_ii_factsheet_attempts_instrument on ii_factsheet_attempts (instrument_id, attempted_at desc);
create index if not exists idx_ii_factsheet_attempts_month on ii_factsheet_attempts (run_month, source_id);
-- IDEMPOTENT MONTH: a scheme has at most ONE terminal result per source per month, whatever number of runs happen.
create unique index if not exists uq_ii_factsheet_attempts_terminal on ii_factsheet_attempts (source_id, instrument_id, run_month)
  where outcome in ('refused_robots', 'document_too_large', 'source_blocked', 'text_extraction_failed', 'scheme_not_in_document', 'benchmark_not_found', 'extraction_ambiguous',
                    'ai_rejected', 'older_document_ignored', 'recorded_first_observation', 'confirmed_unchanged', 'recorded_change', 'recorded_additional_change', 'auto_published');
alter table ii_factsheet_attempts enable row level security;
drop policy if exists "viewer read ii_factsheet_attempts" on ii_factsheet_attempts;
create policy "viewer read ii_factsheet_attempts" on ii_factsheet_attempts for select using (is_benchmark_data_viewer());
revoke insert, update, delete, truncate on ii_factsheet_attempts from anon, authenticated;
drop trigger if exists trg_ii_factsheet_attempts_no_change on ii_factsheet_attempts;
create trigger trg_ii_factsheet_attempts_no_change before update or delete on ii_factsheet_attempts for each row execute function ii_factsheet_append_only();
drop trigger if exists trg_ii_factsheet_attempts_no_truncate on ii_factsheet_attempts;
create trigger trg_ii_factsheet_attempts_no_truncate before truncate on ii_factsheet_attempts for each statement execute function ii_factsheet_append_only();

-- ===========================================================================
-- 6. Job writers (service role only; the append-only and stale-state rules are re-checked INSIDE the database)
-- ===========================================================================
-- Held instruments, identity only: no user id, count, account, folio, unit or amount. HELD = at least one
-- transaction that is neither 'reversed' nor 'review_required' (the same rule as benchmark_held_schemes(), 0251).
create or replace function factsheet_reader_held_instruments()
returns table (instrument_id uuid, instrument_name text, amc_name text, amfi_scheme_code text)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'factsheet reader: service role only' using errcode = '42501';
  end if;
  return query
  select i.id, i.instrument_name::text,
         coalesce(nullif(btrim(m.amc_name), ''), nullif(btrim(i.amc_name), ''))::text,
         m.amfi_scheme_code::text
    from public.ii_instruments i
    left join lateral (
      select sm.amc_name, sm.amfi_scheme_code from public.ii_scheme_master sm
       where sm.instrument_id = i.id and sm.effective_to is null order by sm.effective_from desc limit 1
    ) m on true
   where exists (select 1 from public.ii_transactions t where t.instrument_id = i.id and coalesce(t.status, '') not in ('reversed', 'review_required'))
   order by i.instrument_name, i.id;
end $$;
revoke all on function factsheet_reader_held_instruments() from public, anon, authenticated;
grant execute on function factsheet_reader_held_instruments() to service_role;

create or replace function record_factsheet_attempt(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'factsheet reader: service role only' using errcode = '42501'; end if;
  insert into public.ii_factsheet_attempts (run_id, run_month, source_id, instrument_id, attempted_at, outcome, detail, http_status, bytes, document_checksum, document_date, version_id, review_required)
  values ((p ->> 'run_id')::uuid, (p ->> 'run_month')::date, (p ->> 'source_id')::uuid, (p ->> 'instrument_id')::uuid, (p ->> 'attempted_at')::timestamptz, p ->> 'outcome',
          left(p ->> 'detail', 500), nullif(p ->> 'http_status', '')::integer, nullif(p ->> 'bytes', '')::bigint, nullif(p ->> 'document_checksum', ''), nullif(p ->> 'document_date', '')::date,
          nullif(p ->> 'version_id', '')::uuid, coalesce((p ->> 'review_required')::boolean, false))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function record_factsheet_attempt(jsonb) from public, anon, authenticated;
grant execute on function record_factsheet_attempt(jsonb) to service_role;

-- Appends a version. The caller states which version it believes is current; if anything else was recorded in the
-- meantime the write is REFUSED (serialization failure), so two overlapping runs can never both append "v2".
create or replace function record_factsheet_version(p jsonb, p_expected_previous uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_instr uuid := (p ->> 'instrument_id')::uuid; v_latest uuid; v_no integer; v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'factsheet reader: service role only' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('factsheet_version:' || v_instr::text, 0));
  select v.id, v.version_no into v_latest, v_no from public.ii_scheme_declared_benchmark_versions v where v.instrument_id = v_instr order by v.version_no desc limit 1;
  if v_latest is distinct from p_expected_previous then
    raise exception 'factsheet reader: the current version changed since it was read (expected %, found %)', p_expected_previous, v_latest using errcode = '40001';
  end if;
  insert into public.ii_scheme_declared_benchmark_versions (instrument_id, version_no, supersedes_version_id, tier1_name, tier1_variant_hint, additional_names, benchmark_kind, composition, catalogue_state,
      matched_benchmark_id, match_confidence, effective_from, effective_from_basis, source_id, source_url, source_title, source_document_type, document_date, document_date_precision, document_month,
      retrieved_at, document_checksum, extraction_method, extractor_version, ai_model, extraction_confidence, extractors_agree, evidence_excerpt, review_state, review_reason)
  values (v_instr, coalesce(v_no, 0) + 1, v_latest, p ->> 'tier1_name', nullif(p ->> 'tier1_variant_hint', ''),
      coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'additional_names', '[]'::jsonb))), '{}'), p ->> 'benchmark_kind', coalesce(p -> 'composition', '[]'::jsonb), p ->> 'catalogue_state',
      nullif(p ->> 'matched_benchmark_id', '')::uuid, nullif(p ->> 'match_confidence', ''), (p ->> 'effective_from')::date, p ->> 'effective_from_basis', (p ->> 'source_id')::uuid, p ->> 'source_url',
      nullif(p ->> 'source_title', ''), p ->> 'source_document_type', nullif(p ->> 'document_date', '')::date, nullif(p ->> 'document_date_precision', ''), (p ->> 'document_month')::date,
      (p ->> 'retrieved_at')::timestamptz, p ->> 'document_checksum', p ->> 'extraction_method', p ->> 'extractor_version', nullif(p ->> 'ai_model', ''), p ->> 'extraction_confidence',
      nullif(p ->> 'extractors_agree', '')::boolean, left(p ->> 'evidence_excerpt', 400), p ->> 'review_state', nullif(p ->> 'review_reason', ''))
  returning id into v_id;
  perform public.ii_bm_log_event('factsheet_version_recorded', 'ii_scheme_declared_benchmark_versions', v_id, null,
    jsonb_build_object('instrument_id', v_instr, 'version_no', coalesce(v_no, 0) + 1, 'benchmark_kind', p ->> 'benchmark_kind', 'catalogue_state', p ->> 'catalogue_state', 'review_state', p ->> 'review_state'), null);
  return v_id;
end $$;
revoke all on function record_factsheet_version(jsonb, uuid) from public, anon, authenticated;
grant execute on function record_factsheet_version(jsonb, uuid) to service_role;

create or replace function record_factsheet_version_event(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'factsheet reader: service role only' using errcode = '42501'; end if;
  insert into public.ii_factsheet_version_events (version_id, event_type, proposal_id, mapping_id, actor_user_id, note)
  values ((p ->> 'version_id')::uuid, p ->> 'event_type', nullif(p ->> 'proposal_id', '')::uuid, nullif(p ->> 'mapping_id', '')::uuid, null, left(p ->> 'note', 500))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function record_factsheet_version_event(jsonb) from public, anon, authenticated;
grant execute on function record_factsheet_version_event(jsonb) to service_role;

create or replace function touch_factsheet_source(p_source uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'factsheet reader: service role only' using errcode = '42501'; end if;
  update public.ii_factsheet_sources
     set last_etag = nullif(p ->> 'etag', ''), last_modified = nullif(p ->> 'last_modified', ''), last_checksum = nullif(p ->> 'checksum', ''),
         last_fetched_at = nullif(p ->> 'fetched_at', '')::timestamptz, updated_at = now()
   where id = p_source;
end $$;
revoke all on function touch_factsheet_source(uuid, jsonb) from public, anon, authenticated;
grant execute on function touch_factsheet_source(uuid, jsonb) to service_role;

-- ===========================================================================
-- 7. Admin: review a queued change (catalogue capability) - uses the EXISTING review path
-- ===========================================================================
-- approve      creates the effective-dated mapping through review_benchmark_mapping() (which re-checks the capability,
--              the verified catalogue entry and the no-overlap rule). A benchmark CHANGE needs p_close_previous = true.
-- reject       declines the proposal; the version stays on record (history is never edited).
-- manual       the reviewer entered the mapping by hand instead; the factsheet-created proposal (if any) is declined.
-- acknowledge  for a declared benchmark the catalogue cannot represent (composite, commodity price, index not held):
--              no mapping can exist. With p_close_previous the scheme's open primary mapping is closed the day before
--              the new benchmark took effect, so the earlier benchmark stays in force only for the earlier portion.
create or replace function review_factsheet_change(p_version uuid, p_decision text, p_note text, p_close_previous boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  ver public.ii_scheme_declared_benchmark_versions%rowtype;
  v_proposal uuid;
  v_mapping uuid;
  prev record;
begin
  if v_uid is null or not public.is_benchmark_catalogue_admin() then raise exception 'factsheet review: catalogue admin capability required' using errcode = '42501'; end if;
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'factsheet review: a review note of at least 10 characters is required' using errcode = '22023'; end if;
  if p_decision not in ('approve', 'reject', 'manual', 'acknowledge') then raise exception 'factsheet review: decision must be approve, reject, manual or acknowledge' using errcode = '22023'; end if;
  select * into ver from public.ii_scheme_declared_benchmark_versions where id = p_version;
  if not found then raise exception 'factsheet review: version not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.ii_factsheet_version_events e where e.version_id = p_version and e.event_type in ('auto_published', 'approved', 'rejected', 'manual_entry', 'acknowledged')) then
    raise exception 'factsheet review: this item has already been decided' using errcode = '55000';
  end if;
  select e.proposal_id into v_proposal from public.ii_factsheet_version_events e where e.version_id = p_version and e.proposal_id is not null order by e.created_at desc limit 1;

  if p_decision = 'approve' then
    if v_proposal is null then raise exception 'factsheet review: there is no mapping proposal to approve (use acknowledge, or enter the mapping manually)' using errcode = '22023'; end if;
    v_mapping := public.review_benchmark_mapping(v_proposal, 'approve', p_note, coalesce(p_close_previous, false));
    insert into public.ii_factsheet_version_events (version_id, event_type, proposal_id, mapping_id, actor_user_id, note) values (p_version, 'approved', v_proposal, v_mapping, v_uid, left(p_note, 500));
  elsif p_decision in ('reject', 'manual') then
    if v_proposal is not null and exists (select 1 from public.ii_benchmark_mapping_proposals where id = v_proposal and status = 'proposed') then
      perform public.review_benchmark_mapping(v_proposal, 'reject', case when p_decision = 'manual' then 'Handled by manual entry: ' || p_note else p_note end, false);
    end if;
    insert into public.ii_factsheet_version_events (version_id, event_type, proposal_id, actor_user_id, note) values (p_version, case when p_decision = 'manual' then 'manual_entry' else 'rejected' end, v_proposal, v_uid, left(p_note, 500));
  else
    if coalesce(p_close_previous, false) then
      for prev in select * from public.ii_instrument_benchmarks o
                   where o.instrument_id = ver.instrument_id and o.relationship_type = 'primary' and o.quality_status is distinct from 'superseded'
                     and o.effective_to is null and o.effective_from < ver.effective_from loop
        update public.ii_instrument_benchmarks set effective_to = ver.effective_from - 1 where id = prev.id;
        perform public.ii_bm_log_event('mapping_closed', 'ii_instrument_benchmarks', prev.id, to_jsonb(prev), jsonb_build_object('effective_to', ver.effective_from - 1), p_note);
      end loop;
    end if;
    insert into public.ii_factsheet_version_events (version_id, event_type, actor_user_id, note) values (p_version, 'acknowledged', v_uid, left(p_note, 500));
  end if;
  perform public.ii_bm_log_event('factsheet_change_reviewed', 'ii_scheme_declared_benchmark_versions', p_version, null, jsonb_build_object('decision', p_decision, 'proposal_id', v_proposal, 'mapping_id', v_mapping), p_note);
  return jsonb_build_object('decision', p_decision, 'mapping_id', v_mapping);
end $$;
revoke all on function review_factsheet_change(uuid, text, text, boolean) from public, anon;
grant execute on function review_factsheet_change(uuid, text, text, boolean) to authenticated;

-- ===========================================================================
-- 8. Admin: the terms-review status of a source (entitlement-approver capability)
-- ===========================================================================
create or replace function set_factsheet_source_terms_status(p_source uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); old public.ii_factsheet_sources%rowtype;
begin
  if v_uid is null or not public.is_benchmark_entitlement_approver() then raise exception 'factsheet source terms: entitlement approver capability required' using errcode = '42501'; end if;
  if p_status not in ('not_reviewed', 'under_review', 'approved', 'declined') then raise exception 'factsheet source terms: invalid status' using errcode = '22023'; end if;
  if p_note is null or length(trim(p_note)) < 10 then raise exception 'factsheet source terms: a note of at least 10 characters is required (record who reviewed which terms, and when)' using errcode = '22023'; end if;
  select * into old from public.ii_factsheet_sources where id = p_source;
  if not found then raise exception 'factsheet source terms: source not found' using errcode = 'P0002'; end if;
  update public.ii_factsheet_sources
     set terms_review_status = p_status, terms_reviewed_by = v_uid, terms_reviewed_at = now(), terms_review_note = p_note, updated_at = now()
   where id = p_source;
  perform public.ii_bm_log_event('factsheet_source_terms_status_set', 'ii_factsheet_sources', p_source, jsonb_build_object('terms_review_status', old.terms_review_status), jsonb_build_object('terms_review_status', p_status), p_note);
end $$;
revoke all on function set_factsheet_source_terms_status(uuid, text, text) from public, anon;
grant execute on function set_factsheet_source_terms_status(uuid, text, text) to authenticated;

-- ===========================================================================
-- 9. End-user comparison surfaces: "a declared record exists that the data we hold cannot represent"
-- ===========================================================================
-- Public fund facts only (a benchmark NAME the fund house states), keyed by instrument id: no user, holding or
-- amount. Used so a scheme with such a record is NEVER compared with its category benchmark.
-- Returns a row only for the instrument's LATEST version that was not rejected, and only when its catalogue state
-- leaves it not comparable (or awaiting review). Approved / auto-published versions are not returned: they have a
-- mapping, and the mapping path applies. The state list mirrors lib/.../declaredRecordStatus.ts (a test compares them).
create or replace function declared_benchmark_records_for(p_instrument_ids uuid[])
returns table (instrument_id uuid, declared_name text, benchmark_kind text, catalogue_state text)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'declared benchmark records: sign-in required' using errcode = '42501'; end if;
  if p_instrument_ids is null then return; end if;
  if cardinality(p_instrument_ids) > 500 then raise exception 'declared benchmark records: at most 500 instruments per call' using errcode = '22023'; end if;
  return query
  select x.instrument_id, x.tier1_name::text, x.benchmark_kind::text, x.catalogue_state::text
    from (
      select distinct on (v.instrument_id) v.id, v.instrument_id, v.tier1_name, v.benchmark_kind, v.catalogue_state
        from public.ii_scheme_declared_benchmark_versions v
       where v.instrument_id = any (p_instrument_ids)
         and not exists (select 1 from public.ii_factsheet_version_events e where e.version_id = v.id and e.event_type = 'rejected')
       order by v.instrument_id, v.version_no desc
    ) x
   where x.catalogue_state in ('unsupported_composite', 'unsupported_commodity', 'no_catalogue_match', 'matched_other')
     and not exists (select 1 from public.ii_factsheet_version_events e where e.version_id = x.id and e.event_type in ('approved', 'auto_published'));
end $$;
revoke all on function declared_benchmark_records_for(uuid[]) from public, anon;
grant execute on function declared_benchmark_records_for(uuid[]) to authenticated;

-- ===========================================================================
-- 10. Kill switch (SHIPPED OFF; no pg_cron schedule is created here)
-- ===========================================================================
insert into ii_reference_job_control (job_key, enabled, disabled_reason)
select 'factsheet_benchmark_reader', false,
  'Shipped disabled by migration 0252 (BENCH-1 factsheet benchmark reader). Enabling is a deliberate, human-present step AFTER the fund-house terms question is settled and at least one source row has terms_review_status = approved. A dry run (dryRun: true) is always safe: it fetches nothing and writes nothing.'
where not exists (select 1 from ii_reference_job_control where job_key = 'factsheet_benchmark_reader');
