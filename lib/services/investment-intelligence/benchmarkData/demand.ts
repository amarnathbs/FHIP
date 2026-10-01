// BENCH-1 Phase 2 - selective-history demand, aggregated GLOBALLY by exact
// benchmark (mission section I). Stores shared benchmark/date requirements
// once; there is NO full-universe backfill, and nothing here requests a
// benchmark that no held, mapped scheme needs.
//
// WHAT "DEMAND" IS. For every benchmark, the earliest date any HELD scheme
// mapped to it needs benchmark levels from, and the latest session expected,
// derived from the SAME rules the certified engines already use (found in the
// engines, not invented here):
//   * investor period  : the earliest transaction date of the position
//                        (analyticsRepository blend start, holdingsRepository,
//                        benchmarkCoverage window start);
//   * engine since-inception per-scheme comparison : the earliest NAV on file
//                        (analyticsOrchestrator.ts, per-scheme active return);
//   * alignment lookback: the existing SIP/benchmark alignment search window
//                        MAX_BACKWARD_SEARCH_DAYS (10 days) - the engines read
//                        a benchmark with last-observation-on-or-before and
//                        have no start tolerance, so the series needs a point
//                        on/before the window start.
// Mapping-effective periods bound the demand (a mapping that ended before a
// scheme's history began creates none). Older transactions or a newly approved
// mapping simply produce a wider window on the next aggregation: demand EXPANDS,
// it is never recomputed from a fixed list.
//
// PRIVACY. The aggregation reads user-scoped rows only through the service
// role on the server and emits ONLY per-benchmark aggregates: dates and
// counts of schemes/families. No user, account, holding amount or transaction
// is stored (the demand table has no such column).
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { addDaysIso } from './ingestion/calendar';

export const DEMAND_VERSION = 'bench1-demand-v1';
/** Equal to MAX_BACKWARD_SEARCH_DAYS in lib/engines/investment-intelligence/sip/dateAlignment.ts. */
export const ALIGNMENT_LOOKBACK_DAYS = 10;

