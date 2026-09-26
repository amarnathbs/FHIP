-- 0206 -- FDH-5 bank PDF engine: forward-only CATCH-UP of the parts of 0071
-- that production never received.
--
-- FOUND IN PRODUCTION (2026-09-26), by the first AI-read bank statement PDF:
-- after writing the transactions, data-quality rows and review item, the
-- final status update wrote page_count / pdf_classification /
-- extraction_confidence -- three fdh_statement_uploads columns that do not
-- exist in production. The update failed, the request returned "We could not
-- save this statement", and the document was left 'extracted'. Read-only
-- checks show 0071 (FDH-5 foundation) was never applied to production:
--   * fdh_statement_uploads lacks page_count, pdf_classification,
--     extraction_confidence;
--   * fdh_parser_versions lacks certified_extraction_methods;
--   * fdh_parser_registry has none of the 8 *_pdf_v1 rows;
--   * r7_assert_statement_upload_authoritative_fields() is still 0065's body.
-- So no bank statement PDF import could ever finish in production.
--
-- WHY NOT RE-APPLY 0071. It DROPS AND RECREATES two shared CHECK constraints
-- (fdh_statement_uploads_error_code_check, fdh_document_audit_events_
-- event_type_check) with 0071-era value lists. Later migrations widened both
-- (latest rebuilds: 0179 and 0186), and those rebuilds already contain every
-- value 0071 added -- production accepted pdf_* audit events on 2026-09-26.
-- Re-applying 0071 would silently REVOKE every value added since. This file
-- takes only the missing, additive parts and touches neither constraint.
--
-- IDEMPOTENT: every statement is guarded, so it is a no-op wherever 0071 was
-- applied (DEV, a fresh replay) and completes the schema where it was not.
-- Verification: scripts/fdh5_0206_pglite_verification.mjs.

-- 1. fdh_statement_uploads: the three FDH-5 columns, with 0071's checks.
alter table fdh_statement_uploads
  add column if not exists page_count int,
  add column if not exists pdf_classification text,
  add column if not exists extraction_confidence numeric(5,4);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_statement_uploads'::regclass and conname = 'chk_fdh_statement_uploads_page_count_0206')
     and not exists (select 1 from pg_constraint where conrelid = 'fdh_statement_uploads'::regclass and conname = 'fdh_statement_uploads_page_count_check') then
    alter table fdh_statement_uploads add constraint chk_fdh_statement_uploads_page_count_0206
      check (page_count is null or page_count >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_statement_uploads'::regclass and conname = 'chk_fdh_statement_uploads_pdf_classification_0206')
     and not exists (select 1 from pg_constraint where conrelid = 'fdh_statement_uploads'::regclass and conname = 'fdh_statement_uploads_pdf_classification_check') then
    alter table fdh_statement_uploads add constraint chk_fdh_statement_uploads_pdf_classification_0206
      check (pdf_classification is null or pdf_classification in (
        'text_native', 'image_only', 'mixed_content', 'encrypted', 'corrupt', 'unsupported'
      ));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_statement_uploads'::regclass and conname = 'chk_fdh_statement_uploads_extraction_confidence_0206')
     and not exists (select 1 from pg_constraint where conrelid = 'fdh_statement_uploads'::regclass and conname = 'fdh_statement_uploads_extraction_confidence_check') then
    alter table fdh_statement_uploads add constraint chk_fdh_statement_uploads_extraction_confidence_0206
      check (extraction_confidence is null or (extraction_confidence >= 0 and extraction_confidence <= 1));
  end if;
end $$;

-- 2. fdh_parser_versions: per-extraction-method certification.
alter table fdh_parser_versions
  add column if not exists certified_extraction_methods text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'fdh_parser_versions'::regclass and conname = 'chk_fdh_parser_versions_extraction_methods') then
    alter table fdh_parser_versions add constraint chk_fdh_parser_versions_extraction_methods
      check (certified_extraction_methods <@ array['native_text', 'ocr']::text[]);
  end if;
end $$;

-- 3. The authoritative-field trigger body from 0071 (the latest definition;
--    no later migration redefines it). Now that the columns exist, the
--    authenticated role may not write them directly.
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

-- 4. PDF adapter governance records, only where missing.
insert into fdh_parser_registry (parser_key, institution_id, document_type, source_format, country_code, active)
select v.parser_key, i.id, 'bank_statement', 'pdf_native', v.country_code, true
from (values
  ('au_cba_pdf_v1', 'cba', 'AU'), ('au_anz_pdf_v1', 'anz', 'AU'), ('au_nab_pdf_v1', 'nab', 'AU'),
  ('au_westpac_pdf_v1', 'westpac', 'AU'), ('in_sbi_pdf_v1', 'sbi', 'IN'), ('in_hdfc_pdf_v1', 'hdfc_bank', 'IN'),
  ('in_icici_pdf_v1', 'icici_bank', 'IN'), ('in_axis_pdf_v1', 'axis_bank', 'IN')
) as v(parser_key, institution_code, country_code)
join fdh_financial_institutions i on i.institution_code = v.institution_code and i.country_code = v.country_code
where not exists (select 1 from fdh_parser_registry r where r.parser_key = v.parser_key);

insert into fdh_parser_versions (parser_id, version, status, introduced_at, supported_layout_reference, certified_extraction_methods, notes)
select r.id, '1.0.0', 'certified', now(), 'synthetic structural fixture', array['native_text'],
  'FDH-5 initial certification against synthetic structural PDF fixtures (spec 52-54) -- no real customer statement used. Native-text extraction only; scanned/OCR NOT certified (spec 55-56). Added to production by 0206 (catch-up of 0071).'
from fdh_parser_registry r
where r.parser_key in (
  'au_cba_pdf_v1', 'au_anz_pdf_v1', 'au_nab_pdf_v1', 'au_westpac_pdf_v1',
  'in_sbi_pdf_v1', 'in_hdfc_pdf_v1', 'in_icici_pdf_v1', 'in_axis_pdf_v1'
)
and not exists (select 1 from fdh_parser_versions pv where pv.parser_id = r.id and pv.version = '1.0.0');
