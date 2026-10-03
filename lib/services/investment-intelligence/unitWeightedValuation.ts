// Investment Intelligence — reconstructs a genuine, dated valuation SERIES
// for a position by replaying its own certified transaction ledger's signed
// unit deltas (the same deterministic taxonomy reconciliation.ts already
// uses to certify holdings — unitDeltaForTransaction, never a second,
// independently-guessed direction table) against the daily NAV feed (NAV1 /
// pc6_selective_historical_hydration writes ii_prices_nav every day).
//
// WHY THIS EXISTS (production defect found 2026-09-29, PO report: the performance
// figures and active-return-vs-benchmark showing "not enough history" for holdings
// that plainly have years of NAV price history). Confirmed live against
// production (twwpnltizhtjxhamyoxt): EVERY row in ii_holding_snapshots — the
// ONLY source analyticsRepository.ts ever built SchemeDataset.valuationSeries
// from — carries exactly ONE as_of_date per (user, instrument): the date of
// the investor's most recently uploaded statement (53/53 rows in production,
// one distinct date each). A benchmark blend needs at least a start AND an end
// valuation; a single point can never satisfy that, no matter how many YEARS of daily NAV price history
// the platform has actually hydrated for the instrument — which is why
// "not enough history" was showing up on funds NAV1 has priced back to 2006.
// The gap was never NAV coverage; it was that the daily NAV feed was never
// used to build a valuation TIME SERIES, only a single terminal
// mark-to-market point (analyticsRepository.ts's currentValue enrichment,
// commit 4072260) and the per-scheme SINCE_INCEPTION CAGR (which reads
// navSeries directly and was never actually blocked by this).
//
// This module is PURE (no I/O) and produces a DERIVED, not certified,
// series. The caller (analyticsRepository.ts) is responsible for only
// attempting this reconstruction when the position's own certified
// reconciliation supports it (history_completeness === 'complete_from_inception'
// AND unit_variance_within_tolerance), so a position with a known-incomplete
// or unreconciled unit ledger never gets a fabricated valuation history —
// it simply falls back to the single certified snapshot point, exactly as
// before this module existed.

import { fromPlainNumber, scaledToNumber, ZERO } from './decimal';
import { unitDeltaForTransaction } from './reconciliation';
import type { IiTransactionType } from './types';
import type { SeriesPoint } from '@/lib/engines/investment-intelligence/benchmarkService';

export interface UnitLedgerTransaction {
  date: Date;
  transactionType: IiTransactionType;
  /** Parsed unit count for this single transaction line, as certified on the statement. null when the source never carried a unit figure for this line (e.g. a currency-only fee/tax charge). */
  units: number | null;
}

/**
 * Replay a position's own signed unit deltas against a daily NAV series to
 * produce a dated valuation at every NAV observation from the position's
 * first unit-acquiring transaction onward.
 *
 * Returns [] when there is no unit-acquiring transaction to anchor a running
 * balance from — this NEVER fabricates a series starting from an assumed
 * zero opening balance; it only replays what the certified transaction
 * ledger actually records.
 */
export function buildUnitWeightedValuationSeries(
  transactions: UnitLedgerTransaction[],
  navSeries: SeriesPoint[]
): SeriesPoint[] {
  if (transactions.length === 0 || navSeries.length === 0) return [];

  const sortedTx = [...transactions].sort((a, b) => a.date.getTime() - b.date.getTime());

  // Running balance AFTER each transaction date — same-date transactions
  // accumulate onto one checkpoint, so same-day ordering ambiguity can never
  // create a spurious intermediate intra-day balance.
  const checkpoints: Array<{ time: number; balance: bigint }> = [];
  let running: bigint = ZERO;
  let sawAcquisition = false;
  for (const t of sortedTx) {
    const delta = unitDeltaForTransaction({
      canonicalType: t.transactionType,
      unitsScaled: t.units === null ? null : fromPlainNumber(t.units),
    });
    if (delta === ZERO) continue;
    running = running + delta;
    if (delta > ZERO) sawAcquisition = true;
    const time = t.date.getTime();
    if (checkpoints.length && checkpoints[checkpoints.length - 1].time === time) {
      checkpoints[checkpoints.length - 1].balance = running;
    } else {
      checkpoints.push({ time, balance: running });
    }
  }
  if (!sawAcquisition || checkpoints.length === 0) return [];

  const firstAcquisitionTime = checkpoints[0].time;
  const sortedNav = [...navSeries].sort((a, b) => a.date.getTime() - b.date.getTime());

  const out: SeriesPoint[] = [];
  let cpIndex = -1;
  for (const nav of sortedNav) {
    const t = nav.date.getTime();
    if (t < firstAcquisitionTime) continue;
    while (cpIndex + 1 < checkpoints.length && checkpoints[cpIndex + 1].time <= t) cpIndex++;
    const balance = cpIndex >= 0 ? checkpoints[cpIndex].balance : ZERO;
    if (balance <= ZERO) continue; // fully redeemed as of this NAV date — no position to value
    out.push({ date: nav.date, value: scaledToNumber(balance) * nav.value });
  }
  return out;
}
