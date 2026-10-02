// Market-index display series (Nifty 50 and BSE Sensex, PRICE index close).
//
// WHAT THESE ARE. Two header values on the India Mutual Fund Investment
// Report ("BSE Sensex ... / CNX Nifty ..."), taken from the daily closing
// PRICE index. They are display context only. They are deliberately NOT the
// Total Return Index series BENCH-1 uses for fund-vs-benchmark comparison, and
// they are not mapped to any fund in ii_instrument_benchmarks, so loading them
// cannot change a single benchmark comparison anywhere in the platform.
//
// STORAGE. ii_benchmarks / ii_benchmark_series (migrations 0031/0043/0155) —
// reused, per the Product Owner's instruction. Two new ii_benchmarks rows are
// seeded by migration 0231 with licence_status = 'unknown' (they stay
// 'unknown': the per-upload attestation recorded in ii_market_index_batches is
// the rights evidence for these display values; the PC6 licence gate for
// benchmark COMPARISON — which refuses licence_required/unknown benchmarks —
// is left exactly as it was).

export const MARKET_INDEX_KEYS = {
  NIFTY_50: 'IN_NIFTY_50_PRI',
  SENSEX: 'IN_SENSEX_PRI',
} as const;

export type MarketIndexKey = (typeof MARKET_INDEX_KEYS)[keyof typeof MARKET_INDEX_KEYS];

export const MARKET_INDEX_LABELS: Record<MarketIndexKey, string> = {
  IN_NIFTY_50_PRI: 'Nifty 50 (price index close)',
  IN_SENSEX_PRI: 'BSE Sensex (price index close)',
};

export const MARKET_INDEX_KEY_LIST: readonly MarketIndexKey[] = [MARKET_INDEX_KEYS.NIFTY_50, MARKET_INDEX_KEYS.SENSEX];

export function isMarketIndexKey(v: unknown): v is MarketIndexKey {
  return typeof v === 'string' && (MARKET_INDEX_KEY_LIST as readonly string[]).includes(v);
}

/** A latest-close older than this many calendar days is reported stale by the admin page and the updater. */
export const MARKET_INDEX_STALE_AFTER_DAYS = 5;

/** ii_reference_job_control.job_key of the daily updater (ships DISABLED). */
export const MARKET_INDEX_DAILY_JOB_KEY = 'market_index_daily_close' as const;

/** Environment switch that must ALSO be 'true' for the daily updater to run. Absent / anything else = off. */
export const MARKET_INDEX_FEED_ENV_FLAG = 'MARKET_INDEX_FEED_ENABLED' as const;
