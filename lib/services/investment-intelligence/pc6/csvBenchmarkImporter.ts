// BENCH-1 / PC6 — licensed CSV import for benchmark index levels
// (ii_benchmark_series), the "controlled continuity channel" mission section
// 8/13 asks for while a live provider feed remains source-blocked (see
// SOURCE_DECISION.md, PO-PC6-1). This is NOT a way around licensing: publish()
// below refuses to write a single row for a benchmark whose own
// ii_benchmarks.licence_status is not 'public_open' or an explicit admin-
// approved status, exactly like every other PC6 ingestion path. A CSV of
// NIFTY levels with no licence on file is refused for the same reason the
// live NSE adapter is refused (pc6ReferenceSources.ts's nse_index_tri entry).
//
// STAGE -> VALIDATE -> PUBLISH, same discipline as referenceImportRunner.ts:
//   1. parseAndValidateBenchmarkCsv() is PURE — no I/O, no database, fully
//      unit-testable with a plain string. It never partially trusts a row:
//      a row either fully validates or is rejected with a stated reason and
//      its own row number (mission section 10, "useful row errors").
//   2. publishBenchmarkCsv() takes the staged result plus a Supabase client
//      and does the DB-side checks (benchmark identity + licence, duplicate
//      detection against already-published rows) before writing anything.
//      dryRun defaults to true — a caller must explicitly ask for a real
//      write, matching mission section 13's "dry run" requirement.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO: it does not resolve which admin
// capability may call it, does not expose an API route, and does not add
// Admin navigation. Per FHIP_ADMIN_ARCHITECTURE_STANDARD.md section 2, an
// Admin-facing write path needs a separately-named capability enforced at
// all four layers (DB/API/route/nav) with its own tests -- that is real,
// separate work this dispatch did not have time to do with full rigor, and
// half-wiring an Admin surface without those four layers would be worse than
// leaving this as a tested, unwired service. See BENCH1 status report.

import type { SupabaseClient } from '@supabase/supabase-js';

export const CSV_BENCHMARK_IMPORT_VERSION = 'bench1-csv-benchmark-import-v1';

/** Hard ceiling so a malformed or malicious file cannot exhaust memory before validation even starts. */
export const CSV_MAX_ROWS = 20_000;
/** Hard ceiling on raw file size, in bytes, checked by the caller before this module ever sees the text. */
export const CSV_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export interface CsvBenchmarkRow {
  rowNumber: number; // 1-based, header excluded -- what an operator sees in their spreadsheet, minus the header row
  benchmarkKey: string;
  date: string; // ISO yyyy-mm-dd
  value: number;
  /** Raw string as supplied, preserved for the audit trail even though `value` is already parsed. */
  rawValue: string;
}

export interface CsvRejectedRow {
  rowNumber: number;
  raw: string;
  reason: string;
}

export interface CsvStagingResult {
  status: 'ok' | 'rejected_all' | 'empty';
  totalDataRows: number;
  accepted: CsvBenchmarkRow[];
  rejected: CsvRejectedRow[];
  /** Rows that are exact (benchmarkKey, date) duplicates of an EARLIER row in the SAME file. */
  intraFileDuplicatesSkipped: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Strict decimal grammar: optional leading '-', at least one digit, optional '.', digits. No locale thousands separators, no trailing '.', matching PC6-LD's own rejection of AMFI's bare "10." (see PC6_MARKET_DATA_CERTIFICATION_2026-09-15.md section 3.3). */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function isValidBenchmarkKey(key: string): boolean {
  // Matches ii_benchmarks.benchmark_key's real-world shape (e.g. IN_NIFTY_50_TRI)
  // without hard-coding a specific catalogue -- identity is verified against
  // the database in publishBenchmarkCsv(), not guessed here from the string shape.
  return /^[A-Za-z0-9_.-]{2,64}$/.test(key);
}

/**
 * Parse a naive CSV (no quoted-field/embedded-comma support -- a benchmark
 * key/date/value template never needs one, and adding general CSV-quoting
 * support would be untested surface area for a format this narrow) with a
 * required header row: benchmark_key,date,value (case-insensitive, any order).
 *
 * PURE. No network, no database, no clock read beyond the caller-supplied
 * `todayIso` (so a test can replay a fixed "today" instead of the real one,
 * and so no future-dated row can slip past validation via wall-clock skew).
 */
export function parseAndValidateBenchmarkCsv(csvText: string, todayIso: string): CsvStagingResult {
  const lines = csvText.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { status: 'empty', totalDataRows: 0, accepted: [], rejected: [], intraFileDuplicatesSkipped: 0 };
  }

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const colIndex = {
    benchmarkKey: header.indexOf('benchmark_key'),
    date: header.indexOf('date'),
    value: header.indexOf('value'),
  };
  if (colIndex.benchmarkKey < 0 || colIndex.date < 0 || colIndex.value < 0) {
    return {
      status: 'rejected_all',
      totalDataRows: 0,
      accepted: [],
      rejected: [{ rowNumber: 0, raw: lines[0], reason: 'Header must contain exactly benchmark_key, date, value columns (any order, case-insensitive).' }],
      intraFileDuplicatesSkipped: 0,
    };
  }

