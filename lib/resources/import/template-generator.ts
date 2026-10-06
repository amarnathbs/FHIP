// Resources Bulk Upload -- template generation. The headers of every generated
// template come from the SAME canonical schema the parser reads, so
// template/parser drift is structurally impossible (and a test asserts it).
//
// XLSX is WRITTEN with SheetJS (write path only; it never READS uploads -- see
// file-security.ts). Server-only: imported dynamically from the template route.

import { COMPLIANCE_VALUES, DIFFICULTY_VALUES, JURISDICTION_VALUES, ARTICLE_FRESHNESS_VALUES, SOURCE_TYPE_LOOKUP } from './common-schema';
import { getImportAdapter } from './adapters';
import { stripUnusedBinContentType } from './xlsx-sanitize';
import type { ImportContentType, ImportSchema } from './types';

export interface TemplateLookups {
  categories: { name: string; slug: string }[];
  tags: { name: string; slug: string }[];
  authors: { display_name: string; slug: string }[];
  ctas: { name: string }[];
}

export const EMPTY_LOOKUPS: TemplateLookups = { categories: [], tags: [], authors: [], ctas: [] };

const CRLF = '\r\n';

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.split('"').join('""')}"` : s;
}

export function templateHeaders(schema: ImportSchema): string[] {
  return schema.columns.map((c) => c.key);
}

/** Header row only. A header-only CSV uploaded unedited is rejected as an empty file, never as content. */
export function buildTemplateCsv(type: ImportContentType): string {
  const { schema } = getImportAdapter(type);
  return `﻿${templateHeaders(schema).map(csvCell).join(',')}${CRLF}`;
}

export function templateFileName(type: ImportContentType, format: 'xlsx' | 'csv'): string {
  return `${getImportAdapter(type).schema.templateFileBase}.${format}`;
}

function instructionRows(type: ImportContentType): string[][] {
  const a = getImportAdapter(type);
  const rows: string[][] = [];
  for (const line of a.templateIntro) rows.push([line]);
  rows.push([]);
  rows.push(['Rules']);
  for (const n of a.templateNotes) rows.push([n]);
  rows.push([]);
  rows.push(['Columns']);
  rows.push(['Column', 'Required', 'What to enter']);
  for (const c of a.schema.columns) {
    rows.push([c.key, c.required ? 'Required' : 'Optional', c.help]);
  }
  rows.push([]);
  rows.push(['File format note: dates inside the upload file are written year-month-day with hyphens (for example 2026-10-06); this is the file format only. Screens in the app show dates day first.']);
  return rows;
}

function lookupRows(type: ImportContentType, lookups: TemplateLookups): string[][] {
  const rows: string[][] = [['Field', 'Allowed value', 'Note']];
  const add = (field: string, values: readonly string[], note = '') => {
    for (const v of values) rows.push([field, v, note]);
  };
  add('jurisdiction', JURISDICTION_VALUES);
  add('difficulty', DIFFICULTY_VALUES, 'optional');
  add('compliance_classification', COMPLIANCE_VALUES);
  if (type === 'article') add('freshness_type', ARTICLE_FRESHNESS_VALUES, 'optional; evergreen when blank');
  add('source_n_type', SOURCE_TYPE_LOOKUP, 'usual values; free text is accepted');
  add('source_n_is_public', ['TRUE', 'FALSE'], 'blank means TRUE');
  for (const c of lookups.categories) rows.push(['primary_category', c.name, `slug: ${c.slug}`]);
  for (const t of lookups.tags) rows.push(['tags', t.name, `slug: ${t.slug}; separate several with |`]);
  if (type === 'article') for (const a of lookups.authors) rows.push(['author', a.display_name, `slug: ${a.slug}`]);
  for (const c of lookups.ctas) rows.push(['primary_cta / secondary_cta', c.name, 'active CTA']);
  return rows;
}

/** XLSX with the four sheets the spec defines. Only the upload sheet is ever imported. */
export async function buildTemplateXlsx(type: ImportContentType, lookups: TemplateLookups = EMPTY_LOOKUPS): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const { schema } = getImportAdapter(type);
  const wb = XLSX.utils.book_new();

  const toSheet = (rows: string[][], widths: number[]) => {
    const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((v) => v)));
    ws['!cols'] = widths.map((wch) => ({ wch }));
    // Force text so Excel does not turn "1.0" into 1 or an id into a number.
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue;
      const cell = ws[addr] as { t: string; v: unknown };
      if (typeof cell.v === 'string') cell.t = 's';
    }
    return ws;
  };

  const headers = templateHeaders(schema);
  XLSX.utils.book_append_sheet(wb, toSheet(instructionRows(type), [34, 12, 120]), 'Instructions');
  XLSX.utils.book_append_sheet(wb, toSheet([headers], headers.map((h) => Math.max(14, h.length + 2))), schema.uploadSheetName);
  XLSX.utils.book_append_sheet(wb, toSheet(lookupRows(type, lookups), [28, 40, 50]), 'Lookup_Values');
  XLSX.utils.book_append_sheet(wb, toSheet([headers, schema.columns.map((c) => c.example)], headers.map((h) => Math.max(14, h.length + 2))), schema.exampleSheetName);

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer;
  return stripUnusedBinContentType(new Uint8Array(out));
}
