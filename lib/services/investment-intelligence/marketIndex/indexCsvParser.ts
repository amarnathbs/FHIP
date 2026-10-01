// Market-index historical CSV parser and validator (Nifty 50 / BSE Sensex,
// daily closing PRICE index). PURE: no I/O, no clock (the caller supplies
// `todayIso`), fully unit-testable with a plain string.
//
// ACCEPTED LAYOUTS (header-driven, case-insensitive, any column order). Only a
// DATE column and a CLOSE column are required; an INDEX NAME column is used,
// when present, to keep only the selected index's rows and to refuse a file
// that does not contain the selected index at all.
//
//   niftyindices.com "Historical Data" export  (as publicly documented/seen):
//       Index Name,Date,Open,High,Low,Close          date e.g. "02 Jan 2024"
//   NSE daily archive ind_close_all_DDMMYYYY.csv:
//       Index Name,Index Date,Open Index Value,High Index Value,
//       Low Index Value,Closing Index Value,Points Change,Change(%),...
//                                                     date e.g. "02-01-2024"
//   BSE India index archive download:
//       Date,Open,High,Low,Close                      date e.g. "02-January-2024"
//   Generic:  date,close   (ISO yyyy-mm-dd or any of the date forms below)
//
// STATUS OF THESE LAYOUTS (honest): they are written from the publicly visible
// column conventions of those downloads; the sample fixtures in
// tests/fixtures/market-index/ are SYNTHETIC files in those shapes, not
// recordings of a live download. The parser is header-driven precisely so a
// small variation in column naming or order does not break it, and anything it
// cannot read is rejected row by row with a stated reason, never guessed.
//
// DATES. Accepted forms: yyyy-mm-dd; dd-mm-yyyy, dd/mm/yyyy, dd mm yyyy
// (DAY FIRST — the Indian convention; month-first US dates are NOT supported
// and a value that is not a real day-first calendar date is rejected);
// dd MMM yyyy, dd-MMM-yyyy, dd-MMMM-yyyy. Every date must be a real calendar
// date, not in the future, and not before 1979-01-01 (the Sensex base year).
//
// VALUES. Plain or thousands-grouped decimals ("73651.35", "73,651.35",
// "1,23,456.7"); must be finite and > 0 and inside a per-index plausibility
// band. "-", blank or text is rejected ("no closing value"). Price index CLOSE
// only: total-return series are a different product and must not be uploaded.
//
// REJECTION / HOLD-BACK RULES, each with its own stable `code`:
//   bad_date, future_date, bad_value, out_of_range, wrong_index,
//   conflicting_duplicate (same date, different close — every row of that
//   date is rejected), outlier (a spike/dip > OUTLIER_REJECT_FRACTION against
//   BOTH neighbours within 7 days). Identical duplicate rows are counted and
//   collapsed. Weekend (Sat/Sun) dates are HELD BACK, not rejected, because
//   special sessions do exist (Budget Saturday, Diwali Muhurat); they commit
//   only when the operator explicitly includes them. Moves above
//   LARGE_MOVE_WARN_FRACTION are warnings, never silent.
import type { MarketIndexKey } from '@/lib/config/investment-intelligence/marketIndexConfig';
import { MARKET_INDEX_KEYS } from '@/lib/config/investment-intelligence/marketIndexConfig';

export const INDEX_CSV_PARSER_VERSION = 'market-index-csv-v1';
export const INDEX_CSV_MAX_BYTES = 5 * 1024 * 1024;
export const INDEX_CSV_MAX_ROWS = 20_000;
export const FLOOR_DATE = '1979-01-01';
export const OUTLIER_REJECT_FRACTION = 0.25;
export const LARGE_MOVE_WARN_FRACTION = 0.1;
const NEIGHBOUR_WINDOW_DAYS = 7;

