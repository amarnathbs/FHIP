/**
 * FDH-5 — repeatable schema-verification test, mirroring
 * tests/unit/r7SchemaContract.test.ts / r8SchemaContract.test.ts's method:
 * parse migration 0071 from disk and assert structural facts rather than
 * trust prose.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_ALL_ERROR_CODES,
  FDH_PDF_CLASSIFICATIONS,
  FDH_PDF_EXTRACTION_METHODS,
} from '@/lib/financial-data-hub/constants/enums';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const FILE = '0071_fdh5_bank_pdf_engine_foundation.sql';
const RAW = fs.readFileSync(path.join(MIGRATION_DIR, FILE), 'utf8');
const SQL = RAW.split('\n')
  .map((line) => {
    const i = line.indexOf('--');
    return i === -1 ? line : line.slice(0, i);
  })
  .join('\n');

describe('FDH-5 migration 0071 exists and is additive-only', () => {
  it('the file exists', () => {
    expect(fs.existsSync(path.join(MIGRATION_DIR, FILE))).toBe(true);
  });

  it('is additive only — no drop table, no drop column, no delete from, no destructive update to existing rows', () => {
    expect(/drop table/i.test(SQL)).toBe(false);
    expect(/drop column/i.test(SQL)).toBe(false);
    expect(/delete from/i.test(SQL)).toBe(false);
    // The one sanctioned pattern: widening a check constraint (drop
    // constraint + add constraint), identical precedent to 0064/0068.
    const drops = [...SQL.matchAll(/drop (\w+)/gi)].map((m) => m[1].toLowerCase());
    for (const d of drops) expect(['constraint', 'index']).toContain(d);
  });

  it('creates NO new table — every change is an ALTER on an existing FDH table or an INSERT into an existing seed table', () => {
    const created = [...SQL.matchAll(/create table (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]);
    expect(created).toEqual([]);
  });

  it('adds exactly the three disclosed new columns on fdh_statement_uploads', () => {
    const addColumnMatches = [...SQL.matchAll(/add column (\w+)/g)].map((m) => m[1]);
    expect(addColumnMatches.sort()).toEqual(['certified_extraction_methods', 'extraction_confidence', 'page_count', 'pdf_classification'].sort());
  });
});

describe('FDH-5 new-column check constraints match their TypeScript vocabularies', () => {
  it('fdh_statement_uploads.pdf_classification', () => {
    const idx = SQL.indexOf('add column pdf_classification text');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 300);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_PDF_CLASSIFICATIONS].sort());
  });

  it('fdh_parser_versions.certified_extraction_methods', () => {
    const idx = SQL.indexOf('chk_fdh_parser_versions_extraction_methods');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 200);
    const match = slice.match(/array\[([^\]]*)\]/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_PDF_EXTRACTION_METHODS].sort());
  });

  it('fdh_statement_uploads.error_code widened constraint matches the FULL (FDH-1 + FDH-5) TypeScript vocabulary', () => {
    const idx = SQL.indexOf('add constraint fdh_statement_uploads_error_code_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 900);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_ALL_ERROR_CODES].sort());
  });

  it('fdh_document_audit_events.event_type widened constraint matches the FULL (FDH-3 + R7 + R8 + FDH-5) TypeScript vocabulary', () => {
    const idx = SQL.indexOf('add constraint fdh_document_audit_events_event_type_check');
    expect(idx).toBeGreaterThan(-1);
    const slice = SQL.slice(idx, idx + 1900);
    const match = slice.match(/in \(([^)]*)\)/);
    const values = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES].sort());
  });
});

describe('FDH-5 PDF adapter seed data', () => {
  it('registers exactly the 8 priority-wave PDF parser_key values, all source_format = pdf_native', () => {
    const keys = [...SQL.matchAll(/select '([a-z_0-9]+_pdf_v1)'/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual(
      [
        'au_cba_pdf_v1', 'au_anz_pdf_v1', 'au_nab_pdf_v1', 'au_westpac_pdf_v1',
        'in_sbi_pdf_v1', 'in_hdfc_pdf_v1', 'in_icici_pdf_v1', 'in_axis_pdf_v1',
      ].sort(),
    );
    // Every registry INSERT row in this file declares 'pdf_native' as its
    // source_format — never 'csv' (that would collide with R7/FDH-4's own
    // seeded parser_key namespace) and never a bare source_format omission.
    const registryBlock = SQL.slice(SQL.indexOf('insert into fdh_parser_registry'), SQL.indexOf('insert into fdh_parser_versions'));
    const formatMentions = [...registryBlock.matchAll(/'bank_statement', '([a-z_]+)'/g)].map((m) => m[1]);
    expect(formatMentions.every((f) => f === 'pdf_native')).toBe(true);
    expect(formatMentions.length).toBe(8);
  });

  it('every seeded PDF parser version is certified for native_text only, never ocr, in this phase', () => {
    const idx = SQL.indexOf('insert into fdh_parser_versions');
    const slice = SQL.slice(idx, idx + 700);
    expect(slice).toContain("array['native_text']");
    expect(slice).not.toContain('ocr');
  });
});
