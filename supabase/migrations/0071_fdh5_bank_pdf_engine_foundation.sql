-- =============================================================================
-- FDH-5 — Bank PDF Statement Engine: schema foundation.
-- =============================================================================
-- MIGRATION NUMBERING (spec section 5, orchestration section 2). Canonical
-- main's own migrations directory tops out at 0068
-- (0068_r8_transaction_classification_engine.sql); 0067 is reserved by the
-- still-unmerged Investment Intelligence R9 branch
-- (0067_ii_r9_review_centre.sql, verified via
-- `check-migration-versions-against-branch.mjs --against=<r9 branch ref>`,
-- zero collisions). Ground truth was additionally verified LIVE against the
-- real DEV Supabase project's REST OpenAPI schema (not just git): tables
-- with no corresponding file anywhere in this branch's or R9's committed
-- migrations directory (`forecast_runs`, `forecast_profiles`,
-- `forecast_scenarios`, `forecast_results`, `forecast_assumptions`,
-- `forecast_explanations`, `forecast_global_assumptions`,
-- `forecast_report_render_tokens`, `goal_forecasts`, `ii_goal_allocations`,
-- `user_goals`) already exist live, proving a migration NUMBERED BEYOND 0067
-- is already applied to DEV even though it is not yet reflected in any
-- branch's git history. `0069` is therefore treated as unsafe to allocate;
-- this migration is `0070`, the next number verified free against BOTH
-- canonical main's git history AND DEV's actual live-applied state.
--
-- OWNERSHIP (spec section 3). Per FDH-5 spec section 3, this migration
-- creates NO parallel canonical-transaction table, NO parallel dedup table,
-- NO parallel reconciliation table, NO parallel categorisation table. It
-- extends the EXISTING FDH-1/R7/R8 schema exactly as R7's own migration 0064
-- did for CSV: additive columns on `fdh_statement_uploads`/
-- `fdh_parser_versions`, a widened (never narrowed) `error_code` and
-- `event_type` vocabulary, and parser-registry seed rows for a SECOND
-- `source_format` (`pdf_native`) the registry's own `fdh_source_types`
-- lookup table already anticipated back in migration 0045 (spec section 12:
-- "'csv', 'pdf_native', 'pdf_scanned', ...").
--
-- WHY SO LITTLE SCHEMA IS ACTUALLY NEEDED. FDH-1's original design already
-- anticipated PDF/OCR provenance: `fdh_transactions.source_page` and
-- `fdh_transactions.extraction_confidence` (migration 0047),
-- `fdh_statement_uploads.processing_method` already including
-- `'native_text'`/`'ocr'` and `error_code` already including
-- `'password_required'`/`'password_invalid'` (migration 0046), and
-- `fdh_reconciliation_results.opening_balance`/`reported_closing_balance`
-- (migration 0048) — all reused completely unchanged. Only the genuinely
-- NEW facts FDH-5 introduces get new columns below: a PDF's own structural
-- classification, a DOCUMENT-level (not per-transaction) extraction
-- confidence, its page count, and per-adapter-version OCR-vs-native-text
-- certification granularity (spec 55-56).
--
-- ADDITIVE ONLY. No column is dropped, no table is dropped, no existing row
-- is mutated, no existing NOT NULL/type is narrowed.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_statement_uploads — additive widening (spec sections 15, 36-37, 44-45).
-- ---------------------------------------------------------------------------
alter table fdh_statement_uploads
  add column page_count int check (page_count is null or page_count >= 1),
  -- Structural PDF classification (spec 15) — TEXT_NATIVE / IMAGE_ONLY /
  -- MIXED_CONTENT / ENCRYPTED / CORRUPT / UNSUPPORTED. Null for a non-PDF
  -- (CSV) document.
  add column pdf_classification text
    check (pdf_classification is null or pdf_classification in (
      'text_native', 'image_only', 'mixed_content', 'encrypted', 'corrupt', 'unsupported'
    )),
  -- DOCUMENT-level extraction confidence (spec 44's "statement-level
  -- extraction quality"), DELIBERATELY SEPARATE from
  -- `fdh_transactions.extraction_confidence` (per-transaction, migration
  -- 0047) — the two are never merged into one number.
  add column extraction_confidence numeric(5,4)
    check (extraction_confidence is null or (extraction_confidence >= 0 and extraction_confidence <= 1));

-- ---------------------------------------------------------------------------
-- fdh_parser_versions — per-extraction-method certification granularity
-- (spec sections 55-56): "CBA PDF V1 — native text: CERTIFIED, scanned OCR:
-- NOT CERTIFIED" must be a real, queryable fact, kept separate from the
-- existing `status` lifecycle column (development/certified/deprecated/
-- disabled). Defaults to an empty array — a CSV parser version, which has no
-- OCR-vs-native-text distinction at all, is entirely unaffected.
-- ---------------------------------------------------------------------------
alter table fdh_parser_versions
  add column certified_extraction_methods text[] not null default '{}';
alter table fdh_parser_versions
  add constraint chk_fdh_parser_versions_extraction_methods
    check (certified_extraction_methods <@ array['native_text', 'ocr']::text[]);


-- ---------------------------------------------------------------------------
-- fdh_statement_uploads.error_code — additive widening (spec section 83).
-- See `lib/financial-data-hub/constants/enums.ts`'s
-- `FDH_ERROR_CODES_FDH5_ADDED` header comment for the complete
-- existing-code-reuse mapping (most FDH-5 error states reuse an EXISTING
-- FDH-1 code unchanged; only the 5 codes below have no existing equivalent).
-- ---------------------------------------------------------------------------
alter table fdh_statement_uploads
  drop constraint if exists fdh_statement_uploads_error_code_check;
alter table fdh_statement_uploads
  add constraint fdh_statement_uploads_error_code_check
    check (error_code is null or error_code in (
      -- FDH-1 original set (migration 0046) — unchanged.
      'unsupported_file_type', 'file_corrupt', 'password_required',
      'password_invalid', 'institution_not_identified',
      'document_type_not_identified', 'parser_not_found', 'layout_unsupported',
      'extraction_failed', 'reconciliation_failed', 'data_validation_failed',
      'malware_detected', 'privacy_purge_failed', 'internal_error',
      -- FDH-5 additions (spec section 83).
      'page_limit_exceeded', 'format_ambiguous', 'extraction_low_confidence',
      'ocr_required', 'ocr_failed'
    ));


-- ---------------------------------------------------------------------------
-- fdh_document_audit_events.event_type — additive widening (spec section 85).
-- Same widening discipline R7 (migration 0064) and R8 (migration 0068)
-- already established for this exact constraint.
-- ---------------------------------------------------------------------------
alter table fdh_document_audit_events
  drop constraint if exists fdh_document_audit_events_event_type_check;
alter table fdh_document_audit_events
  add constraint fdh_document_audit_events_event_type_check
    check (event_type in (
      -- FDH-3 original set (migration 0058).
      'document_upload_created', 'document_upload_completed', 'document_validated',
      'document_rejected', 'document_queued', 'document_user_deleted',
      'document_purge_scheduled', 'document_purged', 'document_purge_failed',
      -- R7 additions (migration 0064).
      'bank_csv_uploaded', 'bank_csv_detection_completed', 'bank_csv_mapping_confirmed',
      'bank_csv_processing_started', 'bank_csv_processing_completed',
      'bank_csv_processing_failed', 'transaction_duplicate_detected',
      'transaction_duplicate_resolved', 'transaction_corrected', 'import_reconciled',
      -- R8 additions (migration 0068).
      'transaction_classification_run', 'transaction_link_reviewed',
      'recurring_series_reviewed', 'personal_rule_created',
      -- FDH-5 additions (spec section 85).
      'pdf_validated', 'pdf_password_required', 'pdf_decrypted_for_processing',
      'pdf_native_extraction_started', 'pdf_native_extraction_completed',
      'pdf_ocr_started', 'pdf_ocr_completed', 'pdf_adapter_detected',
      'pdf_processing_failed', 'pdf_review_required', 'pdf_processing_completed'
    ));


-- ---------------------------------------------------------------------------
-- R7 authoritative-field trigger — extended to cover FDH-5's own new
-- authoritative columns (spec sections 51-52, 82, applying the EXACT
-- precedent migration 0064 established for R7's own authoritative fields).
-- `create or replace function` updates the function body in place; the
-- existing `trg_r7_statement_upload_authoritative_fields` trigger (created
-- by migration 0064) picks up the new body automatically — no new trigger
-- object is created.
-- ---------------------------------------------------------------------------
create or replace function r7_assert_statement_upload_authoritative_fields() returns trigger as $$
begin
  if auth.role() = 'authenticated' then
    if new.detection_status is distinct from old.detection_status
      or new.detection_confidence is distinct from old.detection_confidence
      or new.detection_evidence is distinct from old.detection_evidence
      or new.certification_status is distinct from old.certification_status
      or new.declared_row_count is distinct from old.declared_row_count
      or new.parsed_row_count is distinct from old.parsed_row_count
      or new.certified_row_count is distinct from old.certified_row_count
      or new.duplicate_row_count is distinct from old.duplicate_row_count
      or new.adapter_key is distinct from old.adapter_key
      or new.adapter_version is distinct from old.adapter_version
      or new.mapping_template_id is distinct from old.mapping_template_id
      or new.delimiter_detected is distinct from old.delimiter_detected
      or new.encoding_detected is distinct from old.encoding_detected
      or new.header_row_index is distinct from old.header_row_index
      -- FDH-5 additions.
      or new.page_count is distinct from old.page_count
      or new.pdf_classification is distinct from old.pdf_classification
      or new.extraction_confidence is distinct from old.extraction_confidence
    then
      raise exception 'fdh_statement_uploads: authoritative R7/FDH-5 detection/certification fields may not be written directly by the authenticated role';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;


-- ---------------------------------------------------------------------------
-- PDF adapter governance records (spec sections 27, 49-56). Each row here
-- mirrors one entry in `lib/financial-data-hub/bank-pdf/adapters/registry.ts`
-- — the DB row is the certification/audit record; the code is the actual
-- parsing behaviour (same split R7's migration 0064 established). All 8
-- priority-wave institutions (spec 49-50) are certified for NATIVE TEXT
-- ONLY (`certified_extraction_methods = '{native_text}'`) — none claim OCR
-- certification in this phase (spec 55-56). Evidence tier: synthetic
-- structural fixtures built from documented public conventions — identical
-- evidence standard to R7's own CSV adapters (migration 0064's own header
-- note); no real customer PDF statement was used (spec 52-54).
-- ---------------------------------------------------------------------------
insert into fdh_parser_registry (parser_key, institution_id, document_type, source_format, country_code, active)
select 'au_cba_pdf_v1', id, 'bank_statement', 'pdf_native', 'AU', true from fdh_financial_institutions where institution_code = 'cba' and country_code = 'AU'
union all
select 'au_anz_pdf_v1', id, 'bank_statement', 'pdf_native', 'AU', true from fdh_financial_institutions where institution_code = 'anz' and country_code = 'AU'
union all
select 'au_nab_pdf_v1', id, 'bank_statement', 'pdf_native', 'AU', true from fdh_financial_institutions where institution_code = 'nab' and country_code = 'AU'
union all
select 'au_westpac_pdf_v1', id, 'bank_statement', 'pdf_native', 'AU', true from fdh_financial_institutions where institution_code = 'westpac' and country_code = 'AU'
union all
select 'in_sbi_pdf_v1', id, 'bank_statement', 'pdf_native', 'IN', true from fdh_financial_institutions where institution_code = 'sbi' and country_code = 'IN'
union all
select 'in_hdfc_pdf_v1', id, 'bank_statement', 'pdf_native', 'IN', true from fdh_financial_institutions where institution_code = 'hdfc_bank' and country_code = 'IN'
union all
select 'in_icici_pdf_v1', id, 'bank_statement', 'pdf_native', 'IN', true from fdh_financial_institutions where institution_code = 'icici_bank' and country_code = 'IN'
union all
select 'in_axis_pdf_v1', id, 'bank_statement', 'pdf_native', 'IN', true from fdh_financial_institutions where institution_code = 'axis_bank' and country_code = 'IN';

insert into fdh_parser_versions (parser_id, version, status, introduced_at, supported_layout_reference, certified_extraction_methods, notes)
select id, '1.0.0', 'certified', now(), 'synthetic structural fixture', array['native_text'],
  'FDH-5 initial certification against synthetic structural PDF fixtures (spec 52-54) — no real customer statement used. Native-text extraction only; scanned/OCR NOT certified (spec 55-56).'
from fdh_parser_registry where parser_key in (
  'au_cba_pdf_v1', 'au_anz_pdf_v1', 'au_nab_pdf_v1', 'au_westpac_pdf_v1',
  'in_sbi_pdf_v1', 'in_hdfc_pdf_v1', 'in_icici_pdf_v1', 'in_axis_pdf_v1'
);

-- coverage_status is institution-level (spec: does this institution have A
-- certified parser at all, regardless of format) and every one of these 8
-- institutions was ALREADY 'parser_certified' from R7/FDH-4's CSV adapters
-- (migrations 0064/0066) — genuinely nothing changes here; this UPDATE is a
-- documented no-op included only so the statement is explicit rather than
-- silently assumed.
update fdh_financial_institutions set coverage_status = 'parser_certified'
where (country_code, institution_code) in (
  ('AU', 'cba'), ('AU', 'anz'), ('AU', 'nab'), ('AU', 'westpac'),
  ('IN', 'sbi'), ('IN', 'hdfc_bank'), ('IN', 'icici_bank'), ('IN', 'axis_bank')
);
