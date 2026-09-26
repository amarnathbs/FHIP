/**
 * FDH-12 / WP-13 (GAP-RET-05) -- extraction warnings as PERSISTED, visible
 * evidence.
 *
 * The parsers (extraction.ts, and the AI mapping) report what they skipped as
 * short strings -- `unreadable_amount_rows_skipped:3`,
 * `summed_summary_lines:fees:2`, `unrecognised_summary_label=Admin rebate`.
 * Before WP-13 those strings were never written anywhere, so a statement that
 * silently lost rows looked complete. They are now stored on
 * `fdh_retirement_statements.extraction_warnings` (migration 0207; a JSON
 * array of `{code, count?, detail?}`, write-protected by 0211) and rendered on
 * the review screen and the Retirement tab's statement history.
 *
 * Pure: no I/O.
 */

export interface StructuredExtractionWarning {
  code: string;
  count?: number;
  detail?: string;
}

const CODE_MAX = 64;
const DETAIL_MAX = 120;

function cleanCode(raw: string): string {
  const code = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return (code || 'warning').slice(0, CODE_MAX);
}

/** One parser warning string -> `{code, count?, detail?}`. */
export function structureExtractionWarning(warning: string): StructuredExtractionWarning {
  const eq = warning.indexOf('=');
  if (eq > 0) {
    const detail = warning.slice(eq + 1).trim().slice(0, DETAIL_MAX);
    return detail ? { code: cleanCode(warning.slice(0, eq)), detail } : { code: cleanCode(warning.slice(0, eq)) };
  }
  const [head, ...rest] = warning.split(':');
  const out: StructuredExtractionWarning = { code: cleanCode(head) };
  const details: string[] = [];
  for (const part of rest) {
    const p = part.trim();
    if (p === '') continue;
    if (/^\d+$/.test(p) && out.count === undefined) out.count = Number(p);
    else details.push(p);
  }
  if (details.length > 0) out.detail = details.join(':').slice(0, DETAIL_MAX);
  return out;
}

/** Every warning, structured, in order. At most 50 are kept (a runaway parser
 * must not bloat the row); the 51st onward are summarised as one entry. */
export function structureExtractionWarnings(warnings: readonly string[] | null | undefined): StructuredExtractionWarning[] {
  const list = (warnings ?? []).filter((w) => typeof w === 'string' && w.trim() !== '');
  const out = list.slice(0, 50).map(structureExtractionWarning);
  if (list.length > 50) out.push({ code: 'more_warnings_not_listed', count: list.length - 50 });
  return out;
}
