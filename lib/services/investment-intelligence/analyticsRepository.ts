// R4 — Analytics data-access layer (spec sections 67, 103-105).
//
// SECURITY MODEL (spec sections 95-96):
//   * Every query is scoped by the SERVER-RESOLVED `userId` taken from the
//     authenticated session. No household, account, instrument or benchmark
//     id is ever accepted from the client and used as a filter — callers
//     pass only a userId that the route derived from `requireUser()`.
//   * Reads use the RLS-respecting request client, so even a bug in a
//     filter cannot cross a tenant boundary.
//   * Writes are confined to ii_analytics_results (derived output) and use
//     the service-role client, because that table deliberately has no
//     authenticated-role insert policy — users must not be able to forge
//     analytics rows.
//
// READ-ONLY GUARANTEE (spec section 58 / FAIL-condition 15): this module
// contains NO insert/update/upsert/delete against any FHIP financial
// register (investments, assets, retirement_accounts, income, expenses,
// liabilities) or any R3 publication table. The only mutation anywhere in
// R4 is the ii_analytics_results insert at the bottom of this file.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { AnalyticsDataset, SchemeDataset, PersistableAnalyticsRow } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import type { BenchmarkMapping } from '@/lib/engines/investment-intelligence/benchmarkEngine';
import type { SeriesPoint } from '@/lib/engines/investment-intelligence/benchmarkService';
import type { RiskFreeRatePoint } from '@/lib/config/investment-intelligence/riskFreeRate';
import type { CashFlow } from '@/lib/engines/investment-intelligence/xirr';

/** Transaction types that represent money leaving the investor (cost). */
const OUTFLOW_TYPES = new Set(['purchase', 'sip', 'switch_in', 'reinvestment', 'fee', 'tax']);
/** Transaction types that represent money returning to the investor. */
const INFLOW_TYPES = new Set(['redemption', 'switch_out', 'dividend']);

export interface LoadWarning {
  scope: string;
  detail: string;
}

export interface LoadResult {
  dataset: AnalyticsDataset | null;
  warnings: LoadWarning[];
  /** True when the user simply has no investment data yet (not an error). */
  empty: boolean;
}

function toDate(s: string): Date {
  // Dates from Postgres `date` columns are 'YYYY-MM-DD'; parse as UTC midnight
  // so no local-timezone shift can move a transaction across a day boundary.
  return new Date(`${s}T00:00:00.000Z`);
}

/**
 * Load everything the AnalyticsOrchestrator needs for ONE user.
 *
 * `userId` MUST come from the authenticated session (never a request
 * parameter). `periodStart`/`asOfDate` are the only caller-tunable inputs
 * and are pure date bounds — they cannot widen data visibility.
 */
