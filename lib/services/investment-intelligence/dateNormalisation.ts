// Investment Intelligence R2 — CAS date normalisation (spec section 14).
//
// Only formats ACTUALLY OBSERVED in the supported CAMS/KFintech golden
// fixtures are handled — no speculative format is added un-tested. Indian
// CAS statements are DD-first; this module never treats an ambiguous
// "01/02/2025"-shaped string as MM/DD/YYYY.

export interface ParsedStatementDate {
  ok: true;
  iso: string; // YYYY-MM-DD
}
export interface ParsedStatementDateError {
  ok: false;
  error: string;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Parse a CAS statement date string into an ISO (YYYY-MM-DD) date.
 * Supported, explicitly-tested formats:
 *  - "DD-MMM-YYYY"  e.g. "01-Feb-2025"  (CAMS transaction-line convention)
 *  - "DD-MMM-YY"    e.g. "01-Feb-25"
 *  - "DD/MM/YYYY"   e.g. "01/02/2025"   (KFintech convention) — NEVER MM/DD
 *  - "DD-MM-YYYY"   e.g. "01-02-2025"
 *  - "YYYY-MM-DD"   already-ISO (passthrough, still validated)
 */
export function parseStatementDate(raw: string): ParsedStatementDate | ParsedStatementDateError {
  if (!raw) return { ok: false, error: 'Empty date value' };
  const s = raw.trim();

  // YYYY-MM-DD (already ISO)
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    if (!isValidCalendarDate(year, month, day)) return { ok: false, error: `Invalid calendar date: "${raw}"` };
    return { ok: true, iso: `${y}-${mo}-${d}` };
  }

  // DD-MMM-YYYY or DD-MMM-YY
  m = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/.exec(s);
  if (m) {
    const [, dRaw, monName, yRaw] = m;
    const month = MONTHS[monName.slice(0, 3).toLowerCase()];
    if (!month) return { ok: false, error: `Unrecognised month name in date: "${raw}"` };
    const day = Number(dRaw);
    let year = Number(yRaw);
    if (yRaw.length === 2) year += year <= 69 ? 2000 : 1900; // 2-digit year window, matching common CAS convention
    if (!isValidCalendarDate(year, month, day)) return { ok: false, error: `Invalid calendar date: "${raw}"` };
    return { ok: true, iso: `${year}-${pad2(month)}-${pad2(day)}` };
  }

  // DD/MM/YYYY or DD-MM-YYYY — DD-first, always. Never interpreted as MM/DD.
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) {
    const [, dRaw, moRaw, yRaw] = m;
    const day = Number(dRaw);
    const month = Number(moRaw);
    const year = Number(yRaw);
    if (!isValidCalendarDate(year, month, day)) return { ok: false, error: `Invalid calendar date: "${raw}"` };
    return { ok: true, iso: `${year}-${pad2(month)}-${pad2(day)}` };
  }

  return { ok: false, error: `Unrecognised date format: "${raw}"` };
}

export function isoDateDaysBetween(isoA: string, isoB: string): number {
  const a = new Date(`${isoA}T00:00:00Z`).getTime();
  const b = new Date(`${isoB}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}
