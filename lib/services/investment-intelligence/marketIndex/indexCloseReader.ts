// Reads the latest Nifty 50 / BSE Sensex close on or before a date, for the
// India Mutual Fund Investment Report header. Read-only, no side effects.
//
// FAILS TO "NOT AVAILABLE", NEVER TO A NUMBER: a missing benchmark row, an
// empty series, a read error, or a close dated after the requested date all
// yield `null`, which the report renders as "not available". Nothing here
// interpolates, carries forward beyond the latest real row, or invents a value.
import type { SupabaseClient } from '@supabase/supabase-js';
import { MARKET_INDEX_KEYS, type MarketIndexKey } from '@/lib/config/investment-intelligence/marketIndexConfig';
import type { MfIndexClose } from '@/lib/engines/investment-intelligence/indiaMfReport';

export interface IndexCloses {
  sensex: MfIndexClose | null;
  nifty: MfIndexClose | null;
}

export async function latestIndexCloseOnOrBefore(supabase: SupabaseClient, key: MarketIndexKey, onOrBefore: string): Promise<MfIndexClose | null> {
  const { data: benchmark, error: bErr } = await supabase.from('ii_benchmarks').select('id').eq('benchmark_key', key).maybeSingle();
  if (bErr || !benchmark) return null;
  const { data: row, error } = await supabase
    .from('ii_benchmark_series')
    .select('series_date, value, quality_status')
    .eq('benchmark_id', (benchmark as { id: string }).id)
    .lte('series_date', onOrBefore)
    .neq('quality_status', 'superseded')
    .order('series_date', { ascending: false })
    .limit(1)
    .maybeSingle();
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