export async function loadAnalyticsDataset(
  supabase: SupabaseClient,
  userId: string,
  opts: { periodStart?: Date; asOfDate?: Date } = {}
): Promise<LoadResult> {
  const warnings: LoadWarning[] = [];
  const asOfDate = opts.asOfDate ?? new Date();

  // ---- Positions and their certified history completeness -------------
  const { data: truthRows, error: truthErr } = await supabase
    .from('ii_portfolio_truth_status')
    .select('instrument_id, account_id, history_completeness, status')
    .eq('user_id', userId);
  if (truthErr) throw new Error(`Failed to load portfolio truth status: ${truthErr.message}`);

  const { data: txRows, error: txErr } = await supabase
    .from('ii_transactions')
    .select('instrument_id, transaction_type, transaction_date, gross_amount, currency_code, status')
    .eq('user_id', userId)
    .order('transaction_date', { ascending: true });
  if (txErr) throw new Error(`Failed to load transactions: ${txErr.message}`);

  const { data: snapRows, error: snapErr } = await supabase
    .from('ii_holding_snapshots')
    .select('instrument_id, as_of_date, units, value, currency_code, quality_status')
    .eq('user_id', userId)
    .order('as_of_date', { ascending: true });
  if (snapErr) throw new Error(`Failed to load holding snapshots: ${snapErr.message}`);

  const instrumentIds = [
    ...new Set([
      ...(truthRows ?? []).map((r) => r.instrument_id as string),
      ...(txRows ?? []).map((r) => r.instrument_id as string),
      ...(snapRows ?? []).map((r) => r.instrument_id as string),
    ]),
  ].filter(Boolean);

  if (instrumentIds.length === 0) {
    return { dataset: null, warnings, empty: true };
  }

  // ---- Instrument reference data (world-readable) ---------------------
  const { data: instruments, error: instErr } = await supabase
    .from('ii_instruments')
    .select('id, instrument_name, base_currency, country_of_domicile')
    .in('id', instrumentIds);
  if (instErr) throw new Error(`Failed to load instruments: ${instErr.message}`);
  const instrumentById = new Map((instruments ?? []).map((i) => [i.id as string, i]));

  // ---- NAV history -----------------------------------------------------
  const { data: navRows, error: navErr } = await supabase
    .from('ii_prices_nav')
    .select('instrument_id, price_date, price, data_version, quality_status')
    .in('instrument_id', instrumentIds)
    .order('price_date', { ascending: true });
  if (navErr) throw new Error(`Failed to load NAV history: ${navErr.message}`);

  const navByInstrument = new Map<string, SeriesPoint[]>();
  let navDataVersion: string | null = null;
  let sawSuspectNav = false;
  for (const r of navRows ?? []) {
    if (r.quality_status && r.quality_status !== 'ok') {
      sawSuspectNav = true;
      continue; // never feed a flagged NAV point into a certified calculation
    }
    const list = navByInstrument.get(r.instrument_id as string) ?? [];
    list.push({ date: toDate(r.price_date as string), value: Number(r.price) });
    navByInstrument.set(r.instrument_id as string, list);
    if (r.data_version) navDataVersion = r.data_version as string;
  }
  if (sawSuspectNav) {
    warnings.push({ scope: 'nav', detail: 'Some NAV observations are flagged as stale, superseded or suspicious and were excluded from the calculation.' });
  }

  // ---- Effective-dated benchmark mapping (spec sections 30-31) ---------
  const { mappings, benchmarkIds, mappingVersion, mappingWarnings } = await loadBenchmarkMappings(supabase, instrumentIds);
  warnings.push(...mappingWarnings);

  const benchmarkSeriesById: Record<string, SeriesPoint[]> = {};
  let benchmarkDataVersion: string | null = null;
  if (benchmarkIds.length) {
    const { data: seriesRows, error: seriesErr } = await supabase
      .from('ii_benchmark_series')
      .select('benchmark_id, series_date, value, data_version, quality_status')
      .in('benchmark_id', benchmarkIds)
      .order('series_date', { ascending: true });
    if (seriesErr) throw new Error(`Failed to load benchmark series: ${seriesErr.message}`);
    for (const r of seriesRows ?? []) {
      if (r.quality_status && r.quality_status !== 'ok') continue;
      const id = r.benchmark_id as string;
      benchmarkSeriesById[id] = benchmarkSeriesById[id] ?? [];
      benchmarkSeriesById[id].push({ date: toDate(r.series_date as string), value: Number(r.value) });
      if (r.data_version) benchmarkDataVersion = r.data_version as string;
    }
  }

  // ---- Risk-free reference data ---------------------------------------
  const { riskFreeSeries, riskFreeWarnings } = await loadRiskFreeRates(supabase);
  warnings.push(...riskFreeWarnings);

  // ---- Assemble per-scheme datasets -----------------------------------
  const completenessByInstrument = new Map<string, string | null>();
  for (const r of truthRows ?? []) {
    // If a user holds the same instrument in several accounts, the WEAKEST
    // completeness governs — never the most flattering one.
    const existing = completenessByInstrument.get(r.instrument_id as string);
    const next = r.history_completeness as string | null;
    completenessByInstrument.set(
      r.instrument_id as string,
      existing === undefined ? next : weakestCompleteness(existing, next)
    );
  }

  const schemes: SchemeDataset[] = [];
  let earliest: Date | null = null;

  for (const instrumentId of instrumentIds) {
    const inst = instrumentById.get(instrumentId);
    if (!inst) continue;

    const txs = (txRows ?? []).filter((t) => t.instrument_id === instrumentId && t.status !== 'reversed');
    const snaps = (snapRows ?? []).filter((s) => s.instrument_id === instrumentId);

    const cashFlows: CashFlow[] = [];
    for (const t of txs) {
      const amount = Number(t.gross_amount);
      const type = t.transaction_type as string;
      if (OUTFLOW_TYPES.has(type)) cashFlows.push({ date: toDate(t.transaction_date as string), amount: -Math.abs(amount) });
      else if (INFLOW_TYPES.has(type)) cashFlows.push({ date: toDate(t.transaction_date as string), amount: Math.abs(amount) });
      // 'transfer', 'merger', 'adjustment' are unit-movement events with no
      // investor cash impact; deliberately excluded rather than guessed at.
    }

    const valuationSeries: SeriesPoint[] = snaps.map((s) => ({ date: toDate(s.as_of_date as string), value: Number(s.value) }));
    const latest = valuationSeries.length ? valuationSeries[valuationSeries.length - 1] : undefined;
    const currentValue = latest?.value ?? 0;
    const currentValueDate = latest?.date ?? asOfDate;

    // Terminal synthetic flow: the position's current value, positive.
    if (currentValue > 0) cashFlows.push({ date: currentValueDate, amount: currentValue });
    cashFlows.sort((a, b) => a.date.getTime() - b.date.getTime());
    if (cashFlows.length && (!earliest || cashFlows[0].date < earliest)) earliest = cashFlows[0].date;

    schemes.push({
      instrumentId,
      instrumentName: inst.instrument_name as string,
      currencyCode: (txs[0]?.currency_code as string) ?? (snaps[0]?.currency_code as string) ?? (inst.base_currency as string),
      countryOfDomicile: inst.country_of_domicile as string,
      historyCompleteness: completenessByInstrument.get(instrumentId) ?? null,
      optionType: null, // populated when R2 scheme-option metadata is available
      hasDistributionAdjustment: false,
      cashFlows,
      currentValue,
      currentValueDate,
      navSeries: navByInstrument.get(instrumentId) ?? [],
      valuationSeries,
    });
  }

  if (schemes.length === 0) return { dataset: null, warnings, empty: true };

  // The effective as-of date is the latest date for which certified data
  // actually exists, not "today". Running the period out to today would
  // flat-extrapolate the last known valuation across every intervening
  // month (valueOnOrBefore keeps returning the final point), inventing
  // zero-return periods that dilute the benchmark blend and misdescribe the
  // period in the UI. An explicitly requested asOfDate is still honoured,
  // but is likewise capped to the data.
  let latestDataDate: Date | null = null;
  for (const s of schemes) {
    for (const p of s.valuationSeries) {
      if (!latestDataDate || p.date > latestDataDate) latestDataDate = p.date;
    }
  }
  const effectiveAsOf =
    latestDataDate === null
      ? asOfDate
      : opts.asOfDate
        ? new Date(Math.min(opts.asOfDate.getTime(), latestDataDate.getTime()))
        : latestDataDate;

  if (latestDataDate && asOfDate.getTime() - latestDataDate.getTime() > 45 * 86_400_000) {
    warnings.push({
      scope: 'data_currency',
      detail: `The most recent certified valuation is dated ${latestDataDate.toISOString().slice(0, 10)}. Figures are calculated up to that date, not to today.`,
    });
  }

  return {
    dataset: {
      userId,
      asOfDate: effectiveAsOf,
      periodStart: opts.periodStart ?? earliest ?? asOfDate,
      schemes,
      mappings,
      benchmarkSeriesById,
      riskFreeSeries,
      navDataVersion,
      benchmarkDataVersion,
      benchmarkMappingVersion: mappingVersion,
      frequency: 'monthly',
    },
    warnings,
    empty: false,
  };
}