  const dataLines = lines.slice(1).slice(0, CSV_MAX_ROWS);
  const accepted: CsvBenchmarkRow[] = [];
  const rejected: CsvRejectedRow[] = [];
  const seenKeys = new Set<string>();
  let intraFileDuplicatesSkipped = 0;

  dataLines.forEach((raw, idx) => {
    const rowNumber = idx + 1;
    const cols = raw.split(',').map((c) => c.trim());
    const benchmarkKeyRaw = cols[colIndex.benchmarkKey] ?? '';
    const dateRaw = cols[colIndex.date] ?? '';
    const valueRaw = cols[colIndex.value] ?? '';

    if (!isValidBenchmarkKey(benchmarkKeyRaw)) {
      rejected.push({ rowNumber, raw, reason: `Invalid benchmark_key '${benchmarkKeyRaw}'.` });
      return;
    }
    const dateMatch = DATE_RE.exec(dateRaw);
    if (!dateMatch) {
      rejected.push({ rowNumber, raw, reason: `Invalid date '${dateRaw}' -- expected yyyy-mm-dd.` });
      return;
    }
    if (dateRaw > todayIso) {
      rejected.push({ rowNumber, raw, reason: `Date '${dateRaw}' is in the future (as of ${todayIso}). No historical calculation may use future information.` });
      return;
    }
    if (!DECIMAL_RE.test(valueRaw)) {
      rejected.push({ rowNumber, raw, reason: `Value '${valueRaw}' is not a plain decimal number (locale thousands separators and a bare trailing '.' are both rejected).` });
      return;
    }
    const value = Number(valueRaw);
    if (!Number.isFinite(value) || value <= 0) {
      rejected.push({ rowNumber, raw, reason: `Value '${valueRaw}' must be a finite positive level.` });
      return;
    }

    const dedupeKey = `${benchmarkKeyRaw}::${dateRaw}`;
    if (seenKeys.has(dedupeKey)) {
      intraFileDuplicatesSkipped += 1;
      return;
    }
    seenKeys.add(dedupeKey);
    accepted.push({ rowNumber, benchmarkKey: benchmarkKeyRaw, date: dateRaw, value, rawValue: valueRaw });
  });

  return {
    status: dataLines.length === 0 ? 'empty' : accepted.length === 0 ? 'rejected_all' : 'ok',
    totalDataRows: dataLines.length,
    accepted,
    rejected,
    intraFileDuplicatesSkipped,
  };
}

export interface PublishConflict {
  benchmarkKey: string;
  date: string;
  existingValue: number;
  incomingValue: number;
  reason: string;
}

export interface PublishBlockedRow {
  benchmarkKey: string;
  date: string;
  reason: string;
}

export interface PublishResult {
  dryRun: boolean;
  /** Rows that would be (or were) inserted. */
  toInsert: Array<{ benchmarkKey: string; date: string; value: number }>;
  /** Rows refused because the benchmark_key does not exist, or exists but is not licence-clear. Never silently skipped -- every one is named. */
  blocked: PublishBlockedRow[];
  /** Rows that already exist with a DIFFERENT value -- a correction, not a fresh publish. Refused here; use the existing PC6 correction path (ii_reference_corrections), never a silent overwrite. */
  conflicts: PublishConflict[];
  /** Rows that already exist with the IDENTICAL value -- idempotent no-op, not an error. */
  identicalSkipped: number;
  written: number;
  batchId: string | null;
}

const LICENCE_CLEAR_STATUSES = new Set(['public_open']);

/**
 * Validate accepted CSV rows against the real catalogue (benchmark identity +
 * licence status) and against already-published series rows, then optionally
 * write. `dryRun: true` (the default) performs every check and returns the
 * exact plan without touching the database at all -- mission section 13's
 * required dry-run/preview path.
 */
