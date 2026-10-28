/**
 * R7 — Bank CSV Engine: deterministic date parsing (spec sections 27-28).
 *
 * NEVER browser/locale-guess a date. `parseDateWithFormat()` takes an
 * EXPLICIT format string — proven by the adapter's detection evidence or by
 * the user's confirmed mapping — and only that interpretation is ever
 * applied. `01/02/2026` is parsed as 1 Feb 2026 under 'DD/MM/YYYY' and as
 * 2 Jan 2026 under 'MM/DD/YYYY'; this module never chooses between them
 * itself.
 */

export const SUPPORTED_DATE_FORMATS = [
  'DD/MM/YYYY',
  'D/M/YYYY',
  'MM/DD/YYYY',
  'YYYY-MM-DD',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  // FDH-5 ADDITION (spec section 28): AU/India bank PDF statements commonly
  // print month-name dates ("10 Aug 2026", "10-Aug-2026") that no CSV export
  // R7/FDH-4 certified ever used, so no PDF-only parallel date module is
  // created — this shared module is EXTENDED additively instead (spec
  // section 3's "reuse it" principle applies to shared utilities, not only
  // to the dedup/reconciliation engines). No existing format's behaviour
  // changes; `inferDateFormat()` (CSV auto-detection only) intentionally does
  // NOT gain these two candidates — PDF adapters supply their date format
  // explicitly from certified evidence (spec 27), exactly like a CSV
  // adapter's own `dateFormat` field, never by locale-guessing.
  'DD-Mon-YYYY',
  'DD Mon YYYY',
  // 2026-10-28 (bank CSV column-mapping step): formats a person can pick when their bank's export is not a recognised layout.
  // Each names its day/month order explicitly. 'DD/MM/YY' is day-first; there is deliberately NO 'MM/DD/YY'.
  'DD/MM/YY',
  // Month spelled out, full name or three-letter abbreviation: "30 June 2026", "30 Jun 2026".
  'D MMMM YYYY',
  // A time of day, a weekday name, then the date with the month spelled out: "12:00am Tue 30 June, 2026". The time and the weekday
  // are read and checked for shape, never used: the date is the day, month name and year.
  'h:mma ddd D MMMM, YYYY',
] as const;
export type SupportedDateFormat = (typeof SUPPORTED_DATE_FORMATS)[number];

const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export interface DateParseResult {
  ok: boolean;
  /** ISO YYYY-MM-DD, only when ok. */
  iso: string | null;
}

const FULL_MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const FULL_WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** A month written as a word: the full name ("June") or its standard abbreviation ("Jun", "Sept"). Anything else is not a month. */
function monthFromWord(word: string): number | null {
  const w = word.toLowerCase();
  const full = FULL_MONTH_NAMES.indexOf(w);
  if (full !== -1) return full + 1;
  return MONTH_ABBREVIATIONS[w] ?? null;
}

function isWeekdayWord(word: string): boolean {
  const w = word.toLowerCase().replace(/\.$/, '');
  return WEEKDAY_NAMES.includes(w) || w === 'tues' || w === 'thur' || w === 'thurs' || FULL_WEEKDAY_NAMES.includes(w);
}

/** True calendar validity — rejects 31 Feb, 13th month, etc. rather than
 * letting JS `Date` silently roll over (e.g. `new Date(2026, 1, 30)` becomes
 * 2 March). */
