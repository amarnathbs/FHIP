/**
 * Paging text of the statement-lines table (2026-10-29). The control must say it moves by PAGE, and the status line says
 * exactly which lines are shown. (Dates for these screens: lib/engines/statementDisplayDate.ts.)
 */

export interface LinesPageSummary {
  pages: number;
  /** "Page 2 of 4, lines 101 to 200 of 341" */
  text: string;
}

/** What the lines table shows now. `page` is the page the server returned. */
export function linesPageSummary(page: number, pageSize: number, total: number): LinesPageSummary {
  const size = Math.max(1, pageSize);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  if (total === 0) return { pages, text: 'No lines' };
  const first = (current - 1) * size + 1;
  const last = Math.min(current * size, total);
  return { pages, text: `Page ${current} of ${pages}, lines ${first} to ${last} of ${total}` };
}
