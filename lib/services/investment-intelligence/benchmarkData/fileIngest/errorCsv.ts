// Downloadable validation-error CSV. Operators open this in a spreadsheet, and
// its cells echo text from an untrusted upload, so EVERY cell is neutralised
// against formula injection (CSV injection) before it is quoted.
import type { ValidationIssue } from './validator';

export const ERROR_CSV_HEADER = ['row_number', 'severity', 'code', 'column', 'message', 'raw_excerpt'] as const;
export const MAX_CELL_CHARS = 500;
const TRIGGERS = new Set(['=', '+', '-', '@']);

/** Leading characters spreadsheets skip over before deciding whether a cell is a formula. */
function isIgnorableLead(code: number): boolean {
  return code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xa0 || code === 0xfeff || code === 0x200b;
}

/**
 * Prefixes a single quote to any cell that a spreadsheet could interpret as a
 * formula: it starts (after leading whitespace/control characters) with
 * = + - @, or it starts with TAB or CR. The cell is also capped to
 * {@link MAX_CELL_CHARS} characters, prefix included.
 */
export function neutraliseCsvCell(s: string): string {
  let out = s;
  const first = out[0];
  let dangerous = first === '\t' || first === '\r';
  if (!dangerous) {
    let i = 0;
    while (i < out.length && isIgnorableLead(out.charCodeAt(i))) i++;
    dangerous = i < out.length && TRIGGERS.has(out[i]);
  }
  if (dangerous) out = `'${out}`;
  if (out.length > MAX_CELL_CHARS) out = out.slice(0, MAX_CELL_CHARS - 1) + '…';
  return out;
}

function quote(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) return `"${s.split('"').join('""')}"`;
  return s;
}

export function buildValidationErrorCsv(issues: ValidationIssue[], opts: { maxRows?: number } = {}): string {
  const lines: string[] = [ERROR_CSV_HEADER.join(',')];
  const max = opts.maxRows !== undefined && opts.maxRows >= 0 ? opts.maxRows : issues.length;
  const shown = issues.slice(0, max);
  for (const i of shown) {
    const cells = [
      i.rowNumber === null ? '' : String(i.rowNumber),
      i.severity,
      i.code,
      i.column ?? '',
      i.message,
      i.rawExcerpt ?? '',
    ];
    lines.push(cells.map((c) => quote(neutraliseCsvCell(c))).join(','));
  }
  if (issues.length > shown.length) {
    lines.push(
      ['', 'warning', 'ERROR_CSV_TRUNCATED', '', `${issues.length - shown.length} further issue(s) are not included in this file.`, '']
        .map((c) => quote(neutraliseCsvCell(c)))
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