function isValidCalendarDate(year: number, month1to12: number, day: number): boolean {
  if (month1to12 < 1 || month1to12 > 12) return false;
  if (day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month1to12 - 1];
}
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parses `raw` under exactly the given format. Returns `{ ok: false }` for
 * anything that does not cleanly match — including a syntactically-plausible
 * but calendrically-impossible date (spec 91: "ambiguous date silently
 * guessed" is a FAIL condition; refusing is always safer than guessing).
 */
export function parseDateWithFormat(raw: string, format: SupportedDateFormat): DateParseResult {
  const s = raw.trim();
  const fail: DateParseResult = { ok: false, iso: null };
  if (!s) return fail;

  switch (format) {
    case 'YYYY-MM-DD': {
      const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (!m) return fail;
      const [, y, mo, d] = m.map(Number) as unknown as [number, number, number, number];
      return isValidCalendarDate(y, mo, d) ? { ok: true, iso: toIso(y, mo, d) } : fail;
    }
    case 'DD/MM/YYYY':
    case 'D/M/YYYY': {
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return fail;
      const day = Number(m[1]);
      const month = Number(m[2]);
      const year = Number(m[3]);
      return isValidCalendarDate(year, month, day) ? { ok: true, iso: toIso(year, month, day) } : fail;
    }
    case 'MM/DD/YYYY': {
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return fail;
      const month = Number(m[1]);
      const day = Number(m[2]);
      const year = Number(m[3]);
      return isValidCalendarDate(year, month, day) ? { ok: true, iso: toIso(year, month, day) } : fail;
    }
    case 'DD-MM-YYYY': {
      const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      if (!m) return fail;
      const day = Number(m[1]);
      const month = Number(m[2]);
      const year = Number(m[3]);
      return isValidCalendarDate(year, month, day) ? { ok: true, iso: toIso(year, month, day) } : fail;
    }
    case 'DD.MM.YYYY': {
      const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (!m) return fail;
      const day = Number(m[1]);
      const month = Number(m[2]);
      const year = Number(m[3]);
      return isValidCalendarDate(year, month, day) ? { ok: true, iso: toIso(year, month, day) } : fail;
    }
    case 'DD-Mon-YYYY': {
      const m = s.match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/);
      if (!m) return fail;
      const day = Number(m[1]);
      const month = MONTH_ABBREVIATIONS[m[2].toLowerCase()];
      const year = Number(m[3]);
      if (!month) return fail;
      return isValidCalendarDate(year, month, day) ? { ok: true, iso: toIso(year, month, day) } : fail;
    }
    case 'DD Mon YYYY': {
      const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})$/);
      if (!m) return fail;
      const day = Number(m[1]);
      const month = MONTH_ABBREVIATIONS[m[2].toLowerCase()];
      const year = Number(m[3]);
      if (!month) return fail;
      return isValidCalendarDate(year, month, day) ? { ok: true, iso: toIso(year, month, day) } : fail;
    }
    case 'DD/MM/YY': {
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      if (!m) return fail;
      const day = Number(m[1]);
      const month = Number(m[2]);
      // Two-digit years: 00-69 are 2000-2069, 70-99 are 1970-1999 (a bank statement is never from the future century).
      const yy = Number(m[3]);
      const year = yy <= 69 ? 2000 + yy : 1900 + yy;
      return isValidCalendarDate(year, month, day) ? { ok: true, iso: toIso(year, month, day) } : fail;
    }
    case 'D MMMM YYYY': {
      const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
      if (!m) return fail;
      const day = Number(m[1]);
      const month = monthFromWord(m[2]);
      const year = Number(m[3]);
      if (!month) return fail;
      return isValidCalendarDate(year, month, day) ? { ok: true, iso: toIso(year, month, day) } : fail;
    }
    case 'h:mma ddd D MMMM, YYYY': {
      const m = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)\s+([A-Za-z]{3,9}\.?)\s+(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/i);
      if (!m) return fail;
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      if (hour < 1 || hour > 12 || minute > 59) return fail;
      if (!isWeekdayWord(m[4])) return fail;
      const day = Number(m[5]);
      const month = monthFromWord(m[6]);
      const year = Number(m[7]);
      if (!month) return fail;
      return isValidCalendarDate(year, month, day) ? { ok: true, iso: toIso(year, month, day) } : fail;
    }
    default:
      return fail;
  }
}

