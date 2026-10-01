// BENCH-1 — shared benchmark-coverage resolver for the three previously
// unwired consumers (Overview already surfaces instrumentsWithBenchmarkCount
// via analysisAvailability.ts; this file is for HoldingsTable and
// PortfolioXray, which need a PER-HOLDING comparable, not just a count).
//
// This module does NOT reimplement any certified R4 arithmetic. It only:
//   1. batch-loads each held instrument's effective-dated PRIMARY benchmark
//      mapping (one query, never one per row — mission section 12's "no
//      second user import or manual study" implies no N+1 either), and
//   2. calls the already-certified resolveBenchmarkForDate/benchmarkWindowReturn
//      (lib/engines/investment-intelligence/benchmarkEngine.ts,
//      benchmarkService.ts) exactly as PerformanceClient's own pipeline does.
//
// HONESTY CONTRACT (mission sections 11-12; matches calculationStatus.ts's
// existing CalculationOutcome vocabulary used everywhere else in this tab):
//   - no mapping row at all                     -> BENCHMARK_MAPPING_MISSING
//   - mapping exists but NO approved entitlement
//     permits calculation + customer display
//     (BENCH-1 Phase 2: per-right entitlement
//     records, NOT ii_benchmarks.licence_status)  -> BENCHMARK_HISTORY_INCOMPLETE
//   - mapping + licence clear, but no published
//     series covers the requested window        -> BENCHMARK_HISTORY_INCOMPLETE
//   - real data on both ends                     -> CALCULATED
// Never a fabricated 0%, never a guessed index, never a silently-substituted
// category default (ii_benchmark_category_defaults is deliberately not
// consulted here for anything above 'admin_override'/'scheme_disclosed'
// precedence -- see pc6/benchmarkGovernance.ts's own three-basis precedence,
// which this module defers to rather than re-deciding).

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveBenchmarkForDate, type BenchmarkMapping } from '@/lib/engines/investment-intelligence/benchmarkEngine';
import { benchmarkWindowReturn, type SeriesPoint } from '@/lib/engines/investment-intelligence/benchmarkService';
import { missingReferenceData, type CalculationOutcome } from '@/lib/engines/investment-intelligence/calculationStatus';
import { accessAllows, blockedReason, clampToScope, loadBenchmarkAccess, type BenchmarkAccess, type BenchmarkAccessMap } from './benchmarkAccess';

export interface BenchmarkComparable {
  benchmarkKey: string;
  benchmarkLabel: string;
  returnType: string;
  windowStart: string; // ISO yyyy-mm-dd
  windowEnd: string;
  pointToPointReturn: number;
  cagr?: number;
}

export type BenchmarkCoverageOutcome = CalculationOutcome<BenchmarkComparable>;

interface BenchmarkMeta {
  key: string;
  label: string;
  returnType: string;
  licenceStatus: string | null;
  lifecycleStatus: string | null;
}

export interface InstrumentBenchmarkContext {
  mappingsByInstrument: Map<string, BenchmarkMapping[]>;
  metaByBenchmarkId: Map<string, BenchmarkMeta>;
  /** BENCH-1 Phase 2: per-benchmark entitlement decision (fail closed: a missing entry = no access). */
  accessByBenchmarkId: BenchmarkAccessMap;
  /** Set when the entitlement lookup itself failed; every benchmark is then reported blocked. */
  accessError: string | null;
}

interface RawMappingRow {
  instrument_id: string;
  benchmark_id: string;
  relationship_type: string;
  effective_from: string;
  effective_to: string | null;
  ii_benchmarks: {
    benchmark_key: string;
    benchmark_label: string;
    return_type: string | null;
    licence_status: string | null;
    lifecycle_status: string | null;
  } | null;
}

/**
 * Batch-load PRIMARY benchmark mappings for every instrument the caller
 * passes in, in exactly one query regardless of holding count. An instrument
 * with no mapping row simply has no entry in the returned map — that is a
 * real, honest "unmapped" state for the caller to report, not a query error.
 */
