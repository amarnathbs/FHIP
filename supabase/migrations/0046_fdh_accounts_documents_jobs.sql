-- =============================================================================
-- Financial Data Hub (FDH) — FDH-1 Migration B (0046): user-owned account, document
-- and ingestion-job foundation.
-- =============================================================================
-- TENANCY. FDH-0 verified (docs/financial-data-hub/FDH0_RLS_BASELINE.md §5.1,
-- FDH0_IMPLEMENTATION_READINESS_REPORT.md Q7) that every one of the 77
-- existing tables keys on `user_id uuid references auth.users(id)`, that
-- `households` is itself a user_id-owned descriptor row, and that no
-- cross-user or shared-household read path exists anywhere in the schema.
-- FDH therefore inherits `user_id` as the tenancy boundary and does NOT
-- invent a parallel identity system.
--
-- `household_id` is carried as OPTIONAL, NULLABLE, non-authoritative context
-- so that a future household-sharing model (if the Product Owner ever
-- introduces one) has an attachment point. It is deliberately NOT part of any
-- RLS predicate: making it one today would be a security change to a model
-- that does not exist yet.
--
-- RLS. The standard owner-only expression is used verbatim:
--   for all using (auth.uid() = user_id) with check (auth.uid() = user_id)
-- first defined at supabase/migrations/0001_foundation.sql:93-100 and applied
-- identically to 45 existing tables. The `with check` half is what prevents
-- tenant spoofing on INSERT/UPDATE (a user cannot write a row carrying
-- someone else's user_id).
--
-- Child tables carry `user_id` explicitly rather than resolving ownership
-- through a join, per FDH0_IMPLEMENTATION_READINESS_REPORT.md Q8.
--
-- ADMIN DOCUMENT ACCESS (Product Owner Decision 3). No storage bucket, no
-- upload path, no signed URL and no admin route is created anywhere in FDH-1.
-- fdh_statement_uploads stores METADATA ONLY — it never holds document
-- content. The operational-metadata-only projection an admin may ever see is
-- defined as a code-level allowlist in
-- lib/financial-data-hub/constants/adminBoundary.ts and is enforced by test.
-- See docs/financial-data-hub/FDH1_RLS_SECURITY.md §5.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_financial_accounts — a source account a document belongs to.
--
-- SENSITIVE-IDENTIFIER POLICY. There is deliberately NO full_account_number
-- column. Only `masked_identifier` (display) and `account_fingerprint`
-- (matching) exist.
--
--   * masked_identifier is guarded by a check constraint that rejects any run
--     of 7 or more consecutive digits. An AU BSB+account (6+9 digits) and an
--     Indian account number (11-18 digits) cannot pass; "****1234" and
--     "XXXX-4321" can. This is a real database-level control, not a comment.
--
--   * account_fingerprint is reserved for a future NON-REVERSIBLE
--     deterministic identifier (keyed hash of the normalised account number).
--     FDH-1 does NOT implement key management or HMAC infrastructure and does
--     NOT populate this column — no such infrastructure exists in this
--     repository today. The requirement is recorded in
--     docs/financial-data-hub/FDH1_PRIVACY_DATA_LIFECYCLE.md §3.
--
-- Any genuine temporary need for a full identifier during parsing belongs to
-- FDH-3's secure processing lifecycle, not to a persisted column here.
--
-- INVESTMENT BOUNDARY. The `*_source` account types (brokerage_source,
-- super_source, epf_source, nps_source) describe WHERE A DOCUMENT CAME FROM.
-- They are not canonical investment accounts. Investment Intelligence owns
-- ii_accounts, ii_instruments, ii_transactions, ii_holding_snapshots and
-- ii_prices_nav. FDH creates no holdings, no securities, no valuations and no
-- investment ledger. See FDH1_INVESTMENT_BOUNDARY.md.
-- ---------------------------------------------------------------------------
create table fdh_financial_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  institution_id uuid references fdh_financial_institutions(id) on delete restrict,
  account_type text not null
    check (account_type in (
      'transaction', 'savings', 'term_deposit', 'credit_card', 'home_loan',
      'personal_loan', 'vehicle_loan', 'brokerage_source', 'super_source',
      'epf_source', 'nps_source', 'other'
    )),
  country_code char(2) not null references countries(country_code) on delete restrict,
  currency_code char(3) not null references currencies(currency_code) on delete restrict,
  display_name text not null,
  masked_identifier text,
  account_fingerprint text,
  status text not null default 'active'
    check (status in ('active', 'dormant', 'closed', 'archived')),
  opened_at date,
  closed_at date,
  last_statement_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fdh_accounts_dates
    check (closed_at is null or opened_at is null or closed_at >= opened_at),
  -- No plaintext full account number may be persisted, even accidentally.
  constraint chk_fdh_accounts_masked_identifier
    check (masked_identifier is null or masked_identifier !~ '[0-9]{7,}')
);
create index idx_fdh_accounts_user on fdh_financial_accounts(user_id);
create index idx_fdh_accounts_user_institution
  on fdh_financial_accounts(user_id, institution_id);