/** Plausibility bands for a daily PRICE index close, per index. Sanity only, not a market claim. */
const VALUE_BANDS: Record<MarketIndexKey, { min: number; max: number }> = {
  IN_NIFTY_50_PRI: { min: 100, max: 200_000 },
  IN_SENSEX_PRI: { min: 100, max: 2_000_000 },
};

const NAME_ALIASES: Record<MarketIndexKey, string[]> = {
  IN_NIFTY_50_PRI: ['nifty 50', 'nifty50', 'cnx nifty', 'nifty'],
  IN_SENSEX_PRI: ['sensex', 's&p bse sensex', 'bse sensex', 's&p bse sensex index', 'sp bse sensex'],
};

export type IndexCsvLayout = 'niftyindices' | 'nse_ind_close_all' | 'bse_archive' | 'generic' | 'unknown';

export type IndexCsvRejectCode = 'bad_date' | 'future_date' | 'bad_value' | 'out_of_range' | 'wrong_index' | 'conflicting_duplicate' | 'outlier' | 'too_many_rows' | 'bad_header';

export interface IndexCsvRow {
  rowNumber: number; // 1-based, header excluded
  date: string; // ISO yyyy-mm-dd
  close: number;
}

export interface IndexCsvRejected {
  rowNumber: number;
  raw: string;
  code: IndexCsvRejectCode;
  reason: string;
}

export interface IndexCsvMoveWarning {
  date: string;
  previousDate: string;
  changeFraction: number;
}

export interface IndexCsvAnalysis {
  parserVersion: typeof INDEX_CSV_PARSER_VERSION;
  indexKey: MarketIndexKey;
  layout: IndexCsvLayout;
  totalDataRows: number;
  /** Weekday rows ready to commit, unique per date, ascending. */
  accepted: IndexCsvRow[];
  /** Saturday/Sunday rows, held back unless explicitly included. */
  weekendHeldBack: IndexCsvRow[];
  rejected: IndexCsvRejected[];
  largeMoves: IndexCsvMoveWarning[];
  identicalDuplicatesCollapsed: number;
  /** Rows belonging to a different index in the same file (ignored, not errors). */
  otherIndexRowsIgnored: number;
  dateFrom: string | null;
  dateTo: string | null;
  /** True when the file as a whole cannot be used (bad header, no rows for the selected index). */
  fileRejected: boolean;
  fileRejectionReason: string | null;
}

// ---------------------------------------------------------------------------
// Minimal RFC-4180 CSV reader (quotes, escaped quotes, CRLF, BOM).
// ---------------------------------------------------------------------------
export function readCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const pad = (n: number) => String(n).padStart(2, '0');

/** Returns an ISO date, or null when the text is not a real day-first calendar date in an accepted form. */
export function parseIndexDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return isRealDate(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = /^(\d{1,2})[-/ ](\d{1,2})[-/ ](\d{4})$/.exec(s);
  if (m) return isRealDate(+m[3], +m[2], +m[1]) ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null;
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ,]+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    return mon && isRealDate(+m[3], mon, +m[1]) ? `${m[3]}-${pad(mon)}-${pad(+m[1])}` : null;
  }
  return null;
}

