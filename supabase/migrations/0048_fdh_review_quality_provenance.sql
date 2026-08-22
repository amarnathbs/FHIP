-- =============================================================================
-- Financial Data Hub (FDH) — FDH-1 Migration D (0048): review queue, reconciliation,
-- data quality, provenance and evidence.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_review_items — the generic "a human needs to look at this" queue.
--
-- CONTEXT MUST NOT CARRY DOCUMENT TEXT. `title_code` is a message key
-- resolved to copy in the UI, never a sentence containing a merchant, an
-- amount or a narrative. `context_json` is a structured object holding
-- identifiers and codes (transaction ids, check codes, counts) — it must not
-- be used to stash raw financial-document text, because doing so would
-- re-create the very PII the purge lifecycle exists to remove. Enforced by
-- the Zod schema reviewItemContextSchema, which is a closed-shape object.
--
-- PERSISTENT ACROSS IMPORT SESSIONS. A `missing_counterpart_account` item
-- created when statement A was imported simply stays `open`. It is not tied
-- to a job, a session or a request. When statement B arrives weeks later a
-- future matching engine (FDH-6) can resolve it. Nothing here expires it.
-- ---------------------------------------------------------------------------
create table fdh_review_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  statement_upload_id uuid references fdh_statement_uploads(id) on delete cascade,
  transaction_id uuid references fdh_transactions(id) on delete cascade,
  review_type text not null
    check (review_type in (
      'low_extraction_confidence', 'low_classification_confidence',
      'unknown_merchant', 'possible_transfer', 'missing_counterpart_account',
      'possible_duplicate', 'reconciliation_failure', 'transaction_split',
      'income_evidence', 'other'
    )),
  severity text not null default 'info'
    check (severity in ('info', 'warning', 'blocking')),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved', 'dismissed', 'expired')),
  title_code text not null,
  context_json jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolution_code text,
  -- A review item must be about something.
  constraint chk_fdh_review_subject
    check (statement_upload_id is not null or transaction_id is not null),
  constraint chk_fdh_review_context_shape
    check (context_json is null or jsonb_typeof(context_json) = 'object'),
  constraint chk_fdh_review_resolved
    check (status not in ('resolved', 'dismissed') or resolved_at is not null)
);
create index idx_fdh_review_user_open on fdh_review_items(user_id, severity)
  where status in ('open', 'in_progress');
create index idx_fdh_review_upload on fdh_review_items(statement_upload_id);
create index idx_fdh_review_txn on fdh_review_items(transaction_id);
-- The retry query a future matching engine runs: still-open items of a type.
create index idx_fdh_review_type_open on fdh_review_items(review_type, user_id)
  where status = 'open';

alter table fdh_review_items enable row level security;
create policy "own rows - fdh_review_items" on fdh_review_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_reconciliation_results — did the extracted transactions actually add up
-- to the balance the statement itself reports?
--
-- NEVER SILENTLY PASS. The database refuses to record a 'reconciled' status
-- unless a variance was actually computed and falls within an explicitly
-- stored tolerance (chk_fdh_recon_reconciled). A non-zero variance can only
-- be recorded as 'failed' or as an explicit 'user_accepted_exception' — there
-- is no path by which a failed reconciliation can be stored as a success.
-- `variance_tolerance` defaults to 0 and must be set deliberately; it is not
-- a hidden fudge factor.
--
-- FDH-1 implements no reconciliation engine (FDH-4/FDH-5).
-- ---------------------------------------------------------------------------
create table fdh_reconciliation_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_upload_id uuid not null references fdh_statement_uploads(id) on delete cascade,
  opening_balance numeric(20,4),
  extracted_credits numeric(20,4)
    check (extracted_credits is null or extracted_credits >= 0),
  extracted_debits numeric(20,4)
    check (extracted_debits is null or extracted_debits >= 0),
  expected_closing_balance numeric(20,4),
  reported_closing_balance numeric(20,4),
  variance numeric(20,4),
  variance_tolerance numeric(20,4) not null default 0 check (variance_tolerance >= 0),
  currency_code char(3) references currencies(currency_code) on delete restrict,
  status text not null default 'pending'
    check (status in ('not_available', 'pending', 'reconciled', 'failed', 'user_accepted_exception')),
  reconciliation_method text
    check (reconciliation_method is null or reconciliation_method in
           ('balance_rollforward', 'transaction_count', 'none')),
  created_at timestamptz not null default now(),
  constraint chk_fdh_recon_reconciled
    check (status <> 'reconciled'
           or (variance is not null and abs(variance) <= variance_tolerance))
);
create index idx_fdh_recon_upload on fdh_reconciliation_results(statement_upload_id);
create index idx_fdh_recon_user on fdh_reconciliation_results(user_id, status);

