-- Investment Intelligence R2 — Migration A: audit-event vocabulary
-- extension, source-document lifecycle extension (source detection +
-- password/reconciliation states), and the parser-run lineage table.
--
-- Additive only. No existing column, constraint, index, or row is removed.
-- Every ALTER on an existing check constraint drops and recreates it with a
-- STRICT SUPERSET of the previously-allowed values (verified below) — no
-- previously-valid row can become invalid.
--
-- Governing docs: R2_PARSER_ARCHITECTURE.md, R0_AUDIT_REQUIREMENTS.md
-- section 2 (frozen R1 vocabulary), spec sections 9, 12, 33.

-- ---------------------------------------------------------------------------
-- ii_audit_events.event_type — extend the R1-frozen 19-value check
-- constraint (migration 0036) with the R2 event types spec section 33
-- requires. R1's 19 values are reproduced verbatim below (nothing removed)
-- plus 14 new R2 values ('parse_completed' and 'user_correction' already
-- existed in R1 and are not duplicated).
-- ---------------------------------------------------------------------------
alter table ii_audit_events drop constraint ii_audit_events_event_type_check;
alter table ii_audit_events add constraint ii_audit_events_event_type_check check (event_type in (
  -- R1 (migration 0036) — unchanged, verbatim
  'upload', 'parse', 'parse_completed', 'reconciliation_opened', 'reconciliation_resolved',
  'user_correction', 'admin_correction', 'publication', 'republishing', 'nav_price_update',
  'calculation', 'rule_change', 'goal_allocation', 'export', 'permission_grant',
  'permission_revoke', 'professional_access', 'archive', 'deletion',
  -- R2 (spec section 33) — new
  'document_uploaded', 'source_detected', 'parse_started', 'parse_failed',
  'parser_version_used', 'account_resolved', 'instrument_resolved',
  'reconciliation_case_created', 'reconciliation_case_resolved',
  'portfolio_certified', 'portfolio_certified_with_warnings', 'portfolio_failed',
  'document_superseded', 'document_processing_failed'
));

-- ---------------------------------------------------------------------------
-- ii_source_documents.status — extend the R1-frozen 6-value lifecycle
-- (migration 0032) with the 3 additional terminal/interim states R2's
-- source-detection and password-handling pipeline needs (spec sections 10,
-- 12): 'password_required' (encrypted, no usable password on file yet),
-- 'reconciliation_required' (source/owner could not be confidently
-- resolved), 'unsupported' (a real document, safely read, but not a
-- supported CAS format — never silently treated as parsed).
-- ---------------------------------------------------------------------------
alter table ii_source_documents drop constraint ii_source_documents_status_check;
alter table ii_source_documents add constraint ii_source_documents_status_check check (status in (
  'uploaded', 'parsing', 'parsed', 'parse_failed', 'superseded', 'archived',
  'password_required', 'reconciliation_required', 'unsupported'
));

-- New columns: source-detection outcome fields (spec section 12) recorded
-- directly on the document row since there is exactly one "current"
-- detection outcome per document (history of detection attempts, if a
-- document is reprocessed, lives on ii_document_parse_runs below).
alter table ii_source_documents add column source_detected text;
alter table ii_source_documents add column source_confidence numeric(5, 4) check (source_confidence is null or (source_confidence >= 0 and source_confidence <= 1));
alter table ii_source_documents add column document_type_detected text;
alter table ii_source_documents add column format_version_detected text;
alter table ii_source_documents add column extraction_method text; -- 'pdf_text_native' | 'csv' | 'manual' | etc — never 'external_ocr_api' (spec section 11)

comment on column ii_source_documents.source_detected is 'ii_sources.source_key detected from document EVIDENCE (headings/RTA name/structure), never trusted from filename alone — spec section 12.';
comment on column ii_source_documents.extraction_method is 'How text was obtained from the document. Must never be a third-party AI/OCR API call (spec section 11) — enforced by code review, not a DB constraint, since the column is descriptive metadata.';

-- ---------------------------------------------------------------------------
-- ii_document_parse_runs — one row per processing ATTEMPT (not overwritten
-- on retry), the parser-lineage table spec section 9 requires ("a future
-- parser upgrade must not make old results untraceable" / "which parser
-- version produced this canonical transaction"). ii_source_documents carries
-- only the CURRENT/latest parser_version (R1 column, unchanged); this table
-- is the full history, including failed attempts, so reprocessing with an
-- upgraded parser never silently erases how earlier canonical rows were
-- produced (spec section 52).
-- ---------------------------------------------------------------------------
create table ii_document_parse_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_document_id uuid not null references ii_source_documents(id) on delete cascade,
  parser_code text not null,
  parser_version text not null,
  run_status text not null default 'queued' check (run_status in ('queued', 'running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  source_detected text,
  source_confidence numeric(5, 4) check (source_confidence is null or (source_confidence >= 0 and source_confidence <= 1)),
  document_type_detected text,
  format_version_detected text,
  extraction_method text,
  accounts_found int not null default 0,
  schemes_found int not null default 0,
  transactions_found int not null default 0,
  holdings_found int not null default 0,
  warnings jsonb not null default '[]'::jsonb, -- array of {code, message, severity}
  errors jsonb not null default '[]'::jsonb,
  -- The password itself is NEVER a column on this table or any table
  -- (spec section 10, critical failure condition list) — only whether one
  -- was required/supplied, never the value.
  password_required boolean not null default false,
  password_supplied boolean not null default false,
  idempotency_key text not null, -- deterministic: source_document_id + parser_version + attempt salt, computed application-side
  created_at timestamptz not null default now()
);
create index idx_ii_document_parse_runs_user on ii_document_parse_runs(user_id);
create index idx_ii_document_parse_runs_document on ii_document_parse_runs(source_document_id, started_at desc);
-- Idempotency (spec section 52): at most ONE in-flight (queued/running) run
-- per document at a time — repeatedly clicking "Process" while a run is
-- already active cannot create a second concurrent run. Completed/failed
-- runs are retry history and are NOT constrained by this index (a retry
-- after failure, or a reprocess with an upgraded parser_version, is a new
-- row by design).
create unique index uidx_ii_document_parse_runs_one_active
  on ii_document_parse_runs(source_document_id)
  where run_status in ('queued', 'running');

alter table ii_document_parse_runs enable row level security;
create policy "own ii_document_parse_runs" on ii_document_parse_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- ii_sources.parser_available — R1 seeded this false for every row because
-- no parser existed. R2 ships real CAMS and KFintech parsers, so flip
-- exactly those two rows to true. Data update only, no schema change,
-- reversible, does not affect any other row.
-- ---------------------------------------------------------------------------
update ii_sources set parser_available = true where source_key in ('cams', 'kfintech');