-- One fingerprint identifies one account for one user. Partial, because the
-- column is unpopulated in FDH-1 and NULLs must not collide.
create unique index uq_fdh_accounts_fingerprint
  on fdh_financial_accounts(user_id, account_fingerprint)
  where account_fingerprint is not null;

alter table fdh_financial_accounts enable row level security;
create policy "own rows - fdh_financial_accounts" on fdh_financial_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_statement_uploads — metadata for one financial document / import.
--
-- METADATA ONLY. This table holds no document bytes, no page images, no OCR
-- artefacts and no extracted narrative. `raw_document_storage_reference` is a
-- nullable pointer whose storage backend does not exist yet (FDH-3).
--
-- PRIVACY LIFECYCLE. Two check constraints make the purge contract real
-- rather than aspirational:
--   chk_fdh_uploads_purged_reference — once purge_status = 'purged', the
--     storage reference MUST be null. The row cannot claim to be purged while
--     still pointing at a document.
--   chk_fdh_uploads_purged_at — purged_at may only be set in the purged state.
-- Every raw/purgeable column here is nullable; nothing constrains the schema
-- in a way that would make deletion impossible.
--
-- LEGAL_HOLD is a valid purge state but is structural only: FDH-1 builds no
-- admin UI and no service that can set it.
-- ---------------------------------------------------------------------------
create table fdh_statement_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  -- Nullable: the account is not known until the document has been classified.
  financial_account_id uuid references fdh_financial_accounts(id) on delete set null,
  institution_id uuid references fdh_financial_institutions(id) on delete restrict,
  source_type text not null references fdh_source_types(source_type_key) on delete restrict,
  -- Nullable: unknown until document classification succeeds.
  document_type text
    check (document_type is null or document_type in (
      'bank_statement', 'credit_card_statement', 'loan_statement', 'payslip',
      'investment_statement', 'super_statement', 'epf_statement',
      'nps_statement', 'tax_document', 'other'
    )),
  country_code char(2) references countries(country_code) on delete restrict,
  currency_code char(3) references currencies(currency_code) on delete restrict,
  -- Sanitised at the boundary (path components and control characters
  -- stripped). Purgeable — see FDH1_PRIVACY_DATA_LIFECYCLE.md §4.
  original_filename_sanitised text,
  file_hash text,                        -- sha-256 hex; enables duplicate-file detection
  mime_type text,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes > 0),
  statement_period_start date,
  statement_period_end date,
  statement_as_of_date date,
  processing_status text not null default 'created'
    check (processing_status in (
      'created', 'uploaded', 'validating', 'queued', 'processing', 'extracted',
      'review_required', 'ready_for_approval', 'approved', 'rejected',
      'failed', 'purge_pending', 'purged'
    )),
  review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'in_review', 'resolved')),
  parser_id uuid references fdh_parser_registry(id) on delete restrict,
  parser_version_id uuid references fdh_parser_versions(id) on delete restrict,
  processing_method text
    check (processing_method is null or processing_method in (
      'native_text', 'ocr', 'csv_parse', 'xlsx_parse', 'manual_mapping', 'connected_feed'
    )),
  reconciliation_status text not null default 'not_available'
    check (reconciliation_status in (
      'not_available', 'pending', 'reconciled', 'failed', 'user_accepted_exception'
    )),
  overall_quality_status text not null default 'not_assessed'
    check (overall_quality_status in ('not_assessed', 'pass', 'warning', 'fail')),
  -- Controlled taxonomy. Never a stack trace, never an internal message.
  error_code text
    check (error_code is null or error_code in (
      'unsupported_file_type', 'file_corrupt', 'password_required',
      'password_invalid', 'institution_not_identified',
      'document_type_not_identified', 'parser_not_found', 'layout_unsupported',
      'extraction_failed', 'reconciliation_failed', 'data_validation_failed',
      'malware_detected', 'privacy_purge_failed', 'internal_error'
    )),
  raw_document_storage_reference text,
  raw_document_purge_status text not null default 'not_required'
    check (raw_document_purge_status in (
      'not_required', 'pending', 'in_progress', 'purged', 'failed', 'legal_hold'
    )),
  raw_document_purge_due_at timestamptz,
  raw_document_purged_at timestamptz,
  purge_reason text,
  purge_attempt_count int not null default 0 check (purge_attempt_count >= 0),
  last_purge_error_sanitised text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  constraint chk_fdh_uploads_period
    check (statement_period_end is null or statement_period_start is null
           or statement_period_end >= statement_period_start),
  constraint chk_fdh_uploads_purged_reference
    check (raw_document_purge_status <> 'purged' or raw_document_storage_reference is null),
  constraint chk_fdh_uploads_purged_at
    check (raw_document_purged_at is null or raw_document_purge_status = 'purged'),
  constraint chk_fdh_uploads_approved_at
    check (approved_at is null or processing_status in
           ('approved', 'purge_pending', 'purged'))
);
create index idx_fdh_uploads_user on fdh_statement_uploads(user_id);
create index idx_fdh_uploads_user_status
  on fdh_statement_uploads(user_id, processing_status);
