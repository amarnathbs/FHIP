// Resources Bulk Upload -- downloadable validation results (row, field, error_code, message).
//
// Every cell echoes text that came from an UNTRUSTED upload and is opened in a spreadsheet, so every cell
// is neutralised against formula injection (a leading = + - @ TAB or CR gets a quote prefix) by the shared,
// already-certified neutraliser. Admin Architecture Standard section 11: server-side generation, a fixed
// column allow-list, formula-injection protection, authorised at download time (the route re-checks).

import { neutraliseCsvCell } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import type { ImportIssue } from './types';

export const RESULTS_CSV_HEADER = ['row', 'field', 'error_code', 'message', 'severity'] as const;

function quote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.split('"').join('""')}"` : s;
}

export function buildResultsCsv(issues: ImportIssue[]): string {
  const lines: string[] = [RESULTS_CSV_HEADER.join(',')];
  const ordered = [...issues].sort((a, b) => (a.row ?? 0) - (b.row ?? 0) || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  for (const i of ordered) {
    const cells = [i.row === null ? '' : String(i.row), i.field ?? '', i.code, i.message, i.severity];
    lines.push(cells.map((c) => quote(neutraliseCsvCell(c))).join(','));
  }
  if (ordered.length === 0) lines.push(['', '', '', 'No issues found.', 'info'].map((c) => quote(neutraliseCsvCell(c))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function resultsFileName(contentType: string, runId: string): string {
  return `resources_${contentType}_upload_results_${runId.slice(0, 8)}.csv`;
}
