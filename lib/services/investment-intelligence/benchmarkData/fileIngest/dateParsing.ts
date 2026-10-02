// Explicit-format market-date parsing. A market date is a CALENDAR DATE, not a
// UTC timestamp. The format is always chosen by the operator: this module
// never guesses between DD/MM and MM/DD, never accepts a two-digit year, never
// truncates a timestamp, and validates the real calendar (leap years, month
// lengths).
import { excelSerialToIsoDate } from './xlsxReader';
import type { DateFormatId } from './types';

export type DateParseResult = { ok: true; iso: string } | { ok: false; code: string; message: string };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const EXCEL_FORMATS: ReadonlySet<DateFormatId> = new Set<DateFormatId>(['excel_1900', 'excel_1904']);

function fail(code: string, message: string): DateParseResult {
  return { ok: false, code, message };
}

function isDigits(s: string, min: number, max: number): boolean {
  if (s.length < min || s.length > max) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function buildIso(y: number, m: number, d: number): DateParseResult {
  if (m < 1 || m > 12) return fail('DATE_NOT_A_CALENDAR_DATE', `Month ${m} does not exist.`);
  if (d < 1 || d > daysInMonth(y, m)) {
    return fail('DATE_NOT_A_CALENDAR_DATE', `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y} is not a real calendar date.`);
  }
  if (y < 1000) return fail('DATE_NOT_A_CALENDAR_DATE', 'The year must have four digits.');
  return { ok: true, iso: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/** True when the text carries a time-of-day or a timezone. */
function looksLikeTimestamp(s: string): boolean {
  if (s.includes(':')) return true;
  // ISO date followed by T/space and a digit; or a trailing Z after a digit.
  if (s.length > 10 && (s[10] === 'T' || s[10] === 't') && isDigits(s.slice(0, 4), 4, 4)) return true;
  const last = s[s.length - 1];
  if ((last === 'Z' || last === 'z') && s.length > 1 && isDigits(s[s.length - 2], 1, 1)) return true;
  return false;
}

function serialFromString(s: string): number | null {
  if (s.length === 0) return null;
  let dot = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2e && dot < 0 && i > 0 && i < s.length - 1) dot = i;
    else if (c < 0x30 || c > 0x39) return null;
  }
  return Number(s);
}

export function parseMarketDate(
  raw: string | { excelSerial: number },
  format: DateFormatId,
  ctx: { date1904?: boolean } = {},
): DateParseResult {
  void ctx;
  const isExcel = EXCEL_FORMATS.has(format);

  if (typeof raw !== 'string') {
    if (!isExcel) {
      return fail(
        'DATE_FORMAT_MISMATCH',
        'This cell holds an Excel date, but a text date format was selected. Choose the Excel date system (1900 or 1904).',
      );
    }
    return fromSerial(raw.excelSerial, format === 'excel_1904');
  }

  const s = raw.trim();
  if (s === '') return fail('DATE_EMPTY', 'The date is empty.');

  if (isExcel) {
    const n = serialFromString(s);
    if (n === null) {
      return fail('DATE_NOT_SERIAL', `"${s.slice(0, 40)}" is not an Excel serial number; an Excel date format was selected.`);
    }
    return fromSerial(n, format === 'excel_1904');
  }

  if (looksLikeTimestamp(s)) {
    return fail(
      'DATE_IS_TIMESTAMP',
      'Market dates are calendar dates, not UTC timestamps: remove the time and timezone so the date is unambiguous.',
    );
  }
  if (serialFromString(s) !== null) {
    return fail(
      'DATE_NUMERIC_UNDER_TEXT_FORMAT',
      `"${s.slice(0, 40)}" is a bare number but a text date format (${format}) was selected. Choose an Excel date system if these are Excel serial numbers.`,
    );
  }

  switch (format) {
    case 'YYYY-MM-DD': {
      const p = s.split('-');
      if (p.length !== 3 || !isDigits(p[0], 4, 4) || !isDigits(p[1], 2, 2) || !isDigits(p[2], 2, 2)) return badFormat(s, format);
      return buildIso(Number(p[0]), Number(p[1]), Number(p[2]));
    }
    case 'DD/MM/YYYY':
      return numericDmy(s, '/', format, 'dmy');
    case 'MM/DD/YYYY':
      return numericDmy(s, '/', format, 'mdy');
    case 'DD-MM-YYYY':
      return numericDmy(s, '-', format, 'dmy');
    case 'DD-MMM-YYYY':
      return namedMonth(s, '-', format);
    case 'DD MMM YYYY':
      return namedMonth(s, ' ', format);
    default:
      return fail('DATE_FORMAT_UNKNOWN', `Unknown date format "${String(format)}".`);
  }
}

function badFormat(s: string, format: DateFormatId): DateParseResult {
  return fail('DATE_FORMAT_INVALID', `"${s.slice(0, 40)}" does not match the selected date format ${format}.`);
}

function numericDmy(s: string, sep: string, format: DateFormatId, order: 'dmy' | 'mdy'): DateParseResult {
  const p = s.split(sep);
  if (p.length !== 3 || !isDigits(p[0], 1, 2) || !isDigits(p[1], 1, 2)) return badFormat(s, format);
  if (isDigits(p[2], 1, 2)) {
    return fail('DATE_TWO_DIGIT_YEAR', 'Two-digit years are not accepted; use a four-digit year.');
  }
  if (!isDigits(p[2], 4, 4)) return badFormat(s, format);
  const a = Number(p[0]);
  const b = Number(p[1]);
  const y = Number(p[2]);
  return order === 'dmy' ? buildIso(y, b, a) : buildIso(y, a, b);
}

function namedMonth(s: string, sep: string, format: DateFormatId): DateParseResult {
  const p = s.split(sep);
  if (p.length !== 3 || !isDigits(p[0], 1, 2)) return badFormat(s, format);
  const monthKey = p[1].toLowerCase();
  const month = Object.prototype.hasOwnProperty.call(MONTHS, monthKey) ? MONTHS[monthKey] : undefined;
  if (month === undefined) {
    return fail('DATE_MONTH_NAME_INVALID', `"${p[1].slice(0, 20)}" is not an English month name (use Jan..Dec or the full name).`);
  }
  if (isDigits(p[2], 1, 2)) return fail('DATE_TWO_DIGIT_YEAR', 'Two-digit years are not accepted; use a four-digit year.');
  if (!isDigits(p[2], 4, 4)) return badFormat(s, format);
  return buildIso(Number(p[2]), month, Number(p[0]));
}

function fromSerial(serial: number, date1904: boolean): DateParseResult {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) {
    return fail('DATE_SERIAL_INVALID', 'The Excel date serial is not a finite number.');
  }
  if (!Number.isInteger(serial)) {
    return fail('DATE_IS_TIMESTAMP', 'This Excel value carries a time of day; market dates must be whole calendar dates.');
  }
  const iso = excelSerialToIsoDate(serial, date1904);
  if (iso === null) {
    return fail(
      'DATE_SERIAL_INVALID',
      !date1904 && serial === 60
        ? 'Excel serial 60 is the non-existent 1900-02-29 (a Lotus 1-2-3 compatibility bug) and is not a real date.'
        : `Excel serial ${serial} is outside the valid date range for the ${date1904 ? '1904' : '1900'} date system.`,
    );
  }
  return { ok: true, iso };
}