/** What a person is shown when choosing how their file writes dates. Day-first wording; the order is always stated. */
export const DATE_FORMAT_LABELS: Record<SupportedDateFormat, string> = {
  'DD/MM/YYYY': 'Day/Month/Year, like 30/06/2026',
  'D/M/YYYY': 'Day/Month/Year, like 3/6/2026',
  'MM/DD/YYYY': 'Month/Day/Year (US order), like 06/30/2026',
  'YYYY-MM-DD': 'Year-Month-Day, like 2026-06-30',
  'DD-MM-YYYY': 'Day-Month-Year, like 30-06-2026',
  'DD.MM.YYYY': 'Day.Month.Year, like 30.06.2026',
  'DD-Mon-YYYY': 'Day-Month name-Year, like 30-Jun-2026',
  'DD Mon YYYY': 'Day Month name Year, like 30 Jun 2026',
  'DD/MM/YY': 'Day/Month/two-digit Year, like 30/06/26',
  'D MMMM YYYY': 'Day Month name Year, like 30 June 2026',
  'h:mma ddd D MMMM, YYYY': 'Time, weekday, day, month name, year, like 12:00am Tue 30 June, 2026',
};

/**
 * Every supported format that reads EVERY non-empty sample, grouped by what it makes of them: formats that give the same date for every
 * sample (D/M/YYYY and DD/MM/YYYY) are one group. One group = the values themselves prove the reading (a date written as "30 June, 2026"
 * has only one). More than one group = the same text means different days under different orders (01/02/2026), so the person must say
 * which; nothing here chooses. No group = no supported format reads these values.
 */
export function dateFormatCandidates(samples: readonly string[]): { groups: SupportedDateFormat[][]; proven: SupportedDateFormat | null } {
  const nonEmpty = samples.map((x) => x.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return { groups: [], proven: null };
  const bySignature = new Map<string, SupportedDateFormat[]>();
  for (const format of SUPPORTED_DATE_FORMATS) {
    const results = nonEmpty.map((x) => parseDateWithFormat(x, format));
    if (!results.every((r) => r.ok)) continue;
    const signature = results.map((r) => r.iso).join('|');
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), format]);
  }
  const groups = [...bySignature.values()];
  return { groups, proven: groups.length === 1 ? groups[0][0] : null };
}

/**
 * Format-INFERENCE for detection evidence only (spec 20) — never used to
 * actually parse a canonical date. Given a sample of raw date strings, scores
 * each candidate format by how many samples it can parse AND, for the
 * ambiguous DD/MM vs MM/DD case, whether any sample proves one interpretation
 * impossible under the other (e.g. "13/02/2026" proves DD/MM — no month 13).
 * Returns the format with the highest, UNAMBIGUOUS score, or null.
 */
export function inferDateFormat(samples: readonly string[]): { format: SupportedDateFormat; confidence: number } | null {
  const candidates: SupportedDateFormat[] = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY'];
  const nonEmpty = samples.filter((s) => s.trim());
  if (nonEmpty.length === 0) return null;

  const scored = candidates.map((format) => {
    const parsed = nonEmpty.map((s) => parseDateWithFormat(s, format));
    const okCount = parsed.filter((p) => p.ok).length;
    return { format, score: okCount / nonEmpty.length };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 1) return null;

  // Disambiguate DD/MM vs MM/DD: if a second candidate also scores 1.0 with
  // the same slash structure, only resolve if at least one sample proves one
  // impossible under the other (day or month > 12).
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.score === best.score && runnerUp.format !== best.format) {
    const proofSample = nonEmpty.find((s) => {
      const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
      if (!m) return false;
      const a = Number(m[1]);
      const b = Number(m[2]);
      return a > 12 || b > 12;
    });
    if (!proofSample) return null; // genuinely ambiguous — AMBIGUOUS, never guessed
  }

  return { format: best.format, confidence: best.score };
}
