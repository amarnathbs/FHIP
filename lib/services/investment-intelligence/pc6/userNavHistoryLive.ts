// Live wiring of the user-scoped NAV history fetch (userNavHistory.ts): the
// REAL adapter chain NAV 1 built (AMFI primary, TIGZIG fallback, built exactly
// as app/api/investment-intelligence/cron/pc6-selective-hydration/route.ts
// builds it) and the REAL hydration deps (createLiveHydrationDeps(): the kill
// switch, scheme code, existing-observation read, writeRows, history floor and
// attempt ledger). Kept apart so userNavHistory.ts stays unit-testable with
// fakes and no live network.
//
// Nothing here enumerates instruments: callers hand in ONE user's id, and
// runUserNavHistoryBatch() reads only that user's own funds.

import { createAdminClient } from '@/lib/supabase/admin';
import { AmfiHistoricalAdapter } from './adapters/amfiHistoricalAdapter';
import { FallbackHistoricalAdapter } from './adapters/fallbackHistoricalAdapter';
import { TigzigHistoricalAdapter } from './adapters/tigzigHistoricalAdapter';
import { createLiveFundHouseResolver, createLiveHydrationDeps } from './selectiveHistoricalHydrationJobLive';
import { runUserNavHistoryBatch, type NavFetchSummaryOutcome, type UserNavHistoryBatchResult, type UserNavHistoryRuntime } from './userNavHistory';

export function createLiveUserNavHistoryRuntime(): UserNavHistoryRuntime {
  return {
    db: createAdminClient(),
    adapter: new FallbackHistoricalAdapter(new AmfiHistoricalAdapter({ resolveFundHouse: createLiveFundHouseResolver() }), new TigzigHistoricalAdapter()),
    deps: createLiveHydrationDeps(),
  };
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** One time-boxed slice of this user's own missing history, against the real sources. */
export async function runLiveUserNavHistoryBatch(userId: string, opts: { onlyInstrumentIds?: readonly string[] } = {}): Promise<UserNavHistoryBatchResult> {
  return runUserNavHistoryBatch({ userId, today: todayIso(), runtime: createLiveUserNavHistoryRuntime(), onlyInstrumentIds: opts.onlyInstrumentIds });
}

/** The fetcher the investment-date flow injects: fetch THIS ONE fund's missing history, report what happened. */
export async function liveFetchNavForOneFund(args: { userId: string; instrumentId: string }): Promise<{ outcome: NavFetchSummaryOutcome }> {
  const result = await runLiveUserNavHistoryBatch(args.userId, { onlyInstrumentIds: [args.instrumentId] });
  if (result.rateLimited) return { outcome: 'rate_limited' };
  const mine = result.attempted.find((a) => a.instrumentId === args.instrumentId);
  return { outcome: mine ? mine.outcome : 'nothing_to_fetch' };
}