export async function loadInstrumentBenchmarkContext(
  supabase: SupabaseClient,
  instrumentIds: string[]
): Promise<InstrumentBenchmarkContext> {
  const mappingsByInstrument = new Map<string, BenchmarkMapping[]>();
  const metaByBenchmarkId = new Map<string, BenchmarkMeta>();
  if (instrumentIds.length === 0) return { mappingsByInstrument, metaByBenchmarkId, accessByBenchmarkId: new Map(), accessError: null };

  const { data, error } = await supabase
    .from('ii_instrument_benchmarks')
    .select(
      'instrument_id, benchmark_id, relationship_type, effective_from, effective_to, ii_benchmarks(benchmark_key, benchmark_label, return_type, licence_status, lifecycle_status)'
    )
    .in('instrument_id', instrumentIds)
    .eq('relationship_type', 'primary');
  if (error) throw new Error(`ii_instrument_benchmarks: ${error.message}`);

  for (const row of (data ?? []) as unknown as RawMappingRow[]) {
    const meta = row.ii_benchmarks;
    if (!meta) continue; // an orphaned mapping row is never used to fabricate an identity
    const mapping: BenchmarkMapping = {
      instrumentId: row.instrument_id,
      benchmarkId: row.benchmark_id,
      benchmarkKey: meta.benchmark_key,
      returnType: (meta.return_type ?? 'OTHER') as BenchmarkMapping['returnType'],
      effectiveFrom: new Date(row.effective_from),
      effectiveTo: row.effective_to ? new Date(row.effective_to) : null,
    };
    const list = mappingsByInstrument.get(row.instrument_id) ?? [];
    list.push(mapping);
    mappingsByInstrument.set(row.instrument_id, list);
    if (!metaByBenchmarkId.has(row.benchmark_id)) {
      metaByBenchmarkId.set(row.benchmark_id, {
        key: meta.benchmark_key,
        label: meta.benchmark_label,
        returnType: meta.return_type ?? 'OTHER',
        licenceStatus: meta.licence_status,
        lifecycleStatus: meta.lifecycle_status,
      });
    }
  }
  const { access, error: accessError } = await loadBenchmarkAccess(supabase, [...metaByBenchmarkId.keys()]);
  return { mappingsByInstrument, metaByBenchmarkId, accessByBenchmarkId: access, accessError };
}

/**
 * Batch-load benchmark level series for a specific set of benchmark ids
 * (never the whole catalogue), keyed by benchmarkId, sorted ascending by
 * date. One query regardless of how many holdings share a benchmark.
 */
export async function loadBenchmarkSeriesById(
  supabase: SupabaseClient,
  benchmarkIds: string[],
  access?: BenchmarkAccessMap
): Promise<Map<string, SeriesPoint[]>> {
  const out = new Map<string, SeriesPoint[]>();
  if (benchmarkIds.length === 0) return out;
  const { data, error } = await supabase
    .from('ii_benchmark_series')
    .select('benchmark_id, series_date, value')
    .in('benchmark_id', benchmarkIds)
    .order('series_date', { ascending: true });
  if (error) throw new Error(`ii_benchmark_series: ${error.message}`);
  for (const row of (data ?? []) as Array<{ benchmark_id: string; series_date: string; value: number | string }>) {
    const list = out.get(row.benchmark_id) ?? [];
    list.push({ date: new Date(row.series_date), value: Number(row.value) });
    out.set(row.benchmark_id, list);
  }
  if (access) {
    // BENCH-1 Phase 2: only entitled benchmarks, only inside the entitled data-date scope.
    for (const [id, points] of [...out]) {
      const grant = access.get(id);
      if (!accessAllows(grant, 'display_comparison')) {
        out.delete(id);
        continue;
      }
      out.set(id, clampToScope(points, grant, (p) => p.date.toISOString().slice(0, 10)));
    }
  }
  return out;
}

export interface BenchmarkCoverageSummary {
  totalSchemes: number;
  /** Mapped to a benchmark whose licence status does not block a real comparison. */
  mappedCount: number;
  /** Mapped, but no approved entitlement permits calculation + display (BENCH-1 Phase 2: per-right entitlements, not licence_status). */
  licenceBlockedCount: number;
  /** No benchmark mapping exists for this scheme at all. */
  unmappedCount: number;
}

