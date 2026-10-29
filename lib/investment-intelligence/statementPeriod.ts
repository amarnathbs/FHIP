// The "Statement period" line on a statement's detail panel (29-10-2026, Product Owner standing date rule).
//
// PURE. It used to print the stored ISO dates and a bare "?" ("Statement period: ? to 2026-10-22"). A user-visible date is never ISO or
// US order: the caller passes the shared formatter (fmtDate, dd-mm-yyyy for India, dd/mm/yyyy for Australia). An unknown end is
// said in words, never as "?".
export function describeStatementPeriod(start: string | null | undefined, end: string | null | undefined, fmt: (iso: string) => string): string | null {
  const s = start ? fmt(start) : null;
  const e = end ? fmt(end) : null;
  if (s && e) return `Statement period: ${s} to ${e}`;
  if (e) return `Statement period: up to ${e} (start date not stated)`;
  if (s) return `Statement period: from ${s} (end date not stated)`;
  return null;
}
