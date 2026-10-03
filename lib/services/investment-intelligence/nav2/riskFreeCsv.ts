// NAV2 Stage 2 -- the risk-free CSV reader and validator (the Product Owner's first-load format and every later
// admin upload). PURE: no I/O, no clock (the caller supplies `todayIso`).
//
// FORMAT (header-driven, case-insensitive, any column order):
//   required  series_id, observation_date, value_percent, source_document, retrieved_on
//   optional  frequency, source_url, notes, kind, gap_reason
//   One file = ONE series (the series chosen on the screen). `series_id` in every row must match it, and
//   `frequency`, when present, must match the series cadence (weekly_auction / policy_change).
//   A GAP row (an auction with no accepted bids, or none held) has an empty value_percent and a gap_reason
//   (no_accepted_bids | no_auction_held); it explains a missing week and is never a rate.
//
// DATES. yyyy-mm-dd, or day-first dd-mm-yyyy / dd/mm/yyyy (month-first is NOT supported). Every date must be a
// real calendar date. An observation may not be dated after its own retrieved_on (a future-dated rate) nor after today.
// VALUES. Percent as published, 0 to 100, at most 4 decimals (the storage precision): a value with more decimals
// would be silently rounded, so it is rejected. Basis-point or decimal-fraction mistakes are caught by the range and
// by the large-move warning below.
//
// Rejections carry a stable code and a plain message; nothing is guessed or repaired. WARNINGS never block but are
// always shown: a weekly move above 1.5 percentage points, a weekly series with a hole of more than 14 days.

import { parseIndexDate, readCsv } from '../marketIndex/indexCsvParser';

export const RISK_FREE_CSV_PARSER_VERSION = 'risk-free-csv-v1';
export const RISK_FREE_CSV_MAX_BYTES = 2 * 1024 * 1024;
/** Matches the database function's own limit. */
export const RISK_FREE_CSV_MAX_ROWS = 5000;
export const RISK_FREE_LARGE_MOVE_PERCENT_POINTS = 1.5;
export const RISK_FREE_WEEKLY_HOLE_DAYS = 14;
const EARLIEST_DATE = '1950-01-01';

export type RiskFreeCsvRejectCode =
  | 'bad_header'
  | 'too_many_rows'
  | 'wrong_series'
  | 'wrong_frequency'
  | 'bad_date'
  | 'bad_retrieved_on'
  | 'future_date'
  | 'bad_value'
  | 'too_many_decimals'
  | 'out_of_range'
  | 'missing_source_document'
  | 'gap_without_reason'
  | 'gap_with_value'
  | 'bad_gap_reason'
  | 'conflicting_duplicate';

export interface RiskFreeCsvRow {
  date: string;
  kind: 'value' | 'gap';
  value_percent: number | null;
  gap_reason: 'no_accepted_bids' | 'no_auction_held' | null;
  source_document: string;
  source_url: string | null;
  retrieved_on: string;
  notes: string | null;
}

export interface RiskFreeCsvRejected {
  /** 1-based line number in the file (the header is line 1). */
  line: number;
  date: string | null;
  code: RiskFreeCsvRejectCode;
  message: string;
}

export interface RiskFreeCsvAnalysis {
  version: typeof RISK_FREE_CSV_PARSER_VERSION;
  seriesId: string;
  totalDataRows: number;
  accepted: RiskFreeCsvRow[];
  rejected: RiskFreeCsvRejected[];
  warnings: string[];
  dateFrom: string | null;
  dateTo: string | null;
  fileRejected: boolean;
  fileRejectionReason: string | null;
}

/** dd-mm-yyyy for user-visible text (PO date rule). */
export const dmy = (iso: string): string => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

const HEADERS = {
  seriesId: ['series_id', 'series'],
  date: ['observation_date', 'date'],
  value: ['value_percent', 'value', 'yield_percent'],
  frequency: ['frequency', 'cadence'],
  doc: ['source_document', 'source'],
  url: ['source_url', 'url'],
  retrieved: ['retrieved_on', 'retrieved'],
  notes: ['notes', 'note'],
  kind: ['kind'],
  gapReason: ['gap_reason'],
} as const;