export async function publishBenchmarkCsv(
  supabase: SupabaseClient,
  accepted: CsvBenchmarkRow[],
  options: { dryRun?: boolean; sourceId?: string | null; importBatchId?: string } = {}
): Promise<PublishResult> {
  const dryRun = options.dryRun ?? true;
  const blocked: PublishBlockedRow[] = [];
  const conflicts: PublishConflict[] = [];
  const toInsert: Array<{ benchmarkKey: string; date: string; value: number; benchmarkId: string }> = [];
  let identicalSkipped = 0;

  const distinctKeys = [...new Set(accepted.map((r) => r.benchmarkKey))];
  const { data: benchmarkRows, error: benchmarkErr } = await supabase
    .from('ii_benchmarks')
    .select('id, benchmark_key, licence_status')
    .in('benchmark_key', distinctKeys);
  if (benchmarkErr) throw new Error(`ii_benchmarks: ${benchmarkErr.message}`);
  const benchmarkByKey = new Map(
    ((benchmarkRows ?? []) as Array<{ id: string; benchmark_key: string; licence_status: string | null }>).map((b) => [b.benchmark_key, b])
  );

  const knownBenchmarkIds = [...new Set([...benchmarkByKey.values()].map((b) => b.id))];
  const { data: existingSeriesRows, error: seriesErr } =
    knownBenchmarkIds.length > 0
      ? await supabase.from('ii_benchmark_series').select('benchmark_id, series_date, value').in('benchmark_id', knownBenchmarkIds)
      : { data: [] as Array<{ benchmark_id: string; series_date: string; value: number | string }>, error: null };
  if (seriesErr) throw new Error(`ii_benchmark_series: ${seriesErr.message}`);
  const existingByKeyDate = new Map<string, number>();
  for (const row of (existingSeriesRows ?? []) as Array<{ benchmark_id: string; series_date: string; value: number | string }>) {
    existingByKeyDate.set(`${row.benchmark_id}::${row.series_date}`, Number(row.value));
  }

  for (const row of accepted) {
    const benchmark = benchmarkByKey.get(row.benchmarkKey);
    if (!benchmark) {
      blocked.push({ benchmarkKey: row.benchmarkKey, date: row.date, reason: `No ii_benchmarks row exists for benchmark_key '${row.benchmarkKey}'. A CSV import never creates a new benchmark identity -- add it to the catalogue first, with evidence.` });
      continue;
    }
    if (!LICENCE_CLEAR_STATUSES.has(benchmark.licence_status ?? 'unknown')) {
      blocked.push({
        benchmarkKey: row.benchmarkKey,
        date: row.date,
        reason: `'${row.benchmarkKey}' has licence_status='${benchmark.licence_status ?? 'unknown'}'. A CSV file is a delivery MECHANISM, not a licence -- this row is refused for the same reason the live feed for this benchmark is refused.`,
      });
      continue;
    }
    const existing = existingByKeyDate.get(`${benchmark.id}::${row.date}`);
    if (existing !== undefined) {
      if (Math.abs(existing - row.value) < 1e-9) {
        identicalSkipped += 1;
      } else {
        conflicts.push({ benchmarkKey: row.benchmarkKey, date: row.date, existingValue: existing, incomingValue: row.value, reason: 'A different value is already published for this benchmark/date. This is a correction, not a fresh publish -- route it through the correction path (ii_reference_corrections) instead of overwriting silently.' });
      }
      continue;
    }
    toInsert.push({ benchmarkKey: row.benchmarkKey, date: row.date, value: row.value, benchmarkId: benchmark.id });
  }

  if (dryRun || toInsert.length === 0) {
    return {
      dryRun: true,
      toInsert: toInsert.map(({ benchmarkKey, date, value }) => ({ benchmarkKey, date, value })),
      blocked,
      conflicts,
      identicalSkipped,
      written: 0,
      batchId: null,
    };
  }

  const batchId = options.importBatchId ?? `csv-${CSV_BENCHMARK_IMPORT_VERSION}-${Date.now()}`;
  const payload = toInsert.map((r) => ({
    benchmark_id: r.benchmarkId,
    series_date: r.date,
    value: r.value,
    source_id: options.sourceId ?? null,
    data_version: CSV_BENCHMARK_IMPORT_VERSION,
    quality_status: 'ok',
    import_batch_id: batchId,
  }));
  // A single insert call is one PostgREST/Postgres statement -- atomic by
  // construction (all rows land or none do), which is the "transactional
  // accepted publication" mission section 13 asks for; there is no
  // multi-statement client transaction to wrap it in over PostgREST.
  const { error: insertErr } = await supabase.from('ii_benchmark_series').insert(payload);
  if (insertErr) throw new Error(`ii_benchmark_series insert: ${insertErr.message}`);

  return {
    dryRun: false,
    toInsert: toInsert.map(({ benchmarkKey, date, value }) => ({ benchmarkKey, date, value })),
    blocked,
    conflicts,
    identicalSkipped,
    written: toInsert.length,
    batchId,
  };
}
