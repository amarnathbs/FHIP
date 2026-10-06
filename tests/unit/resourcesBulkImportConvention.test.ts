// The established shared-ingest convention (Market Index Data / benchmark upload), which the PO asked the bulk upload to
// follow: the operator CHOOSES the sheet of a workbook (never defaulted silently), other sheets and hidden rows are
// DISCLOSED, header is row 1, the CSV delimiter is detected deterministically, the CSV template is header-only.
//
// NC-C1: the "chosen sheet" rule bites -- without a choice the same workbook is refused; with the choice it imports.
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseImportFile } from '@/lib/resources/import/parser';
import { buildTemplateCsv } from '@/lib/resources/import/template-generator';
import { stripUnusedBinContentType } from '@/lib/resources/import/xlsx-sanitize';
import { listUploadSheets } from '@/lib/resources/import/file-security';
import { csvOf, good, rowsToAoa, SCHEMAS, xlsxOf } from '../support/resourcesImportFixtures';

const rows = [good('article')];
const wb = (name: string) => xlsxOf({ Notes: [['hello']], [name]: rowsToAoa('article', rows), Other: [['x']] });
const xl = (bytes: Uint8Array, sheetName?: string) => parseImportFile({ fileName: 'a.xlsx', bytes }, SCHEMAS.article, { sheetName });
const codes = (p: { ok: boolean; issues?: { code: string }[] }) => (p.ok ? [] : (p.issues ?? []).map((i) => i.code));

describe('explicit sheet choice and disclosure', () => {
  it('NC-C1 no sheet chosen -> UPLOAD_SHEET_MISSING naming the sheets; the same workbook imports once a sheet is chosen (ANY sheet name)', () => {
    const bytes = wb('My Rows');
    const none = xl(bytes);
    expect(codes(none)).toEqual(['UPLOAD_SHEET_MISSING']);
    expect(JSON.stringify(none)).toContain('My Rows');
    expect(xl(bytes, 'My Rows').ok).toBe(true);
    expect(xl(bytes, 'my rows').ok, 'sheet names compare case-insensitively').toBe(true);
    expect(codes(xl(bytes, 'Nope'))).toEqual(['UPLOAD_SHEET_MISSING']);
  });

  it('only the chosen sheet is read; the others are disclosed as not imported', () => {
    const p = xl(wb('Data'), 'Data');
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.table.sheetName).toBe('Data');
      const n = p.notes.find((x) => x.code === 'SHEET_NOTE');
      expect(n?.severity).toBe('warning');
      expect(n?.message).toContain('"Data"');
      expect(n?.message).toContain('"Notes"');
      expect(n?.message).toContain('"Other"');
    }
  });

  it('the inspect step lists the sheets (never the very-hidden ones) so the person can choose; CSV needs no choice; bad files are refused with the same codes', () => {
    const listing = listUploadSheets({ fileName: 'a.xlsx', bytes: wb('Data') });
    expect(listing.ok && listing.kind === 'xlsx' && listing.sheets.map((s) => s.name)).toEqual(['Notes', 'Data', 'Other']);
    expect(listUploadSheets({ fileName: 'a.csv', bytes: csvOf('article', rows) })).toEqual({ ok: true, kind: 'csv' });
    const bad = listUploadSheets({ fileName: 'a.xls', bytes: new Uint8Array([1, 2, 3]) });
    expect(bad.ok).toBe(false);
  });

  it('hidden rows are skipped and DISCLOSED by row number, never imported silently', () => {
    const header = SCHEMAS.article.columns.map((c) => c.key);
    const mk = (r: Record<string, string>) => header.map((h) => r[h] ?? '');
    const ws = XLSX.utils.aoa_to_sheet([header, mk(good('article', { external_id: 'A', slug: 'a-1' })), mk(good('article', { external_id: 'B', slug: 'b-2' }))]);
    ws['!rows'] = [{}, {}, { hidden: true }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, ws, 'Data');
    const bytes = stripUnusedBinContentType(new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
    const p = xl(bytes, 'Data');
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.table.rows.map((r) => r.values.external_id)).toEqual(['A']);
      expect(p.notes.find((x) => x.code === 'HIDDEN_ROWS_SKIPPED')?.message).toContain('rows 3');
    }
  });
});

describe('CSV conventions', () => {
  it('the delimiter is detected deterministically: a semicolon file is read; a header with no consistent delimiter is not guessed', () => {
    const plain = good('article', { title: 'No commas here', excerpt: 'Plain excerpt', quick_answer: 'Plain', key_takeaways: 'One', main_content: '## H\n\nBody.', example: 'Ex', financial_health_meaning: 'Fh', source_1_name: 'S', source_1_document_title: 'D', primary_category: 'c', tags: 't', author: 'a' });
    const comma = new TextDecoder().decode(csvOf('article', [plain]));
    const semi = comma.replace(/,/g, ';');
    const p = parseImportFile({ fileName: 'a.csv', bytes: new TextEncoder().encode(semi) }, SCHEMAS.article);
    expect(p.ok).toBe(true);
    expect(codes(parseImportFile({ fileName: 'a.csv', bytes: new TextEncoder().encode('title\r\nx\r\n') }, SCHEMAS.article))).toContain('MISSING_REQUIRED_COLUMN');
  });

  it('the CSV template follows the convention: header row only, no comment lines (a comment would corrupt a re-upload)', () => {
    const csv = buildTemplateCsv('article').replace(/^﻿/, '').trimEnd();
    expect(csv.split(/\r?\n/)).toHaveLength(1);
    expect(csv.startsWith('#')).toBe(false);
  });
});