alter table fdh_reconciliation_results enable row level security;
create policy "own rows - fdh_reconciliation_results" on fdh_reconciliation_results
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_data_quality_results — one row per (document, check). Together these
-- form the import-quality summary a future FDH-7 review screen will render.
--
-- `details_sanitised` carries a short operator-safe explanation, never a
-- stack trace and never verbatim document text.
-- ---------------------------------------------------------------------------
create table fdh_data_quality_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  statement_upload_id uuid not null references fdh_statement_uploads(id) on delete cascade,
  check_code text not null
    check (check_code in (
      'statement_period_found', 'account_identified', 'balance_reconciled',
      'transaction_count_valid', 'duplicate_file', 'low_extraction_confidence',
      'unsupported_layout', 'date_ambiguity', 'currency_ambiguity'
    )),
  status text not null check (status in ('pass', 'warning', 'fail', 'not_applicable')),
  score numeric(5,4) check (score is null or (score >= 0 and score <= 1)),
  details_sanitised text,
  created_at timestamptz not null default now(),
  constraint uq_fdh_quality_check unique (statement_upload_id, check_code)
);
create index idx_fdh_quality_user on fdh_data_quality_results(user_id);
create index idx_fdh_quality_failures
  on fdh_data_quality_results(statement_upload_id) where status in ('warning', 'fail');

alter table fdh_data_quality_results enable row level security;
create policy "own rows - fdh_data_quality_results" on fdh_data_quality_results
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_data_provenance — "where did this number come from?"
--
-- STANDALONE. Provenance is recorded about FDH entities only. It is not tied
-- to, and contains no reference to, the existing FHIP Input Data registers
-- (income_sources / expense_items / assets / liabilities / investments /
-- retirement_accounts / insurance_policies). The FDH-15 bridge will add its
-- own linkage when it exists; FDH-1 must not pre-empt it.
--
-- `entity_id` is deliberately POLYMORPHIC and therefore carries no foreign
-- key: it may point at a transaction, an allocation, an account, a document
-- or a future derived fact. `entity_type` names the table. The two frequent,
-- genuinely-typed cases (source_statement_id, source_transaction_id) DO carry
-- real foreign keys so the common lineage query is referentially safe.
--
-- EVIDENCE COMPLETENESS lives here, not on a transaction, because it is a
-- property of a DERIVED FACT rather than of a single row. "Monthly salary"
-- supported only by a bank credit is less complete than the same fact
-- supported by a payslip AND a reconciled bank credit. FDH-1 stores the
-- number and the supporting links; it deliberately hardcodes NO scoring rule
-- (no 0.5-for-bank-only, no 1.0-for-payslip). The scoring model belongs to
-- FDH-9.
-- ---------------------------------------------------------------------------
create table fdh_data_provenance (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  entity_type text not null
    check (entity_type in (
      'fdh_transaction', 'fdh_transaction_allocation', 'fdh_financial_account',
      'fdh_statement_upload', 'fdh_recurring_transaction', 'derived_fact'
    )),
  entity_id uuid not null,
  source_type text not null references fdh_source_types(source_type_key) on delete restrict,
  source_id uuid,
  source_statement_id uuid references fdh_statement_uploads(id) on delete set null,
  source_transaction_id uuid references fdh_transactions(id) on delete set null,
  calculation_period_start date,
  calculation_period_end date,
  as_of_date date,
  parser_id uuid references fdh_parser_registry(id) on delete restrict,
  parser_version_id uuid references fdh_parser_versions(id) on delete restrict,
  mapping_rule_version text,
  evidence_completeness numeric(5,4)
    check (evidence_completeness is null
           or (evidence_completeness >= 0 and evidence_completeness <= 1)),
  user_verified boolean not null default false,
  manual_override boolean not null default false,
  created_at timestamptz not null default now(),
  constraint chk_fdh_provenance_period
    check (calculation_period_end is null or calculation_period_start is null
           or calculation_period_end >= calculation_period_start)
);
create index idx_fdh_provenance_entity on fdh_data_provenance(entity_type, entity_id);
create index idx_fdh_provenance_user on fdh_data_provenance(user_id);
create index idx_fdh_provenance_statement on fdh_data_provenance(source_statement_id);
create index idx_fdh_provenance_transaction on fdh_data_provenance(source_transaction_id);
create index idx_fdh_provenance_parser
  on fdh_data_provenance(parser_id, parser_version_id);

alter table fdh_data_provenance enable row level security;
create policy "own rows - fdh_data_provenance" on fdh_data_provenance
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_evidence_links — many evidence sources supporting one provenance
-- record. This is what makes "salary evidence = bank credit + payslip"
-- representable without inventing a payslip-specific table now.
--
-- PAYSLIP EXTRACTION IS NOT IMPLEMENTED IN FDH-1 (FDH-9). Only the generic
-- relationship exists.
-- ---------------------------------------------------------------------------
create table fdh_evidence_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provenance_id uuid not null references fdh_data_provenance(id) on delete cascade,
  evidence_type text not null
    check (evidence_type in (
      'bank_transaction', 'payslip_document', 'statement_document',
      'user_attestation', 'external_reference', 'other'
    )),
  evidence_statement_upload_id uuid references fdh_statement_uploads(id) on delete set null,
  evidence_transaction_id uuid references fdh_transactions(id) on delete set null,
  evidence_weight numeric(5,4)
    check (evidence_weight is null or (evidence_weight >= 0 and evidence_weight <= 1)),
  note_sanitised text,
  created_at timestamptz not null default now()
);
create index idx_fdh_evidence_provenance on fdh_evidence_links(provenance_id);
create index idx_fdh_evidence_user on fdh_evidence_links(user_id);

alter table fdh_evidence_links enable row level security;
create policy "own rows - fdh_evidence_links" on fdh_evidence_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