const COMPLETENESS_RANK: Record<string, number> = {
  complete_from_inception: 3,
  complete_from_known_opening_balance: 2,
  partial_history: 1,
  holdings_only: 0,
};

function weakestCompleteness(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return (COMPLETENESS_RANK[a] ?? 0) <= (COMPLETENESS_RANK[b] ?? 0) ? a : b;
}

async function loadBenchmarkMappings(
  supabase: SupabaseClient,
  instrumentIds: string[]
): Promise<{ mappings: BenchmarkMapping[]; benchmarkIds: string[]; mappingVersion: string | null; mappingWarnings: LoadWarning[] }> {
  const mappingWarnings: LoadWarning[] = [];
  const { data, error } = await supabase
    .from('ii_instrument_benchmarks')
    .select('instrument_id, benchmark_id, relationship_type, effective_from, effective_to, mapping_version, quality_status, ii_benchmarks(benchmark_key, return_type)')
    .in('instrument_id', instrumentIds)
    .eq('relationship_type', 'primary');

  if (error) {
    // Clean error handling (spec section 105): a reference-data schema gap
    // degrades to "no benchmark" with a disclosed reason — it never 500s and
    // never silently yields a 0% benchmark return.
    mappingWarnings.push({
      scope: 'benchmark_mapping',
      detail: `Benchmark mapping reference data is unavailable (${error.message}). Benchmark-relative figures are withheld.`,
    });
    return { mappings: [], benchmarkIds: [], mappingVersion: null, mappingWarnings };
  }

  const mappings: BenchmarkMapping[] = [];
  let mappingVersion: string | null = null;
  let sawAmbiguous = false;

  for (const r of data ?? []) {
    if (r.quality_status === 'ambiguous') {
      sawAmbiguous = true;
      continue; // an ambiguous mapping must not silently drive a comparison
    }
    if (r.quality_status === 'superseded') continue;
    const bench = (Array.isArray(r.ii_benchmarks) ? r.ii_benchmarks[0] : r.ii_benchmarks) as
      | { benchmark_key: string; return_type: string | null }
      | undefined;
    if (!bench) continue;
    mappings.push({
      instrumentId: r.instrument_id as string,
      benchmarkId: r.benchmark_id as string,
      benchmarkKey: bench.benchmark_key,
      returnType: (bench.return_type ?? 'OTHER') as BenchmarkMapping['returnType'],
      effectiveFrom: toDate((r.effective_from as string) ?? '1900-01-01'),
      effectiveTo: r.effective_to ? toDate(r.effective_to as string) : null,
    });
    if (r.mapping_version) mappingVersion = r.mapping_version as string;
  }

  if (sawAmbiguous) {
    mappingWarnings.push({
      scope: 'benchmark_mapping',
      detail: 'One or more benchmark mappings are flagged ambiguous and were excluded rather than used to drive a comparison.',
    });
  }

  return { mappings, benchmarkIds: [...new Set(mappings.map((m) => m.benchmarkId))], mappingVersion, mappingWarnings };
}

