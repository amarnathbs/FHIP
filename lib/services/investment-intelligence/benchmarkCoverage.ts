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
import {
  compareHoldingToBenchmark,
  withheldComparison,
  type BenchmarkSegmentInput,
  type HoldingBenchmarkComparison,
} from '@/lib/engines/investment-intelligence/holdingBenchmarkComparison';
import type { CashFlow } from '@/lib/engines/investment-intelligence/xirr';
import { accessAllows, blockedReason, clampToScope, loadBenchmarkAccess, type BenchmarkAccess, type BenchmarkAccessMap } from './benchmarkAccess';
import { fetchAllRows } from './pagination';
import { loadCategoryReferenceMappings } from './benchmarkData/categoryReferenceLoader';

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
  /** ii_benchmarks.catalogue_status; anything other than 'verified' (including unknown) is NOT usable for a comparison. */
  catalogueStatus: string | null;
}

export interface InstrumentBenchmarkContext {
  mappingsByInstrument: Map<string, BenchmarkMapping[]>;
  metaByBenchmarkId: Map<string, BenchmarkMeta>;
  /** BENCH-1 Phase 2: per-benchmark entitlement decision (fail closed: a missing entry = no access). */
  accessByBenchmarkId: BenchmarkAccessMap;
  /** Set when the entitlement lookup itself failed; every benchmark is then reported blocked. */
  accessError: string | null;
  /**
   * READ-TIME category references (basis 'category_reference') for instruments with NO declared primary
   * mapping. In memory only: never stored, never counted as "mapped" by summarizeBenchmarkCoverage and never
   * used by the legacy lump-sum comparable. A declared mapping always wins (the instrument is simply absent here).
   */
  categoryReferenceByInstrument: Map<string, BenchmarkMapping[]>;
  /** instrumentId -> the sentence shown instead of a number ("Benchmark not available for this fund category"). */
  categoryNoBenchmark: Map<string, string>;
}

/** Every benchmark id whose series may be needed: declared mappings AND category references. */
export function benchmarkIdsToLoad(ctx: InstrumentBenchmarkContext): string[] {
  const ids = new Set<string>();
  for (const list of ctx.mappingsByInstrument.values()) for (const m of list) ids.add(m.benchmarkId);
  for (const list of ctx.categoryReferenceByInstrument.values()) for (const m of list) ids.add(m.benchmarkId);
  return [...ids];
}

