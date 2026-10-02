// Reads the latest Nifty 50 / BSE Sensex close on or before a date, for the
// India Mutual Fund Investment Report header. Read-only, no side effects.
//
// FAILS TO "NOT AVAILABLE", NEVER TO A NUMBER: a missing benchmark row, an
// empty series, a read error, or a close dated after the requested date all
// yield `null`, which the report renders as "not available". Nothing here
// interpolates, carries forward beyond the latest real row, or invents a value.
//
// ENTITLEMENT GATE (BENCH-1 Phase 2, migration 0241). The series row-level
// security only proves the 'calculation' right. These closes are CUSTOMER-VISIBLE
// report content, so, exactly like the other report consumers
// (investmentIntelligenceReportData uses the 'export' need), this reader also
// requires the approved customer-display AND report-export rights from
// benchmark_entitled_actions(), and never reads outside the entitlement's
// data-date scope. No approved entitlement (or a failed lookup) = null =
// "not available". Nothing is ever shown on the strength of licence_status alone.
import type { SupabaseClient } from '@supabase/supabase-js';
import { MARKET_INDEX_KEYS, type MarketIndexKey } from '@/lib/config/investment-intelligence/marketIndexConfig';
import type { MfIndexClose } from '@/lib/engines/investment-intelligence/indiaMfReport';
import { accessAllows, loadBenchmarkAccess } from '../benchmarkAccess';

export interface IndexCloses {
  sensex: MfIndexClose | null;
  nifty: MfIndexClose | null;
}

export async function latestIndexCloseOnOrBefore(supabase: SupabaseClient, key: MarketIndexKey, onOrBefore: string): Promise<MfIndexClose | null> {
  const { data: benchmark, error: bErr } = await supabase.from('ii_benchmarks').select('id').eq('benchmark_key', key).maybeSingle();
  if (bErr || !benchmark) return null;
  const benchmarkId = (benchmark as { id: string }).id;
  const { access, error: accessError } = await loadBenchmarkAccess(supabase, [benchmarkId]);
  const grant = access.get(benchmarkId);
  if (accessError || !accessAllows(grant, 'export') || !grant) return null;
  // Never read past the end of the entitled data-date scope (the latest ELIGIBLE close wins).
  const upper = grant.dataTo !== null && grant.dataTo < onOrBefore ? grant.dataTo : onOrBefore;
  let q = supabase.from('ii_benchmark_series').select('series_date, value, quality_status').eq('benchmark_id', benchmarkId).lte('series_date', upper);
  if (grant.dataFrom !== null) q = q.gte('series_date', grant.dataFrom);
  const { data: row, error } = await q.neq('quality_status', 'superseded').order('series_date', { ascending: false }).limit(1).maybeSingle();
  if (error || !row) return null;
  const value = Number((row as { value: number | string }).value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { date: (row as { series_date: string }).series_date, value };
}

export async function loadIndexCloses(supabase: SupabaseClient, onOrBefore: string): Promise<IndexCloses> {
  const [sensex, nifty] = await Promise.all([
    latestIndexCloseOnOrBefore(supabase, MARKET_INDEX_KEYS.SENSEX, onOrBefore).catch(() => null),
    latestIndexCloseOnOrBefore(supabase, MARKET_INDEX_KEYS.NIFTY_50, onOrBefore).catch(() => null),
  ]);
  return { sensex, nifty };
}