function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00.000Z`).getUTCDay();
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
const NUMBER_RE = /^\d{1,3}(,\d{2,3})*(\.\d+)?$|^\d+(\.\d+)?$/;
export function parseIndexValue(raw: string): number | null {
  const s = raw.trim().replace(/\s+/g, '');
  if (s === '' || s === '-' || !NUMBER_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normaliseName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------
const DATE_HEADERS = ['date', 'index date', 'trade date', 'trading date'];
const CLOSE_HEADERS = ['close', 'closing index value', 'close index value', 'closing value', 'closing', 'index close', 'close price'];
const NAME_HEADERS = ['index name', 'indexname', 'index', 'name'];

function findCol(header: string[], candidates: string[]): number {
  for (const c of candidates) {
    const at = header.indexOf(c);
    if (at >= 0) return at;
  }
  return -1;
}

function emptyAnalysis(indexKey: MarketIndexKey, layout: IndexCsvLayout, totalDataRows: number, reason: string | null): IndexCsvAnalysis {
  return {
    parserVersion: INDEX_CSV_PARSER_VERSION,
    indexKey,
    layout,
    totalDataRows,
    accepted: [],
    weekendHeldBack: [],
    rejected: [],
    largeMoves: [],
    identicalDuplicatesCollapsed: 0,
    otherIndexRowsIgnored: 0,
    dateFrom: null,
    dateTo: null,
    fileRejected: reason !== null,
    fileRejectionReason: reason,
  };
}

export function parseIndexCsv(csvText: string, indexKey: MarketIndexKey, todayIso: string): IndexCsvAnalysis {
  if (!(indexKey === MARKET_INDEX_KEYS.NIFTY_50 || indexKey === MARKET_INDEX_KEYS.SENSEX)) {
    return emptyAnalysis(indexKey, 'unknown', 0, `Unsupported index '${indexKey}'.`);
  }
  const table = readCsv(csvText);
  if (table.length === 0) return emptyAnalysis(indexKey, 'unknown', 0, 'The file is empty.');

  const header = table[0].map((h) => h.trim().toLowerCase());
  const dateCol = findCol(header, DATE_HEADERS);
  const closeCol = findCol(header, CLOSE_HEADERS);
  const nameCol = findCol(header, NAME_HEADERS);
  if (dateCol < 0 || closeCol < 0) {
    return emptyAnalysis(indexKey, 'unknown', 0, `The header row must contain a date column (one of: ${DATE_HEADERS.join(', ')}) and a closing-value column (one of: ${CLOSE_HEADERS.join(', ')}). Found: ${table[0].map((h) => h.trim()).join(', ')}.`);
  }
  const layout: IndexCsvLayout =
    nameCol >= 0 && header[closeCol] === 'closing index value' ? 'nse_ind_close_all'
    : nameCol >= 0 ? 'niftyindices'
    : header.includes('open') && header.includes('high') && header.includes('low') ? 'bse_archive'
    : 'generic';

  const dataRows = table.slice(1);
  if (dataRows.length > INDEX_CSV_MAX_ROWS) {
    return emptyAnalysis(indexKey, layout, dataRows.length, `The file has ${dataRows.length} data rows; the limit is ${INDEX_CSV_MAX_ROWS}. Split it into several files.`);
  }

  const result = emptyAnalysis(indexKey, layout, dataRows.length, null);
  const aliases = NAME_ALIASES[indexKey];
  const band = VALUE_BANDS[indexKey];
  const distinctOtherNames = new Set<string>();
  const byDate = new Map<string, Array<IndexCsvRow & { raw: string }>>();

  dataRows.forEach((cols, idx) => {
    const rowNumber = idx + 1;
    const raw = cols.join(',');
    if (nameCol >= 0) {
      const name = normaliseName(cols[nameCol] ?? '');
      if (!aliases.includes(name)) {
        result.otherIndexRowsIgnored += 1;
        if (distinctOtherNames.size < 6) distinctOtherNames.add((cols[nameCol] ?? '').trim());
        return;
      }
    }
    const date = parseIndexDate(cols[dateCol] ?? '');
    if (!date) {
      result.rejected.push({ rowNumber, raw, code: 'bad_date', reason: `Date '${(cols[dateCol] ?? '').trim()}' is not a real day-first calendar date in an accepted format.` });
      return;
    }
    if (date > todayIso) {
      result.rejected.push({ rowNumber, raw, code: 'future_date', reason: `Date ${date} is in the future (today is ${todayIso}).` });
      return;
    }
    if (date < FLOOR_DATE) {
      result.rejected.push({ rowNumber, raw, code: 'bad_date', reason: `Date ${date} is before ${FLOOR_DATE}.` });
      return;
    }
    const close = parseIndexValue(cols[closeCol] ?? '');
    if (close === null) {
      result.rejected.push({ rowNumber, raw, code: 'bad_value', reason: `Closing value '${(cols[closeCol] ?? '').trim()}' is missing or not a plain number (a "-" means no close was published).` });
      return;
    }
    if (close < band.min || close > band.max) {
      result.rejected.push({ rowNumber, raw, code: 'out_of_range', reason: `Closing value ${close} is outside the plausible range ${band.min}-${band.max} for this index. Check you selected the right index.` });
      return;
    }
    byDate.set(date, [...(byDate.get(date) ?? []), { rowNumber, date, close, raw }]);
  });

  if (nameCol >= 0 && result.otherIndexRowsIgnored > 0 && byDate.size === 0 && result.rejected.length === 0) {
    return {
      ...result,
      fileRejected: true,
      fileRejectionReason: `No rows for the selected index were found. The file contains: ${[...distinctOtherNames].join(', ')}.`,
      rejected: [{ rowNumber: 0, raw: '', code: 'wrong_index', reason: 'The file does not contain the selected index.' }],
    };
  }

  // Duplicates by date.
  const unique: IndexCsvRow[] = [];
  for (const [date, rows] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const closes = rows.map((r) => r.close);
    const allSame = closes.every((c) => Math.abs(c - closes[0]) < 1e-6);
    if (!allSame) {
      for (const r of rows) result.rejected.push({ rowNumber: r.rowNumber, raw: r.raw, code: 'conflicting_duplicate', reason: `Date ${date} appears ${rows.length} times with different closing values (${closes.join(', ')}); none of them is used.` });
      continue;
    }
    result.identicalDuplicatesCollapsed += rows.length - 1;
    unique.push({ rowNumber: rows[0].rowNumber, date, close: rows[0].close });
  }

  // Outliers (spikes/dips) and large-move warnings, on the date-ordered series.
  const kept: IndexCsvRow[] = [];
  for (let i = 0; i < unique.length; i++) {
    const cur = unique[i];
    const prev = i > 0 && daysBetween(unique[i - 1].date, cur.date) <= NEIGHBOUR_WINDOW_DAYS ? unique[i - 1] : null;
    const next = i < unique.length - 1 && daysBetween(cur.date, unique[i + 1].date) <= NEIGHBOUR_WINDOW_DAYS ? unique[i + 1] : null;
    const dPrev = prev ? Math.abs(cur.close / prev.close - 1) : null;
    const dNext = next ? Math.abs(cur.close / next.close - 1) : null;
    if (dPrev !== null && dNext !== null && dPrev > OUTLIER_REJECT_FRACTION && dNext > OUTLIER_REJECT_FRACTION) {
      result.rejected.push({ rowNumber: cur.rowNumber, raw: `${cur.date},${cur.close}`, code: 'outlier', reason: `Closing value ${cur.close} on ${cur.date} differs by more than ${OUTLIER_REJECT_FRACTION * 100}% from both the previous and the next session; it looks like a data error and is not used.` });
      continue;
    }
    kept.push(cur);
  }
  for (let i = 1; i < kept.length; i++) {
    if (daysBetween(kept[i - 1].date, kept[i].date) > NEIGHBOUR_WINDOW_DAYS) continue;
    const change = kept[i].close / kept[i - 1].close - 1;
    if (Math.abs(change) > LARGE_MOVE_WARN_FRACTION) result.largeMoves.push({ date: kept[i].date, previousDate: kept[i - 1].date, changeFraction: change });
  }

  for (const r of kept) {
    const dow = dayOfWeek(r.date);
    if (dow === 0 || dow === 6) result.weekendHeldBack.push(r);
    else result.accepted.push(r);
  }
  const all = [...result.accepted, ...result.weekendHeldBack].map((r) => r.date).sort();
  result.dateFrom = all[0] ?? null;
  result.dateTo = all[all.length - 1] ?? null;
  if (result.accepted.length === 0 && result.weekendHeldBack.length === 0) {
    result.fileRejected = true;
    result.fileRejectionReason = 'No usable rows were found in the file.';
  }
  return result;
}