interface RawMappingRow {
  instrument_id: string;
  benchmark_id: string;
  relationship_type: string;
  effective_from: string;
  effective_to: string | null;
  quality_status?: string | null;
  ii_benchmarks: {
    benchmark_key: string;
    benchmark_label: string;
    return_type: string | null;
    licence_status: string | null;
    lifecycle_status: string | null;
    catalogue_status?: string | null;
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
  const categoryReferenceByInstrument = new Map<string, BenchmarkMapping[]>();
  const categoryNoBenchmark = new Map<string, string>();
  if (instrumentIds.length === 0) return { mappingsByInstrument, metaByBenchmarkId, accessByBenchmarkId: new Map(), accessError: null, categoryReferenceByInstrument, categoryNoBenchmark };

  const query = (cols: string) =>
    supabase.from('ii_instrument_benchmarks').select(cols).in('instrument_id', instrumentIds).eq('relationship_type', 'primary');
  let { data, error } = await query(
    'instrument_id, benchmark_id, relationship_type, effective_from, effective_to, quality_status, ii_benchmarks(benchmark_key, benchmark_label, return_type, licence_status, lifecycle_status, catalogue_status)'
  );
  // Fail CLOSED on an older schema: without catalogue_status every benchmark reads as "not verified" below.
  if (error && /catalogue_status|quality_status/i.test(error.message)) {
    ({ data, error } = await query(
      'instrument_id, benchmark_id, relationship_type, effective_from, effective_to, ii_benchmarks(benchmark_key, benchmark_label, return_type, licence_status, lifecycle_status)'
    ));
  }
  if (error) throw new Error(`ii_instrument_benchmarks: ${error.message}`);

  for (const row of (data ?? []) as unknown as RawMappingRow[]) {
    const meta = row.ii_benchmarks;
    if (!meta) continue; // an orphaned mapping row is never used to fabricate an identity
    // The same exclusions the analytics loader applies: a superseded or ambiguous mapping never drives a comparison.
    if (row.quality_status === 'superseded' || row.quality_status === 'ambiguous') continue;
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
        catalogueStatus: meta.catalogue_status ?? null,
      });
    }
  }
  // Category references for the instruments with no declared mapping (a declared mapping always wins).
  const cat = await loadCategoryReferenceMappings(supabase, instrumentIds, new Set(mappingsByInstrument.keys()));
  for (const m of cat.mappings) {
    const list = categoryReferenceByInstrument.get(m.instrumentId) ?? [];
    list.push(m);
    categoryReferenceByInstrument.set(m.instrumentId, list);
    const facts = cat.facts.get(m.benchmarkId);
    if (!metaByBenchmarkId.has(m.benchmarkId)) {
      metaByBenchmarkId.set(m.benchmarkId, { key: m.benchmarkKey, label: facts?.label ?? m.benchmarkKey, returnType: m.returnType, licenceStatus: null, lifecycleStatus: 'active', catalogueStatus: facts?.catalogueVerified ? 'verified' : null });
    }
  }
  for (const [id, msg] of cat.noBenchmark) categoryNoBenchmark.set(id, msg);
  const { access, error: accessError } = await loadBenchmarkAccess(supabase, [...metaByBenchmarkId.keys()]);
  return { mappingsByInstrument, metaByBenchmarkId, accessByBenchmarkId: access, accessError, categoryReferenceByInstrument, categoryNoBenchmark };
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
  // PAGED: PostgREST silently caps a plain select at 1000 rows, and a daily index
  // series is several thousand rows. A truncated series would end years before the
  // as-of date and (read with last-observation-on-or-before) yield a wrong, stale
  // end level with no error. Order by date then id so the paging is deterministic.
  let rows: Array<{ benchmark_id: string; series_date: string; value: number | string; quality_status?: string | null }>;
  try {
    rows = await fetchAllRows(() =>
      supabase
        .from('ii_benchmark_series')
        .select('benchmark_id, series_date, value, quality_status')
        .in('benchmark_id', benchmarkIds)
        .order('series_date', { ascending: true })
        .order('id', { ascending: true })
    );
  } catch (e) {
    throw new Error(`ii_benchmark_series: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const row of rows) {
    if (row.quality_status && row.quality_status !== 'ok') continue; // same filter the analytics loader applies
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

/**
 * The holding-period, money-weighted comparison for ONE holding (see
 * lib/engines/investment-intelligence/holdingBenchmarkComparison.ts for the
 * method and every refusal rule). This function only assembles that engine's
 * inputs from the loaded context; it adds no arithmetic and no gate of its own:
 *   - entitlement comes from the same central gate (accessAllows) the rest of
 *     this module uses, and an un-entitled benchmark reaches the engine as
 *     `entitled: false` so no number can be produced;
 *   - `benchmarkSeriesById` is the already-gated, scope-clamped series map.
 * `flows` are the investor's REAL flows (purchases negative, redemptions
 * positive) without the terminal valuation; `terminalValue` is dated `asOfDate`.
 */
export function resolveHoldingBenchmarkComparison(
  ctx: InstrumentBenchmarkContext,
  instrumentId: string,
  flows: CashFlow[],
  terminalValue: number,
  asOfDate: Date,
  currencyCode: string,
  benchmarkSeriesById: Map<string, SeriesPoint[]>
): HoldingBenchmarkComparison {
  const declared = ctx.mappingsByInstrument.get(instrumentId) ?? [];
  // A declared mapping ALWAYS wins; only an instrument with none falls back to its category reference.
  const mappings = declared.length > 0 ? declared : (ctx.categoryReferenceByInstrument.get(instrumentId) ?? []);
  if (mappings.length === 0) {
    const why = ctx.categoryNoBenchmark.get(instrumentId);
    if (why) return withheldComparison('NO_MAPPING', why);
  }
  const segments: BenchmarkSegmentInput[] = mappings.map((m) => {
    const meta = ctx.metaByBenchmarkId.get(m.benchmarkId);
    const grant = ctx.accessByBenchmarkId.get(m.benchmarkId);
    const label = meta?.label ?? m.benchmarkKey;
    const entitled = accessAllows(grant, 'display_comparison');
    return {
      basis: m.basis ?? 'declared',
      categoryLabel: m.categoryLabel ?? null,
      benchmarkId: m.benchmarkId,
      benchmarkKey: m.benchmarkKey,
      label,
      returnType: m.returnType,
      effectiveFrom: m.effectiveFrom,
      effectiveTo: m.effectiveTo,
      catalogueVerified: meta?.catalogueStatus === 'verified',
      entitled,
      ...(entitled ? {} : { entitlementDetail: blockedReason(label, grant, 'display_comparison', ctx.accessError) }),
      series: entitled ? (benchmarkSeriesById.get(m.benchmarkId) ?? []) : [],
    };
  });
  return compareHoldingToBenchmark({ flows, terminalValue, asOfDate, currencyCode, segments });
}