/**
 * Coarse coverage counts for a set of held schemes — used where a full
 * per-row comparable is unnecessary (e.g. Portfolio X-Ray's scheme-level
 * summary) but a fabricated "0% mapped" would still be dishonest if it hid a
 * real, licence-blocked mapping. Never counts a licence-blocked mapping as
 * either "mapped" (it produces no real comparison) or "unmapped" (a mapping
 * genuinely exists and was evidenced) — mission BENCH-1 section 6's
 * distinction between a real gap and a real-but-blocked one.
 */
export function summarizeBenchmarkCoverage(ctx: InstrumentBenchmarkContext, instrumentIds: string[], asOfDate: Date): BenchmarkCoverageSummary {
  let mappedCount = 0;
  let licenceBlockedCount = 0;
  for (const id of instrumentIds) {
    const mappings = ctx.mappingsByInstrument.get(id);
    const mapping = mappings ? resolveBenchmarkForDate(mappings, id, asOfDate) : undefined;
    if (!mapping) continue; // unmapped — counted by subtraction below
    if (!accessAllows(ctx.accessByBenchmarkId.get(mapping.benchmarkId), 'display_comparison')) licenceBlockedCount += 1;
    else mappedCount += 1;
  }
  return {
    totalSchemes: instrumentIds.length,
    mappedCount,
    licenceBlockedCount,
    unmappedCount: instrumentIds.length - mappedCount - licenceBlockedCount,
  };
}

/**
 * Resolve ONE holding's benchmark comparable, honestly. Never guesses a
 * benchmark, never fabricates a 0% for missing data (mission sections 11-12).
 * `windowStart`/`windowEnd` are the caller's own certified dates (e.g. first
 * acquisition date and latest valuation date) — this function does not pick
 * them, matching the "same effective period" requirement (mission section 11).
 */
export function resolveHoldingBenchmarkComparable(
  ctx: InstrumentBenchmarkContext,
  instrumentId: string,
  windowStart: Date | null,
  windowEnd: Date | null,
  benchmarkSeriesById: Map<string, SeriesPoint[]>
): BenchmarkCoverageOutcome {
  const mappings = ctx.mappingsByInstrument.get(instrumentId);
  if (!mappings || mappings.length === 0) {
    return missingReferenceData('BENCHMARK_MAPPING_MISSING', 'No benchmark is mapped to this scheme yet.');
  }
  if (!windowStart || !windowEnd) {
    return missingReferenceData('BENCHMARK_MAPPING_MISSING', 'Not enough certified valuation history to define a comparison period.');
  }
  const mapping = resolveBenchmarkForDate(mappings, instrumentId, windowEnd);
  if (!mapping) {
    return missingReferenceData('BENCHMARK_MAPPING_MISSING', 'No benchmark mapping is in effect for this scheme on the relevant date.');
  }
  const meta = ctx.metaByBenchmarkId.get(mapping.benchmarkId);
  const grant: BenchmarkAccess | undefined = ctx.accessByBenchmarkId.get(mapping.benchmarkId);
  if (!accessAllows(grant, 'display_comparison')) {
    return missingReferenceData('BENCHMARK_HISTORY_INCOMPLETE', blockedReason(meta?.label ?? mapping.benchmarkKey, grant, 'display_comparison', ctx.accessError));
  }
  const series = benchmarkSeriesById.get(mapping.benchmarkId) ?? [];
  const windowResult = benchmarkWindowReturn(series, windowStart, windowEnd);
  if (windowResult.status !== 'ok') {
    return missingReferenceData(
      'BENCHMARK_HISTORY_INCOMPLETE',
      `No published ${meta?.label ?? mapping.benchmarkKey} levels are available for this period yet.`
    );
  }
  return {
    status: 'CALCULATED',
    value: {
      benchmarkKey: mapping.benchmarkKey,
      benchmarkLabel: meta?.label ?? mapping.benchmarkKey,
      returnType: mapping.returnType,
      windowStart: windowStart.toISOString().slice(0, 10),
      windowEnd: windowEnd.toISOString().slice(0, 10),
      pointToPointReturn: windowResult.pointToPoint!,
      cagr: windowResult.cagr,
    },
  };
}
