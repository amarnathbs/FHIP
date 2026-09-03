// II-PC2 — the workspace Overview's data gatherer (spec sections 10, 11, 39,
// 40).
//
// THE HARD CONSTRAINT ON THIS FILE
// --------------------------------
// Spec section 11: "Overview may aggregate existing statuses and values. It
// must NOT independently compute returns, tax, risk, benchmark, SIP
// analytics, X-Ray exposure."
// Spec section 40: opening Overview must not become equivalent to executing
// every analytics engine.
//
// Both are enforced structurally: this module imports NO engine and calls NO
// analytics route. Every read below is a plain table select or a PostgREST
// `head:true` count.
//
// That is not merely a performance preference. Three of the five analytics
// GET routes (`/sip`, `/xray`, `/tax/summary`) PERSIST derived rows as a side
// effect of being read — `/tax/summary` writes to three tables. Calling them
// to populate status cards would mean that merely opening the Overview
// rewrote the user's tax lots and capital-gains computations. This module
// exists so that can never happen.

import type { SupabaseClient } from '@supabase/supabase-js';
import { DISPOSAL_TYPES } from './taxRepository';
import { fetchAllRows } from './pagination';
import type { OverviewSignals } from '@/lib/investment-intelligence/analysisAvailability';

/**
 * Acquisition-side transaction vocabulary, i.e. what can constitute a
 * recurring contribution. Mirrors the R5 attribution engine's own
 * ACQUISITION_TYPES (lib/engines/investment-intelligence/sip/sipAttribution.ts)
 * — kept as a named constant here rather than an import because that one is
 * module-private and deliberately internal to the attribution algorithm; the
 * two are asserted equal by the PC2 unit suite so they cannot silently drift.
 */
export const ACQUISITION_TRANSACTION_TYPES = ['purchase', 'sip', 'switch_in', 'reinvestment', 'merger'] as const;

/** Instrument classes that a look-through (X-Ray) analysis can apply to at all. */
export const LOOK_THROUGH_INSTRUMENT_CLASSES = ['mutual_fund', 'etf'] as const;

export interface PortfolioValueByCurrency {
  currencyCode: string;
  totalValue: number;
  positionCount: number;
}

export interface OverviewSummary {
  /** What do I have? (spec section 10) */
  portfolio: {
    positionCount: number;
    accountCount: number;
    instrumentCount: number;
    /**
     * Deliberately PER CURRENCY and never a single blended figure: summing an
     * INR mutual-fund holding and a non-INR holding into one number would be a
     * fabricated total. Callers render each currency separately.
     */
    valueByCurrency: PortfolioValueByCurrency[];
    /** Distinct instrument classes held, e.g. ['mutual_fund','equity']. */
    instrumentClasses: string[];
    /** Newest holding as-of date across all positions, or null. */
    latestAsOfDate: string | null;
    /** Oldest "latest snapshot" date — how stale the stalest position is. */
    oldestAsOfDate: string | null;
  };
  /** Is my data ready? (spec section 10) */
  dataQuality: {
    documentCount: number;
    documentStatusCounts: Record<string, number>;
    certifiedPositionCount: number;
    reconciliationRequiredPositionCount: number;
    openReconciliationCaseCount: number;
    publishedPositionCount: number;
    openReviewItemCount: number;
  };
  /** Inputs the availability model consumes. Returned for traceability. */
  signals: OverviewSignals;
}

interface SnapshotRow {
  account_id: string;
  instrument_id: string;
  as_of_date: string;
  value: number | string | null;
  currency_code: string;
}

/**
 * Bounded read used ONLY for zero-vs-non-zero coverage decisions.
 *
 * PostgREST silently caps an unbounded select, so a truncated result can
 * never be treated as a complete set. Every caller below uses the result for
 * exactly one load-bearing question — "is this count zero?" — and truncation
 * cannot turn a non-zero into a zero, so the cap is safe here in a way it
 * would NOT be for a financial figure.
 */
const COVERAGE_PROBE_LIMIT = 1000;

type CountFilter = { column: string; op: 'eq'; value: string } | { column: string; op: 'in'; value: readonly string[] };

