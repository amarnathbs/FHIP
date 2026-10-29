/**
 * Deterministic reading of a FULL printed calendar date (day, month and a four-digit year) at the START of a string or a text line.
 * (28-10-2026, production: a NAB statement prints the date only on the first transaction of a day, so a part of the statement that
 * starts at the top of a page begins with undated transaction lines.)
 *
 * What it accepts: "3 Sep 2025", "03 September 2025", "Sep 3, 2025", "03/09/2025", "3.9.2025", "3-9-2025" (DAY-FIRST, this
 * codebase's rule for AU and India), and "2025-09-03". What it never does: guess a year ("3 Sep" has none), guess an order (a
 * numeric date whose second number is over 12 is not a day-first date, so it is refused), or accept an impossible date (31 Feb).
 * Returns the ISO date, or null.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function monthFromName(name: string): number | null {
  const key = name.slice(0, 3).toLowerCase();
  const full = name.toLowerCase();
  // "Sept" is common; anything else must be a plausible prefix of the full month name (no "Marketing 2025").
  const known = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const idx = known.findIndex((m) => m.startsWith(full) && full.length >= 3);
  if (idx >= 0) return idx + 1;
  if (full === 'sept') return 9;
  return key in MONTHS && full.length === 3 ? MONTHS[key] : null;
}

function iso(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The full printed date a string STARTS with (leading spaces allowed), as ISO; null if it does not start with one. */
export function leadingPrintedDate(text: string): { iso: string; printed: string } | null {
  const s = text.replace(/^\s+/, '');
  let m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(s);
  if (m) {
    const v = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    return v ? { iso: v, printed: m[0] } : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/.exec(s);
  if (m) {
    const v = iso(Number(m[3]), Number(m[2]), Number(m[1]));
    return v ? { iso: v, printed: m[0] } : null;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?!\d)/.exec(s);
  if (m) {
    const mo = monthFromName(m[2]);
    const v = mo ? iso(Number(m[3]), mo, Number(m[1])) : null;
    return v ? { iso: v, printed: m[0] } : null;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?!\d)/.exec(s);
  if (m) {
    const mo = monthFromName(m[1]);
    const v = mo ? iso(Number(m[3]), mo, Number(m[2])) : null;
    return v ? { iso: v, printed: m[0] } : null;
  }
  return null;
}
