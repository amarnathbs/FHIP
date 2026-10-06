// Date helpers for the Planning Benchmarks upload. Pure.
//
// Inside an uploaded FILE a date is machine data: the database order (year first, dashes) is the primary
// form, day-first dd/mm/yyyy and dd-mm-yyyy are also accepted (a CSV saved from an Australian or Indian
// Excel contains them), and a real Excel date cell is accepted. Month-first and two-digit years are never
// accepted. Everything a PERSON reads goes through formatDayFirst (dayFirst.ts).
import { excelSerialToIsoDate } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';

export { formatDayFirst, formatDayFirstDateTime, todayIsoUtc } from './dayFirst';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_FIRST = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

export function isRealDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Parse text from a file cell to the database date form. Returns null when it is not an accepted real date. */
export function parseFileDateText(raw: string): string | null {
  const s = raw.trim();
  let m = ISO.exec(s);
  if (m) return isRealDate(+m[1], +m[2], +m[3]) ? s : null;
  m = DAY_FIRST.exec(s);
  if (m) return isRealDate(+m[3], +m[2], +m[1]) ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null;
  return null;
}

export function parseExcelSerialDate(serial: number, date1904: boolean): string | null {
  return excelSerialToIsoDate(serial, date1904);
}
