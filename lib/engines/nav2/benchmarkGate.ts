// NAV2 -- the benchmark gate for beta and Jensen alpha (spec 8.11, 8.12, 10; PO
// decision 2026-10-03, item 3).
//
// A benchmark series may feed a ratio only if EVERY one of these holds, otherwise
// the result is the typed state `benchmark_missing` with a reason and NO number
// (never a beta of 0, never an unrelated index, never a price index standing in
// for a total return):
//   * a mapping exists and is effective for the ENTIRE analysis window (a declared
//     mapping always wins over a category reference; a benchmark that changes inside
//     the window is not stitched together for a regression);
//   * the central entitlement gate allowed calculation AND customer display;
//   * the catalogue entry is verified;
//   * it is a TOTAL-RETURN series (a price index, or an unknown type, is refused);
//   * it has published levels.
// The last four are the SAME code the holding-period benchmark comparison uses
// (holdingBenchmarkComparison.segmentGateFailure, extracted for exactly this).
//
// The READ-TIME CATEGORY REFERENCE (benchmarkData/categoryReference.ts) may be
// used here only with its honest label, and only through the same gates; its
// basisLabel travels with the result as a disclosure. Until a licensed series
// exists the gates return typed unavailable states.

import {
  benchmarkBasisLabel,
  declaredWins,
  segmentGateFailure,
  type BenchmarkSegmentInput,
  type ComparisonUnavailableReason,
} from '@/lib/engines/investment-intelligence/holdingBenchmarkComparison';
import type { Nav2MetricId } from '@/lib/config/nav2/metricPolicy';
import type { NavObservation } from './series';
import {
  makeProvenance,
  showDate,
  unavailable,
  type BenchmarkProvenance,
  type Disclosure,
  type Nav2Context,
  type Nav2Reason,
  type Nav2Unavailable,
  type ProvenanceExtras,
} from './types';

export interface Nav2BenchmarkInput extends BenchmarkSegmentInput {
  /** The benchmark dataset version the series came from (BENCH-1 governed upload), when known. */
  datasetVersion: string | null;
  licenceStatus: string | null;
}

const GATE_REASON: Partial<Record<ComparisonUnavailableReason, Nav2Reason>> = {
  NOT_ENTITLED: 'benchmark_not_entitled',
  CATALOGUE_NOT_VERIFIED: 'benchmark_catalogue_not_verified',
  PRICE_INDEX_NOT_TOTAL_RETURN: 'benchmark_price_index',
  UNKNOWN_RETURN_TYPE: 'benchmark_return_type_unknown',
  NO_SERIES: 'benchmark_no_series',
};

const iso = (d: Date): string => d.toISOString().slice(0, 10);

export interface GatedBenchmark {
  segment: Nav2BenchmarkInput;
  /** Ascending, positive levels, ISO dates. */
  observations: NavObservation[];
  provenance: BenchmarkProvenance;
  disclosures: Disclosure[];
}

export function gateBenchmark(
  segmentsIn: readonly Nav2BenchmarkInput[] | undefined,
  window: { start: string; end: string },
  ctx: Nav2Context,
  metricId: Nav2MetricId,
  extras: ProvenanceExtras
): { ok: true; gated: GatedBenchmark } | { ok: false; result: Nav2Unavailable } {
  const fail = (reason: Nav2Reason, detail: string): { ok: false; result: Nav2Unavailable } => ({
    ok: false,
    result: unavailable('benchmark_missing', reason, detail, makeProvenance(ctx, metricId, extras)),
  });
  const all = segmentsIn ?? [];
  if (all.length === 0) return fail('no_benchmark_mapping', 'Benchmark data unavailable: no benchmark is mapped to this scheme.');
  const segments = declaredWins(all) as Nav2BenchmarkInput[];
  const overlapping = segments
    .filter((s) => iso(s.effectiveFrom) <= window.end && (s.effectiveTo === null || iso(s.effectiveTo) >= window.start))
    .sort((a, b) => iso(a.effectiveFrom).localeCompare(iso(b.effectiveFrom)));
  if (overlapping.length === 0) return fail('benchmark_mapping_not_effective', 'Benchmark data unavailable: no benchmark mapping is in force during this period.');
  if (overlapping.length > 1) {
    return fail('benchmark_changed_in_window', `Benchmark data unavailable: the scheme's benchmark changed inside this period (${overlapping.map((s) => s.label).join(', then ')}), so a single regression is not valid.`);
  }
  const seg = overlapping[0];
  if (iso(seg.effectiveFrom) > window.start || (seg.effectiveTo !== null && iso(seg.effectiveTo) < window.end)) {
    return fail('benchmark_mapping_not_effective', `Benchmark data unavailable: the mapping to ${seg.label} is not in force for the whole period ${showDate(ctx, window.start)} to ${showDate(ctx, window.end)}.`);
  }
  const gate = segmentGateFailure(seg);
  if (gate) return fail(GATE_REASON[gate.reason] ?? 'benchmark_no_series', gate.detail);

  const observations: NavObservation[] = seg.series
    .filter((p) => Number.isFinite(p.value) && p.value > 0)
    .map((p) => ({ date: iso(p.date), value: p.value }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const basisLabel = benchmarkBasisLabel(seg.basis ?? 'declared', seg.categoryLabel);
  const disclosures: Disclosure[] = [{ code: 'benchmark_basis', detail: `${seg.label}. ${basisLabel}.` }];
  return {
    ok: true,
    gated: {
      segment: seg,
      observations,
      disclosures,
      provenance: {
        benchmarkId: seg.benchmarkId,
        benchmarkKey: seg.benchmarkKey,
        label: seg.label,
        basis: seg.basis ?? 'declared',
        basisLabel,
        returnType: seg.returnType,
        datasetVersion: seg.datasetVersion,
        licenceStatus: seg.licenceStatus,
        effectiveFrom: iso(seg.effectiveFrom),
        effectiveTo: seg.effectiveTo ? iso(seg.effectiveTo) : null,
        observationFirstDate: observations.length ? observations[0].date : null,
        observationLastDate: observations.length ? observations[observations.length - 1].date : null,
        commonObservationCount: 0,
      },
    },
  };
}