export interface DemandMapping {
  instrumentId: string;
  benchmarkId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface DemandInstrument {
  instrumentId: string;
  /** Normalised scheme family (AMC + base name); distinct plans/options share a family but are never merged as instruments. */
  familyKey: string;
  held: boolean;
  earliestTransactionDate: string | null;
  earliestNavDate: string | null;
}

export interface BenchmarkDemandRow {
  benchmark_id: string;
  required_from: string;
  required_from_investor: string | null;
  required_to: string;
  scheme_count: number;
  family_count: number;
  demand_basis: { rule: string; alignmentLookbackDays: number; mappingCount: number };
}

function min(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

export function aggregateBenchmarkDemand(
  mappings: readonly DemandMapping[],
  instruments: ReadonlyMap<string, DemandInstrument>,
  latestExpectedSession: string
): BenchmarkDemandRow[] {
  interface Acc { from: string | null; investor: string | null; schemes: Set<string>; families: Set<string>; mappings: number }
  const byBenchmark = new Map<string, Acc>();
  for (const m of mappings) {
    const inst = instruments.get(m.instrumentId);
    if (!inst || !inst.held) continue;
    const startTx = inst.earliestTransactionDate;
    const startNav = inst.earliestNavDate;
    const engineStart = min(startTx, startNav);
    if (engineStart === null) continue; // no dated history yet: no demand can be stated honestly
    // Mapping-effective period bounds the demand on both sides.
    const effEnd = m.effectiveTo ?? latestExpectedSession;
    if (effEnd < engineStart) continue; // mapping ended before this scheme's history began
    const clampFrom = (d: string) => (d < m.effectiveFrom ? m.effectiveFrom : d);
    const engineFrom = addDaysIso(clampFrom(engineStart), -ALIGNMENT_LOOKBACK_DAYS);
    const investorFrom = startTx !== null ? addDaysIso(clampFrom(startTx), -ALIGNMENT_LOOKBACK_DAYS) : null;
    const acc = byBenchmark.get(m.benchmarkId) ?? { from: null, investor: null, schemes: new Set<string>(), families: new Set<string>(), mappings: 0 };
    acc.from = min(acc.from, engineFrom);
    acc.investor = min(acc.investor, investorFrom);
    acc.schemes.add(inst.instrumentId);
    acc.families.add(inst.familyKey);
    acc.mappings += 1;
    byBenchmark.set(m.benchmarkId, acc);
  }
  const rows: BenchmarkDemandRow[] = [];
  for (const [benchmarkId, acc] of byBenchmark) {
    if (acc.from === null) continue;
    rows.push({
      benchmark_id: benchmarkId,
      required_from: acc.from,
      required_from_investor: acc.investor,
      required_to: latestExpectedSession,
      scheme_count: acc.schemes.size,
      family_count: acc.families.size,
      demand_basis: { rule: 'min(first transaction, earliest NAV on file) clamped to the mapping-effective start, minus alignment lookback', alignmentLookbackDays: ALIGNMENT_LOOKBACK_DAYS, mappingCount: acc.mappings },
    });
  }
  return rows.sort((a, b) => a.benchmark_id.localeCompare(b.benchmark_id));
}

/** AMC + base scheme name with plan/option words removed: a GROUPING key only (never used to merge instruments). */
export function schemeFamilyKey(amcName: string | null, schemeName: string): string {
  const base = schemeName
    .toLowerCase()
    .replace(/\b(direct|regular|plan|growth|idcw|dividend|payout|reinvestment|option|bonus|-|–)\b/g, ' ')
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${(amcName ?? 'unknown amc').toLowerCase().replace(/\s+mutual fund$/, '').trim()}|${base}`;
}

/**
 * Load the aggregation inputs with the SERVICE-ROLE client (server-side job only)
 * and upsert the per-benchmark demand through upsert_benchmark_history_demand().
 */
export async function refreshBenchmarkHistoryDemand(admin: SupabaseClient, latestExpectedSession: string): Promise<{ benchmarks: number; error: string | null }> {
  const mappingRows = await fetchAllRows<{ instrument_id: string; benchmark_id: string; effective_from: string; effective_to: string | null }>(() =>
    admin
      .from('ii_instrument_benchmarks')
      .select('instrument_id, benchmark_id, effective_from, effective_to')
      .eq('relationship_type', 'primary')
      .neq('quality_status', 'superseded')
      .order('id', { ascending: true })
  );
  if (mappingRows.length === 0) return { benchmarks: 0, error: null };
  const mappings: DemandMapping[] = mappingRows.map((r) => ({ instrumentId: r.instrument_id, benchmarkId: r.benchmark_id, effectiveFrom: r.effective_from, effectiveTo: r.effective_to }));
  const instrumentIds = [...new Set(mappings.map((m) => m.instrumentId))];

  const { data: heldRows, error: heldErr } = await admin.rpc('pc6_user_held_instrument_ids');
  if (heldErr) return { benchmarks: 0, error: `pc6_user_held_instrument_ids: ${heldErr.message}` };
  const held = new Set(((heldRows ?? []) as Array<{ instrument_id: string }>).map((r) => r.instrument_id));

  const earliestTx = new Map<string, string>();
  for (let i = 0; i < instrumentIds.length; i += 100) {
    const slice = instrumentIds.slice(i, i + 100);
    const rows = await fetchAllRows<{ instrument_id: string; transaction_date: string; id: string }>(() =>
      admin.from('ii_transactions').select('id, instrument_id, transaction_date').in('instrument_id', slice).neq('status', 'reversed').neq('status', 'review_required').order('id', { ascending: true })
    );
    for (const r of rows) {
      const cur = earliestTx.get(r.instrument_id);
      if (!cur || r.transaction_date < cur) earliestTx.set(r.instrument_id, r.transaction_date);
    }
  }
  const { data: instRows, error: instErr } = await admin.from('ii_instruments').select('id, instrument_name, amc_name').in('id', instrumentIds);
  if (instErr) return { benchmarks: 0, error: `ii_instruments: ${instErr.message}` };
  const meta = new Map(((instRows ?? []) as Array<{ id: string; instrument_name: string; amc_name: string | null }>).map((r) => [r.id, r]));

  const instruments = new Map<string, DemandInstrument>();
  for (const id of instrumentIds) {
    const { data: nav } = await admin.from('ii_prices_nav').select('price_date').eq('instrument_id', id).eq('quality_status', 'ok').order('price_date', { ascending: true }).limit(1).maybeSingle();
    const m = meta.get(id);
    instruments.set(id, {
      instrumentId: id,
      familyKey: schemeFamilyKey(m?.amc_name ?? null, m?.instrument_name ?? id),
      held: held.has(id),
      earliestTransactionDate: earliestTx.get(id) ?? null,
      earliestNavDate: (nav as { price_date: string } | null)?.price_date ?? null,
    });
  }
  const rows = aggregateBenchmarkDemand(mappings, instruments, latestExpectedSession);
  if (rows.length === 0) return { benchmarks: 0, error: null };
  const { error } = await admin.rpc('upsert_benchmark_history_demand', { p_rows: rows, p_demand_version: DEMAND_VERSION });
  if (error) return { benchmarks: 0, error: error.message };
  return { benchmarks: rows.length, error: null };
}
