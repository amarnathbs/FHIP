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
] as const;
export type SupportedDateFormat = (typeof SUPPORTED_DATE_FORMATS)[number];

export interface DateParseResult {
  ok: boolean;
  /** ISO YYYY-MM-DD, only when ok. */
  iso: string | null;
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
    default:
      return fail;
  }
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