async function loadRiskFreeRates(
  supabase: SupabaseClient
): Promise<{ riskFreeSeries: RiskFreeRatePoint[]; riskFreeWarnings: LoadWarning[] }> {
  const { data, error } = await supabase
    .from('ii_risk_free_rates')
    .select('country_code, period_start, period_end, annualised_rate, source, method, version');

  if (error) {
    return {
      riskFreeSeries: [],
      riskFreeWarnings: [
        {
          scope: 'risk_free',
          detail: `Risk-free reference data is unavailable (${error.message}). Sharpe, Sortino and alpha are withheld rather than calculated against an assumed rate.`,
        },
      ],
    };
  }

  const riskFreeSeries: RiskFreeRatePoint[] = (data ?? []).map((r) => ({
    countryCode: r.country_code as string,
    periodStart: toDate(r.period_start as string),
    periodEnd: toDate(r.period_end as string),
    annualisedRate: Number(r.annualised_rate),
    source: r.source as string,
    method: r.method as string,
    version: r.version as string,
  }));

  const riskFreeWarnings: LoadWarning[] = riskFreeSeries.length
    ? []
    : [{ scope: 'risk_free', detail: 'No risk-free reference data has been loaded yet, so risk-adjusted ratios are withheld.' }];

  return { riskFreeSeries, riskFreeWarnings };
}

/**
 * Persist derived analytics rows. Service-role client ONLY: the table has
 * no authenticated-role insert policy by design, so a client can never
 * forge a result row (SEC-R4 "fake-analytics-insertion rejection").
 *
 * `user_id` on every row is overwritten with the server-resolved id, so a
 * caller cannot persist rows attributed to another user even by mistake.
 */
export async function persistAnalyticsRows(userId: string, rows: PersistableAnalyticsRow[]): Promise<{ persisted: number }> {
  if (rows.length === 0) return { persisted: 0 };
  const admin = createAdminClient();
  const scoped = rows.map((r) => ({ ...r, user_id: userId }));
  const { error } = await admin
    .from('ii_analytics_results')
    .upsert(scoped, { onConflict: 'user_id,scope_type,scope_id,metric_key,input_snapshot_version,engine_version', ignoreDuplicates: true });
  if (error) throw new Error(`Failed to persist analytics results: ${error.message}`);
  return { persisted: scoped.length };
}
