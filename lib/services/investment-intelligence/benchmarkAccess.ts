// BENCH-1 Phase 2 - the consumer-side entitlement gate.
//
// Every screen / engine loader that turns benchmark LEVELS into something a
// user sees (Performance R4, SIP Intelligence R5, X-Ray, Holdings table,
// Overview coverage, report sections) asks the SAME question through this
// module: may this benchmark be used to CALCULATE and to DISPLAY a comparison
// (and, for reports/exports, to EXPORT)? The answer comes from the database
// function benchmark_entitled_actions() (migration 0239), which evaluates the
// per-right entitlement records - NOT from ii_benchmarks.licence_status, which
// is a coarse legacy summary and grants nothing.
//
// FAIL CLOSED. A failed read, a missing function (migration not applied) or an
// unknown benchmark yields "no access": the benchmark is then reported as
// BLOCKED (never a fabricated 0% and never silently dropped without a reason).
// The certified R4/R5 arithmetic is not touched: a blocked benchmark simply
// contributes no series to those engines, which already report that honestly.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface BenchmarkAccess {
  benchmarkId: string;
  canCalculate: boolean;
  canDisplay: boolean;
  canExport: boolean;
  /** Inclusive data-date scope of the entitlement; null = unbounded on that side. */
  dataFrom: string | null;
  dataTo: string | null;
}

export type BenchmarkAccessMap = Map<string, BenchmarkAccess>;

export interface LoadedBenchmarkAccess {
  access: BenchmarkAccessMap;
  /** Non-null when the entitlement lookup itself failed (everything is then blocked). */
  error: string | null;
}

const CHUNK = 400;

export async function loadBenchmarkAccess(supabase: SupabaseClient, benchmarkIds: readonly string[], onIso?: string): Promise<LoadedBenchmarkAccess> {
  const access: BenchmarkAccessMap = new Map();
  const ids = [...new Set(benchmarkIds)];
  if (ids.length === 0) return { access, error: null };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    // A client without rpc (a test double, a restricted wrapper) is a lookup FAILURE: fail closed, never throw.
    if (typeof (supabase as { rpc?: unknown }).rpc !== 'function') return { access: new Map(), error: 'rpc unavailable on this client' };
    const { data, error } = await supabase.rpc('benchmark_entitled_actions', { p_benchmark_ids: slice, ...(onIso ? { p_on: onIso } : {}) });
    if (error) return { access: new Map(), error: error.message };
    for (const r of (data ?? []) as Array<{ benchmark_id: string; can_calculate: boolean; can_display: boolean; can_export: boolean; data_from: string | null; data_to: string | null }>) {
      access.set(r.benchmark_id, { benchmarkId: r.benchmark_id, canCalculate: r.can_calculate === true, canDisplay: r.can_display === true, canExport: r.can_export === true, dataFrom: r.data_from, dataTo: r.data_to });
    }
  }
  return { access, error: null };
}

export type AccessNeed = 'calculate' | 'display_comparison' | 'export';

/** Fail closed: undefined access = no access. A customer-visible comparison needs calculation AND display; export additionally needs export. */
export function accessAllows(a: BenchmarkAccess | undefined, need: AccessNeed): boolean {
  if (!a) return false;
  switch (need) {
    case 'calculate':
      return a.canCalculate;
    case 'display_comparison':
      return a.canCalculate && a.canDisplay;
    case 'export':
      return a.canCalculate && a.canDisplay && a.canExport;
    default:
      return false;
  }
}

/** True when `date` lies inside the entitlement's data-date scope. */
export function inDataScope(a: BenchmarkAccess, date: string): boolean {
  return (a.dataFrom === null || date >= a.dataFrom) && (a.dataTo === null || date <= a.dataTo);
}

/** Series points outside the entitled data-date scope are never fed to a calculation. */
export function clampToScope<T>(points: readonly T[], a: BenchmarkAccess | undefined, dateOf: (p: T) => string): T[] {
  if (!a) return [];
  return points.filter((p) => inDataScope(a, dateOf(p)));
}

/** The honest, specific reason shown instead of a number. */
export function blockedReason(label: string, a: BenchmarkAccess | undefined, need: AccessNeed, lookupError: string | null): string {
  if (lookupError) return `${label}: entitlement could not be checked, so no comparison is shown.`;
  if (!a) return `${label}: no approved entitlement covers this benchmark, so no comparison is shown.`;
  if (!a.canCalculate) return `${label}: no approved entitlement permits calculating with this benchmark, so no comparison is shown.`;
  if (need !== 'calculate' && !a.canDisplay) return `${label}: the entitlement permits calculation but not customer display, so no comparison is shown.`;
  if (need === 'export' && !a.canExport) return `${label}: the entitlement does not permit report/export use, so it is left out of exports.`;
  return `${label}: not available.`;
}