function findCol(header: string[], names: readonly string[]): number {
  return header.findIndex((h) => names.includes(h.trim().toLowerCase()));
}

const VALUE_RE = /^\d+(\.\d+)?$/;

function empty(seriesId: string, reason: string, total = 0): RiskFreeCsvAnalysis {
  return { version: RISK_FREE_CSV_PARSER_VERSION, seriesId, totalDataRows: total, accepted: [], rejected: [], warnings: [], dateFrom: null, dateTo: null, fileRejected: true, fileRejectionReason: reason };
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);

export function parseRiskFreeCsv(csvText: string, seriesId: string, cadence: 'weekly_auction' | 'policy_change', todayIso: string): RiskFreeCsvAnalysis {
  const rows = readCsv(csvText);
  if (rows.length === 0) return empty(seriesId, 'The file is empty.');
  const header = rows[0];
  const col = Object.fromEntries(Object.entries(HEADERS).map(([k, names]) => [k, findCol(header, names)])) as Record<keyof typeof HEADERS, number>;
  const missing = (['seriesId', 'date', 'value', 'doc', 'retrieved'] as const).filter((k) => col[k] < 0).map((k) => HEADERS[k][0]);
  if (missing.length > 0) return empty(seriesId, `The header is missing required column(s): ${missing.join(', ')}.`, rows.length - 1);
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) return empty(seriesId, 'The file has a header but no data rows.');
  if (dataRows.length > RISK_FREE_CSV_MAX_ROWS) return empty(seriesId, `The file has ${dataRows.length} data rows; the limit is ${RISK_FREE_CSV_MAX_ROWS}. Split it into several files.`, dataRows.length);

  const rejected: RiskFreeCsvRejected[] = [];
  const candidates: Array<RiskFreeCsvRow & { line: number }> = [];

  dataRows.forEach((r, idx) => {
    const line = idx + 2;
    const get = (c: number): string => (c >= 0 ? (r[c] ?? '').trim() : '');
    const rawDate = get(col.date);
    const reject = (code: RiskFreeCsvRejectCode, message: string, date: string | null = null): void => {
      rejected.push({ line, date: date ?? (rawDate || null), code, message });
    };

    if (get(col.seriesId) !== seriesId) return reject('wrong_series', `The series is "${get(col.seriesId) || 'blank'}" but this upload is for ${seriesId}.`);
    const freq = get(col.frequency);
    if (col.frequency >= 0 && freq !== '' && freq !== cadence) return reject('wrong_frequency', `The frequency is "${freq}" but ${seriesId} is ${cadence}.`);

    const date = parseIndexDate(rawDate);
    if (!date || date < EARLIEST_DATE) return reject('bad_date', 'The date on this line is not a real calendar date (use yyyy-mm-dd or day-first dd-mm-yyyy).');
    const retrieved = parseIndexDate(get(col.retrieved));
    if (!retrieved) return reject('bad_retrieved_on', `The retrieved_on value "${get(col.retrieved)}" is not a real date.`, date);
    if (date > retrieved || date > todayIso || retrieved > todayIso) return reject('future_date', `${dmy(date)} is dated after it was retrieved (${dmy(retrieved)}) or after today: a future-dated rate is never accepted.`, date);
    const doc = get(col.doc);
    if (doc === '') return reject('missing_source_document', 'Every row must name the RBI publication it was read from (source_document).', date);

    const rawKind = get(col.kind).toLowerCase();
    const rawValue = get(col.value);
    const gapReason = get(col.gapReason).toLowerCase();
    const isGap = rawKind === 'gap' || (rawValue === '' && gapReason !== '');
    let kind: 'value' | 'gap' = 'value';
    let value: number | null = null;
    let reason: RiskFreeCsvRow['gap_reason'] = null;
    if (isGap) {
      kind = 'gap';
      if (rawValue !== '') return reject('gap_with_value', 'A gap row (no accepted bids / no auction) must not carry a rate.', date);
      if (gapReason === '') return reject('gap_without_reason', 'A gap row needs a gap_reason (no_accepted_bids or no_auction_held).', date);
      if (gapReason !== 'no_accepted_bids' && gapReason !== 'no_auction_held') return reject('bad_gap_reason', `gap_reason "${gapReason}" is not one of no_accepted_bids, no_auction_held.`, date);
      reason = gapReason;
    } else {
      if (!VALUE_RE.test(rawValue)) return reject('bad_value', `"${rawValue}" is not a plain percent number.`, date);
      const decimals = (rawValue.split('.')[1] ?? '').length;
      if (decimals > 4) return reject('too_many_decimals', `${rawValue} has more than 4 decimal places; it would be silently rounded in storage, so the file must be corrected.`, date);
      value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0 || value > 100) return reject('out_of_range', `${rawValue} is outside the plausible 0 to 100 percent range (a decimal fraction or basis points?).`, date);
    }
    candidates.push({ line, date, kind, value_percent: value, gap_reason: reason, source_document: doc, source_url: get(col.url) || null, retrieved_on: retrieved, notes: get(col.notes) || null });
  });

  // Duplicates: identical rows collapse; different rows for one date are ALL rejected.
  const byDate = new Map<string, Array<RiskFreeCsvRow & { line: number }>>();
  for (const c of candidates) byDate.set(c.date, [...(byDate.get(c.date) ?? []), c]);
  const accepted: RiskFreeCsvRow[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date)!;
    const distinct = new Set(list.map((c) => `${c.kind}|${c.value_percent}`));
    if (distinct.size > 1) {
      for (const c of list) rejected.push({ line: c.line, date, code: 'conflicting_duplicate', message: `${dmy(date)} appears more than once with different values; none of its rows is used.` });
      continue;
    }
    const { line: _line, ...row } = list[0];
    void _line;
    accepted.push(row);
  }
  rejected.sort((a, b) => a.line - b.line);

  const warnings: string[] = [];
  const values = accepted.filter((r) => r.kind === 'value');
  if (cadence === 'weekly_auction') {
    const bigMoves = values.filter((r, i) => i > 0 && Math.abs((r.value_percent as number) - (values[i - 1].value_percent as number)) > RISK_FREE_LARGE_MOVE_PERCENT_POINTS);
    if (bigMoves.length > 0) warnings.push(`${bigMoves.length} week-on-week move(s) above ${RISK_FREE_LARGE_MOVE_PERCENT_POINTS} percentage points are included (first: ${dmy(bigMoves[0].date)}); please check them against the source.`);
    let holes = 0;
    let firstHole: string | null = null;
    for (let i = 1; i < accepted.length; i++) {
      if (daysBetween(accepted[i - 1].date, accepted[i].date) > RISK_FREE_WEEKLY_HOLE_DAYS) {
        holes += 1;
        firstHole ??= accepted[i - 1].date;
      }
    }
    if (holes > 0) warnings.push(`${holes} stretch(es) of more than ${RISK_FREE_WEEKLY_HOLE_DAYS} days with no weekly observation (first after ${dmy(firstHole as string)}). A calculation across such a stretch uses the last earlier value only while it is still fresh, otherwise it reports the rate as unavailable.`);
  } else {
    const unchanged = values.filter((r, i) => i > 0 && r.value_percent === values[i - 1].value_percent);
    if (unchanged.length > 0) warnings.push(`${unchanged.length} policy-change row(s) repeat the previous rate (first: ${dmy(unchanged[0].date)}); a policy-change series lists changes only.`);
  }
  if (rejected.length > 0) warnings.push(`${rejected.length} row(s) were rejected and will not be written (see the reasons).`);

  return {
    version: RISK_FREE_CSV_PARSER_VERSION,
    seriesId,
    totalDataRows: dataRows.length,
    accepted,
    rejected,
    warnings,
    dateFrom: accepted.length ? accepted[0].date : null,
    dateTo: accepted.length ? accepted[accepted.length - 1].date : null,
    fileRejected: false,
    fileRejectionReason: null,
  };
}