create index idx_fdh_uploads_account on fdh_statement_uploads(financial_account_id);
create index idx_fdh_uploads_parser_version
  on fdh_statement_uploads(parser_id, parser_version_id);
-- Purge sweeps run over due, unpurged documents. Partial keeps it small.
create index idx_fdh_uploads_purge_due
  on fdh_statement_uploads(raw_document_purge_due_at)
  where raw_document_purge_status in ('pending', 'in_progress', 'failed');
-- The same file uploaded twice by the same user is a duplicate, not a new
-- document. Partial because file_hash is null until the file is hashed.
create unique index uq_fdh_uploads_user_file_hash
  on fdh_statement_uploads(user_id, file_hash) where file_hash is not null;

alter table fdh_statement_uploads enable row level security;
create policy "own rows - fdh_statement_uploads" on fdh_statement_uploads
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_ingestion_jobs — asynchronous job state. NO WORKER IS IMPLEMENTED IN
-- FDH-1; this is the state model a future worker will drive.
--
-- error_message_sanitised must never carry a stack trace or internal detail —
-- see the error taxonomy above and FDH1_STATE_MACHINES.md §5.
-- ---------------------------------------------------------------------------
create table fdh_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_upload_id uuid not null references fdh_statement_uploads(id) on delete cascade,
  job_type text not null
    check (job_type in (
      'document_validate', 'document_classify', 'document_extract',
      'document_reconcile', 'transaction_classify', 'duplicate_check',
      'transfer_match', 'summary_build', 'privacy_purge'
    )),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead_letter')),
  attempt int not null default 0 check (attempt >= 0),
  max_attempts int not null default 3 check (max_attempts >= 1),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text
    check (error_code is null or error_code in (
      'unsupported_file_type', 'file_corrupt', 'password_required',
      'password_invalid', 'institution_not_identified',
      'document_type_not_identified', 'parser_not_found', 'layout_unsupported',
      'extraction_failed', 'reconciliation_failed', 'data_validation_failed',
      'malware_detected', 'privacy_purge_failed', 'internal_error'
    )),
  error_message_sanitised text,
  worker_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_fdh_jobs_attempts check (attempt <= max_attempts),
  constraint chk_fdh_jobs_times
    check (completed_at is null or started_at is null or completed_at >= started_at)
);
create index idx_fdh_jobs_user on fdh_ingestion_jobs(user_id);
create index idx_fdh_jobs_upload on fdh_ingestion_jobs(statement_upload_id);
-- The claim query a future worker will run: oldest queued job of a type.
create index idx_fdh_jobs_queue on fdh_ingestion_jobs(job_type, created_at)
  where status = 'queued';

alter table fdh_ingestion_jobs enable row level security;
create policy "own rows - fdh_ingestion_jobs" on fdh_ingestion_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