/**
 * `head: true` + `count: 'exact'` — PostgREST returns the count in a header
 * and NO rows at all, so this stays O(1) in transferred bytes no matter how
 * many transactions the user has.
 */
async function countRows(supabase: SupabaseClient, table: string, userId: string, filter?: CountFilter): Promise<number> {
  const base = supabase.from(table).select('*', { count: 'exact', head: true }).eq('user_id', userId);
  const q = !filter ? base : filter.op === 'eq' ? base.eq(filter.column, filter.value) : base.in(filter.column, [...filter.value]);
  const { count, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

/**
 * Build the Overview summary for one user.
 *
 * `supabase` MUST be the request-scoped RLS client — every query below also
 * filters `user_id` explicitly, so tenancy is enforced twice (RLS policy plus
 * predicate), matching the convention every other II user-facing route uses.
 */
export async function buildOverviewSummary(supabase: SupabaseClient, userId: string): Promise<OverviewSummary> {
  // --- 1. Positions: latest snapshot per (account, instrument) --------------
  // Paged, not capped: a position whose newest snapshot falls past the
  // PostgREST cap would otherwise vanish from the user's portfolio entirely
  // (the exact defect R6-P0 fixed on the positions route).
  const snapshots = await fetchAllRows<SnapshotRow>(() =>
    supabase
      .from('ii_holding_snapshots')
      .select('account_id, instrument_id, as_of_date, value, currency_code')
      .eq('user_id', userId)
      .order('as_of_date', { ascending: false })
      .order('id', { ascending: true })
  );
  const latestByPosition = new Map<string, SnapshotRow>();
  for (const row of snapshots) {
    const key = `${row.account_id}:${row.instrument_id}`;
    if (!latestByPosition.has(key)) latestByPosition.set(key, row);
  }
  const positions = [...latestByPosition.values()];
  const heldInstrumentIds = [...new Set(positions.map((p) => p.instrument_id))];
  const accountIds = new Set(positions.map((p) => p.account_id));

  const byCurrency = new Map<string, PortfolioValueByCurrency>();
  for (const p of positions) {
    const cur = p.currency_code;
    const entry = byCurrency.get(cur) ?? { currencyCode: cur, totalValue: 0, positionCount: 0 };
    entry.totalValue += Number(p.value ?? 0);
    entry.positionCount += 1;
    byCurrency.set(cur, entry);
  }
  const asOfDates = positions.map((p) => p.as_of_date).filter(Boolean).sort();

  // --- 2. Cheap status counts ----------------------------------------------
  const [truthRows, docRows, openCaseCount, publishedCount, openReviewItemCount, reviewItemCount] = await Promise.all([
    (async () => {
      const { data, error } = await supabase.from('ii_portfolio_truth_status').select('status').eq('user_id', userId).limit(COVERAGE_PROBE_LIMIT);
      if (error) throw new Error(`ii_portfolio_truth_status: ${error.message}`);
      return data ?? [];
    })(),
    (async () => {
      const { data, error } = await supabase.from('ii_source_documents').select('status').eq('user_id', userId).limit(COVERAGE_PROBE_LIMIT);
      if (error) throw new Error(`ii_source_documents: ${error.message}`);
      return data ?? [];
    })(),
    countRows(supabase, 'ii_reconciliation_cases', userId, { column: 'status', op: 'eq', value: 'open' }),
    countRows(supabase, 'ii_fhip_publications', userId, { column: 'status', op: 'eq', value: 'published' }),
    countRows(supabase, 'ii_review_items', userId, { column: 'status', op: 'eq', value: 'open' }),
    countRows(supabase, 'ii_review_items', userId),
  ]);

  const certifiedPositionCount = truthRows.filter((r) => r.status === 'certified' || r.status === 'certified_with_warnings').length;
  const reconciliationRequiredPositionCount = truthRows.filter((r) => r.status === 'reconciliation_required').length;
  const documentStatusCounts: Record<string, number> = {};
  for (const d of docRows) documentStatusCounts[d.status] = (documentStatusCounts[d.status] ?? 0) + 1;

  // --- 3. Transaction shape (counts only — no transaction rows are read) ----
  const [transactionCount, contributionCount, disposalCount] = await Promise.all([
    countRows(supabase, 'ii_transactions', userId),
    countRows(supabase, 'ii_transactions', userId, { column: 'transaction_type', op: 'in', value: ACQUISITION_TRANSACTION_TYPES }),
    countRows(supabase, 'ii_transactions', userId, { column: 'transaction_type', op: 'in', value: [...DISPOSAL_TYPES] }),
  ]);

  // --- 4. Reference-data coverage for the instruments actually held ---------
  let instrumentClasses: string[] = [];
  let lookThroughEligibleInstrumentCount = 0;
  let instrumentsWithNavCount = 0;
  let instrumentsWithBenchmarkCount = 0;
  let instrumentsWithFundHoldingsCount = 0;

  if (heldInstrumentIds.length > 0) {
    const [instrumentRows, navRows, benchmarkRows, fundHoldingRows] = await Promise.all([
      (async () => {
        const { data, error } = await supabase.from('ii_instruments').select('id, instrument_class').in('id', heldInstrumentIds);
        if (error) throw new Error(`ii_instruments: ${error.message}`);
        return data ?? [];
      })(),
      (async () => {
        const { data, error } = await supabase.from('ii_prices_nav').select('instrument_id').in('instrument_id', heldInstrumentIds).limit(COVERAGE_PROBE_LIMIT);
        if (error) throw new Error(`ii_prices_nav: ${error.message}`);
        return data ?? [];
      })(),
      (async () => {
        const { data, error } = await supabase
          .from('ii_instrument_benchmarks')
          .select('instrument_id')
          .in('instrument_id', heldInstrumentIds)
          .limit(COVERAGE_PROBE_LIMIT);
        if (error) throw new Error(`ii_instrument_benchmarks: ${error.message}`);
        return data ?? [];
      })(),
      (async () => {
        const { data, error } = await supabase
          .from('ii_fund_holdings_snapshots')
          .select('instrument_id')
          .in('instrument_id', heldInstrumentIds)
          .limit(COVERAGE_PROBE_LIMIT);
        if (error) throw new Error(`ii_fund_holdings_snapshots: ${error.message}`);
        return data ?? [];
      })(),
    ]);

    instrumentClasses = [...new Set(instrumentRows.map((r) => r.instrument_class as string))].sort();
    lookThroughEligibleInstrumentCount = instrumentRows.filter((r) =>
      (LOOK_THROUGH_INSTRUMENT_CLASSES as readonly string[]).includes(r.instrument_class as string)
    ).length;
    instrumentsWithNavCount = new Set(navRows.map((r) => r.instrument_id as string)).size;
    instrumentsWithBenchmarkCount = new Set(benchmarkRows.map((r) => r.instrument_id as string)).size;
    instrumentsWithFundHoldingsCount = new Set(fundHoldingRows.map((r) => r.instrument_id as string)).size;
  }

  const signals: OverviewSignals = {
    positionCount: positions.length,
    certifiedPositionCount,
    reconciliationRequiredPositionCount,
    openReconciliationCaseCount: openCaseCount,
    transactionCount,
    contributionCount,
    disposalCount,
    instrumentsWithNavCount,
    instrumentsWithBenchmarkCount,
    instrumentsWithFundHoldingsCount,
    lookThroughEligibleInstrumentCount,
    openReviewItemCount,
    reviewItemCount,
  };

  return {
    portfolio: {
      positionCount: positions.length,
      accountCount: accountIds.size,
      instrumentCount: heldInstrumentIds.length,
      valueByCurrency: [...byCurrency.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode)),
      instrumentClasses,
      latestAsOfDate: asOfDates.length ? asOfDates[asOfDates.length - 1] : null,
      oldestAsOfDate: asOfDates.length ? asOfDates[0] : null,
    },
    dataQuality: {
      documentCount: docRows.length,
      documentStatusCounts,
      certifiedPositionCount,
      reconciliationRequiredPositionCount,
      openReconciliationCaseCount: openCaseCount,
      publishedPositionCount: publishedCount,
      openReviewItemCount,
    },
    signals,
  };
}
