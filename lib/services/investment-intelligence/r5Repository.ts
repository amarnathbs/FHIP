// Investment Intelligence R5 — data-access layer for SIP Intelligence and
// Portfolio X-Ray.
//
// SECURITY MODEL (spec sections 77-78, 96) — identical discipline to R4's
// analyticsRepository.ts:
//   * Every query is scoped by the SERVER-RESOLVED `userId` taken from the
//     authenticated session. No household, account, instrument, benchmark or
//     fund-holdings id is ever accepted from the client and used as a filter.
//   * Reads use the RLS-respecting request client, so even a filter bug
//     cannot cross a tenant boundary.
//   * Authoritative inputs — benchmark identity, benchmark series, NAV
//     series, fund-holdings weights, security classifications — are resolved
//     ENTIRELY server-side. A client may ask "calculate my SIP"; it may never
//     supply the numbers that decide the answer.
//   * Writes are confined to ii_r5_analytics_results / ii_sip_series (derived
//     output) and use the service-role client, because those tables
//     deliberately have no authenticated-role insert policy.
//
// READ-ONLY GUARANTEE (critical-FAIL item 21): this module contains NO
// insert/update/upsert/delete against any FHIP financial register
// (investments, assets, retirement_accounts, income, expenses, liabilities)
// or any R3 publication table. R5 cannot change net worth.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SipCandidateTransaction } from '@/lib/engines/investment-intelligence/sip/sipDetection';
import type { SipDataset } from '@/lib/engines/investment-intelligence/sip/sipOrchestrator';
import type { XrayDataset } from '@/lib/engines/investment-intelligence/xray/xrayOrchestrator';
import type { FundHoldingsSnapshot, PortfolioFundPosition, SnapshotHolding } from '@/lib/engines/investment-intelligence/xray/lookThrough';
import type { DebtExposureLine } from '@/lib/engines/investment-intelligence/xray/debtXray';
import type { Observation } from '@/lib/engines/investment-intelligence/sip/dateAlignment';

export interface LoadWarning {
  scope: string;
  detail: string;
}

export interface R5LoadResult<T> {
  dataset: T | null;
  warnings: LoadWarning[];
  empty: boolean;
}

/** Types whose cash movement can be attributed back to a SIP series. */
const ATTRIBUTABLE_INFLOW_TYPES = new Set(['redemption', 'dividend']);

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// SIP dataset
// ---------------------------------------------------------------------------

export async function loadSipDataset(
  supabase: SupabaseClient,
  userId: string,
  options: { asOfDate?: string } = {}
): Promise<R5LoadResult<SipDataset>> {
  const warnings: LoadWarning[] = [];

  const { data: txnRows, error: txnErr } = await supabase
    .from('ii_transactions')
    .select('id, account_id, instrument_id, transaction_type, transaction_date, gross_amount, units, currency_code, source_reference, status')
    .eq('user_id', userId)
    .order('transaction_date', { ascending: true });
  if (txnErr) throw new Error(`Could not load transactions: ${txnErr.message}`);

  // R2 remains transaction truth: reversed/corrected rows are excluded from
  // the analytical view, but nothing is rewritten.
  const usable = (txnRows ?? []).filter((r) => r.status !== 'reversed');
  if (usable.length === 0) {
    return { dataset: null, warnings, empty: true };
  }

  const transactions: SipCandidateTransaction[] = usable.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    instrumentId: r.instrument_id,
    transactionType: r.transaction_type,
    transactionDate: r.transaction_date,
    grossAmount: Math.abs(Number(r.gross_amount)),
    units: r.units === null ? null : Number(r.units),
    currencyCode: r.currency_code,
    sourceDescription: r.source_reference,
  }));

  const instrumentIds = [...new Set(transactions.map((t) => t.instrumentId))];

  // The analysis as-of date is capped to real data: never silently "today"
  // when the underlying data is older (spec section 99, and R4's own
  // corrected as-of-date behaviour).
  const latestTxnDate = transactions[transactions.length - 1].transactionDate;
  const requestedAsOf = options.asOfDate ?? todayIso();

  const { data: navRows, error: navErr } = await supabase
    .from('ii_prices_nav')
    .select('instrument_id, price_date, price, quality_status')
    .in('instrument_id', instrumentIds)
    .order('price_date', { ascending: true });
  if (navErr) throw new Error(`Could not load NAV history: ${navErr.message}`);

  const navByInstrument = new Map<string, Observation[]>();
  let latestNavDate: string | null = null;
  for (const r of navRows ?? []) {
    if (r.quality_status === 'superseded') continue;
    const list = navByInstrument.get(r.instrument_id) ?? [];
    list.push({ date: r.price_date, value: Number(r.price) });
    navByInstrument.set(r.instrument_id, list);
    if (!latestNavDate || r.price_date > latestNavDate) latestNavDate = r.price_date;
  }
  if (navByInstrument.size === 0) {
    warnings.push({ scope: 'nav', detail: 'No NAV history is available, so ending values and money-weighted returns cannot be calculated for any series.' });
  }

  const dataCeiling = latestNavDate && latestNavDate > latestTxnDate ? latestNavDate : latestTxnDate;
  const asOfDate = requestedAsOf > dataCeiling ? dataCeiling : requestedAsOf;
  if (asOfDate !== requestedAsOf) {
    warnings.push({
      scope: 'as_of_date',
      detail: `The analysis date has been set to ${asOfDate}, the most recent date for which real data exists, rather than ${requestedAsOf}.`,
    });
  }

  // Benchmark resolution is entirely server-side. The client cannot name a
  // benchmark id (spec section 97).
  const benchmarkByInstrument = await loadBenchmarkSeries(supabase, instrumentIds, warnings);

  // Attributable inflows, grouped by (account, instrument) then matched to
  // series keys by the caller's series detection. Here we key by the
  // account:instrument pair prefix that every series key starts with.
  const inflowsByPair = new Map<string, Array<{ date: string; amount: number }>>();
  for (const t of transactions) {
    if (!ATTRIBUTABLE_INFLOW_TYPES.has(t.transactionType)) continue;
    const k = `${t.accountId}:${t.instrumentId}`;
    const list = inflowsByPair.get(k) ?? [];
    list.push({ date: t.transactionDate, amount: Math.abs(t.grossAmount) });
    inflowsByPair.set(k, list);
  }

  const { data: instrumentRows } = await supabase.from('ii_instruments').select('id, instrument_name').in('id', instrumentIds);
  const instrumentNames = new Map((instrumentRows ?? []).map((r) => [r.id as string, r.instrument_name as string]));

  return {
    dataset: {
      userId,
      asOfDate,
      transactions,
      navByInstrument,
      benchmarkByInstrument,
      // Series keys are `${accountId}:${instrumentId}:${discriminator}`, so a
      // prefix lookup is exact and unambiguous.
      attributableInflowsBySeries: new Map(),
      instrumentNames,
    },
    warnings,
    empty: false,
  };
}

/** Attach inflows to concrete series keys once detection has run. */
export function attachAttributableInflows(dataset: SipDataset, seriesKeys: string[]): void {
  const byPair = new Map<string, Array<{ date: string; amount: number }>>();
  for (const t of dataset.transactions) {
    if (!ATTRIBUTABLE_INFLOW_TYPES.has(t.transactionType)) continue;
    const k = `${t.accountId}:${t.instrumentId}`;
    const list = byPair.get(k) ?? [];
    list.push({ date: t.transactionDate, amount: Math.abs(t.grossAmount) });
    byPair.set(k, list);
  }
  const map = new Map<string, Array<{ date: string; amount: number }>>();
  // Attribute an inflow ONLY when the (account, instrument) has exactly one
  // series. With several mandates in one fund, a redemption cannot be
  // attributed to a specific mandate without an uncertified assumption, so it
  // is deliberately withheld — attribution then reports the fund as mixed.
  const countByPair = new Map<string, number>();
  for (const key of seriesKeys) {
    const pair = key.split(':').slice(0, 2).join(':');
    countByPair.set(pair, (countByPair.get(pair) ?? 0) + 1);
  }
  for (const key of seriesKeys) {
    const pair = key.split(':').slice(0, 2).join(':');
    if ((countByPair.get(pair) ?? 0) === 1) map.set(key, byPair.get(pair) ?? []);
    else map.set(key, []);
  }
  dataset.attributableInflowsBySeries = map;
}

async function loadBenchmarkSeries(
  supabase: SupabaseClient,
  instrumentIds: string[],
  warnings: LoadWarning[]
): Promise<SipDataset['benchmarkByInstrument']> {
  const out: SipDataset['benchmarkByInstrument'] = new Map();
  if (instrumentIds.length === 0) return out;

  const { data: mappings } = await supabase
    .from('ii_instrument_benchmarks')
    .select('instrument_id, benchmark_id, relationship_type, effective_from, effective_to, mapping_version, quality_status')
    .in('instrument_id', instrumentIds)
    .eq('relationship_type', 'primary');

  const active = (mappings ?? []).filter((m) => m.quality_status !== 'superseded');
  if (active.length === 0) {
    warnings.push({ scope: 'benchmark', detail: 'No primary benchmark mapping exists for these schemes, so like-for-like benchmark comparisons cannot be produced.' });
    return out;
  }

  const benchmarkIds = [...new Set(active.map((m) => m.benchmark_id))];
  const { data: benchmarks } = await supabase.from('ii_benchmarks').select('id, benchmark_key, return_type').in('id', benchmarkIds);
  const bmMeta = new Map((benchmarks ?? []).map((b) => [b.id as string, b]));

  const { data: seriesRows } = await supabase
    .from('ii_benchmark_series')
    .select('benchmark_id, series_date, value, quality_status')
    .in('benchmark_id', benchmarkIds)
    .order('series_date', { ascending: true });

  const seriesByBenchmark = new Map<string, Observation[]>();
  for (const r of seriesRows ?? []) {
    if (r.quality_status === 'superseded' || r.quality_status === 'duplicate_flagged') continue;
    const list = seriesByBenchmark.get(r.benchmark_id) ?? [];
    list.push({ date: r.series_date, value: Number(r.value) });
    seriesByBenchmark.set(r.benchmark_id, list);
  }

  for (const m of active) {
    const meta = bmMeta.get(m.benchmark_id);
    out.set(m.instrument_id, {
      benchmarkId: m.benchmark_id,
      benchmarkKey: meta?.benchmark_key ?? m.benchmark_id,
      returnType: meta?.return_type ?? null,
      mappingVersion: m.mapping_version ?? null,
      series: seriesByBenchmark.get(m.benchmark_id) ?? [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// X-Ray dataset
// ---------------------------------------------------------------------------

export async function loadXrayDataset(
  supabase: SupabaseClient,
  userId: string,
  options: { asOfDate?: string } = {}
): Promise<R5LoadResult<XrayDataset>> {
  const warnings: LoadWarning[] = [];

  // Current positions come from the certified R2/R3 holding snapshots. R5
  // READS them and never writes them.
  const { data: holdingRows, error: holdingErr } = await supabase
    .from('ii_holding_snapshots')
    .select('instrument_id, as_of_date, units, value, currency_code, quality_status')
    .eq('user_id', userId)
    .order('as_of_date', { ascending: false });
  if (holdingErr) throw new Error(`Could not load holdings: ${holdingErr.message}`);

  if (!holdingRows || holdingRows.length === 0) {
    return { dataset: null, warnings, empty: true };
  }

  // Latest snapshot per instrument.
  const latestByInstrument = new Map<string, (typeof holdingRows)[number]>();
  for (const r of holdingRows) {
    if (!latestByInstrument.has(r.instrument_id)) latestByInstrument.set(r.instrument_id, r);
  }
  const portfolioAsOfDate = [...latestByInstrument.values()].map((r) => r.as_of_date).sort().slice(-1)[0];

  const instrumentIds = [...latestByInstrument.keys()];
  const { data: instrumentRows } = await supabase
    .from('ii_instruments')
    .select('id, instrument_name, instrument_class')
    .in('id', instrumentIds);
  const instrumentMeta = new Map((instrumentRows ?? []).map((r) => [r.id as string, r]));

  const positions: PortfolioFundPosition[] = [...latestByInstrument.values()]
    // X-Ray look-through applies to pooled vehicles only.
    .filter((r) => {
      const cls = instrumentMeta.get(r.instrument_id)?.instrument_class;
      return cls === 'mutual_fund' || cls === 'etf';
    })
    .map((r) => ({
      fundInstrumentId: r.instrument_id,
      fundName: instrumentMeta.get(r.instrument_id)?.instrument_name ?? r.instrument_id,
      // Value stays in the investment's OWN local currency and is never
      // FX-converted here (spec section 101, R0_CROSS_BORDER_CONTRACT).
      value: Number(r.value),
      currencyCode: r.currency_code,
      amcId: null,
      amcName: null,
    }));

  if (positions.length === 0) {
    return { dataset: null, warnings, empty: true };
  }

  const requestedAsOf = options.asOfDate ?? todayIso();
  const asOfDate = requestedAsOf > portfolioAsOfDate ? portfolioAsOfDate : requestedAsOf;
  if (asOfDate !== requestedAsOf) {
    warnings.push({
      scope: 'as_of_date',
      detail: `The analysis date has been set to ${asOfDate}, the most recent date for which real position data exists, rather than ${requestedAsOf}.`,
    });
  }

  const { snapshotsByFund, classificationVersion, debtLines } = await loadFundHoldingsSnapshots(
    supabase,
    positions.map((p) => p.fundInstrumentId),
    asOfDate,
    positions,
    warnings
  );

  return {
    dataset: {
      userId,
      asOfDate,
      portfolioAsOfDate,
      positions,
      snapshotsByFund,
      classificationVersion,
      debtLines,
      creditConsolidationMethodology: null, // none approved yet — consolidation stays suppressed
      sectorLabels: new Map(),
    },
    warnings,
    empty: false,
  };
}

/**
 * Load versioned fund-holdings snapshots.
 *
 * Tolerates migration 0044 not yet being applied: if the R5 tables are
 * absent, this returns EMPTY snapshot data and records an explicit warning,
 * so the X-Ray reports MISSING_HOLDINGS honestly rather than crashing or —
 * far worse — rendering fabricated zeros.
 */
async function loadFundHoldingsSnapshots(
  supabase: SupabaseClient,
  fundIds: string[],
  asOfDate: string,
  positions: PortfolioFundPosition[],
  warnings: LoadWarning[]
): Promise<{ snapshotsByFund: Map<string, FundHoldingsSnapshot[]>; classificationVersion: string | null; debtLines: DebtExposureLine[] }> {
  const snapshotsByFund = new Map<string, FundHoldingsSnapshot[]>();
  const debtLines: DebtExposureLine[] = [];
  let classificationVersion: string | null = null;

  const { data: snapRows, error: snapErr } = await supabase
    .from('ii_fund_holdings_snapshots')
    .select('id, fund_instrument_id, holdings_as_of_date, source_data_version, classification_version, quality_status')
    .in('fund_instrument_id', fundIds)
    .lte('holdings_as_of_date', asOfDate)
    .order('holdings_as_of_date', { ascending: false });

  if (snapErr) {
    warnings.push({
      scope: 'fund_holdings',
      detail: `Fund holdings data is not available (${snapErr.message}). Look-through exposure is reported as unavailable rather than estimated.`,
    });
    return { snapshotsByFund, classificationVersion, debtLines };
  }
  if (!snapRows || snapRows.length === 0) {
    warnings.push({ scope: 'fund_holdings', detail: 'No fund holdings disclosures are available for the schemes in this portfolio.' });
    return { snapshotsByFund, classificationVersion, debtLines };
  }

  const usableSnaps = snapRows.filter((s) => s.quality_status !== 'superseded');
  const snapIds = usableSnaps.map((s) => s.id);
  const { data: lineRows } = await supabase
    .from('ii_fund_holdings_lines')
    .select(
      'snapshot_id, underlying_instrument_id, holding_name, isin, issuer_id, issuer_name, asset_kind, weight_pct, sector_code, industry_code, market_cap_class, credit_rating_band, agency_ratings, maturity_date, modified_duration'
    )
    .in('snapshot_id', snapIds);

  const linesBySnapshot = new Map<string, SnapshotHolding[]>();
  for (const r of lineRows ?? []) {
    const list = linesBySnapshot.get(r.snapshot_id) ?? [];
    list.push({
      canonicalId: r.underlying_instrument_id,
      displayName: r.holding_name,
      weightPct: Number(r.weight_pct),
      assetKind: r.asset_kind,
      sectorCode: r.sector_code,
      industryCode: r.industry_code,
      marketCapClass: r.market_cap_class,
      creditRatingBand: r.credit_rating_band,
      maturityDate: r.maturity_date,
      modifiedDuration: r.modified_duration === null ? null : Number(r.modified_duration),
      issuerId: r.issuer_id,
    });
    linesBySnapshot.set(r.snapshot_id, list);
  }

  for (const s of usableSnaps) {
    const list = snapshotsByFund.get(s.fund_instrument_id) ?? [];
    list.push({
      snapshotId: s.id,
      fundInstrumentId: s.fund_instrument_id,
      holdingsAsOfDate: s.holdings_as_of_date,
      sourceKey: 'db',
      sourceDataVersion: s.source_data_version,
      classificationVersion: s.classification_version,
      holdings: linesBySnapshot.get(s.id) ?? [],
    });
    snapshotsByFund.set(s.fund_instrument_id, list);
    if (!classificationVersion && s.classification_version) classificationVersion = s.classification_version;
  }

  // Build debt exposure lines from the SELECTED snapshot of each fund,
  // weighted through to portfolio level, so debt metrics describe genuine
  // effective exposure rather than raw within-fund weights.
  const totalValue = positions.reduce((sum, p) => sum + p.value, 0);
  for (const p of positions) {
    const candidates = (snapshotsByFund.get(p.fundInstrumentId) ?? []).sort(
      (a, b) => b.holdingsAsOfDate.localeCompare(a.holdingsAsOfDate) || b.snapshotId.localeCompare(a.snapshotId)
    );
    const chosen = candidates[0];
    if (!chosen || totalValue <= 0) continue;
    const portfolioWeight = p.value / totalValue;
    for (const h of chosen.holdings) {
      const isDebtLike = h.creditRatingBand !== null && h.creditRatingBand !== undefined;
      const hasMaturity = h.maturityDate !== null && h.maturityDate !== undefined;
      if (!isDebtLike && !hasMaturity) continue;
      debtLines.push({
        canonicalId: h.canonicalId,
        displayName: h.displayName,
        effectiveWeight: portfolioWeight * (h.weightPct / 100),
        issuerId: h.issuerId ?? null,
        issuerName: null,
        creditRatingBand: (h.creditRatingBand as DebtExposureLine['creditRatingBand']) ?? null,
        maturityDate: h.maturityDate ?? null,
        modifiedDuration: h.modifiedDuration ?? null,
      });
    }
  }

  return { snapshotsByFund, classificationVersion, debtLines };
}

// ---------------------------------------------------------------------------
// Persistence — service-role only
// ---------------------------------------------------------------------------

export interface PersistableR5Row {
  scopeType: 'sip_series' | 'scheme' | 'fund_pair' | 'portfolio';
  scopeId: string;
  metricKey: string;
  metricVersion: string;
  engineVersion: string;
  dataAsOfDate: string;
  portfolioAsOfDate?: string | null;
  holdingsAsOfDate?: string | null;
  holdingsSnapshotIds?: string[];
  holdingsSourceVersions?: string[];
  classificationVersion?: string | null;
  benchmarkMappingVersion?: string | null;
  benchmarkDataVersion?: string | null;
  navDataVersion?: string | null;
  inputSnapshotVersion: string;
  coverage?: number | null;
  qualityStatus: string;
  qualityReason?: string | null;
  resultValue: unknown;
}

/**
 * Persist derived R5 results.
 *
 * Uses the SERVICE-ROLE client deliberately: ii_r5_analytics_results has no
 * authenticated-role insert policy, so users cannot forge analytics rows.
 * `userId` must come from the authenticated session — it is never taken from
 * a request body.
 *
 * Failure to persist is NOT fatal to the response: analytics are recomputed
 * deterministically from certified inputs, so a storage hiccup must never
 * block a correct answer being shown.
 */
export async function persistR5Results(userId: string, rows: PersistableR5Row[]): Promise<{ persisted: number; error: string | null }> {
  if (rows.length === 0) return { persisted: 0, error: null };
  try {
    const admin = createAdminClient();
    const payload = rows.map((r) => ({
      user_id: userId,
      scope_type: r.scopeType,
      scope_id: r.scopeId,
      metric_key: r.metricKey,
      metric_version: r.metricVersion,
      engine_version: r.engineVersion,
      data_as_of_date: r.dataAsOfDate,
      portfolio_as_of_date: r.portfolioAsOfDate ?? null,
      holdings_as_of_date: r.holdingsAsOfDate ?? null,
      holdings_snapshot_ids: r.holdingsSnapshotIds ?? null,
      holdings_source_versions: r.holdingsSourceVersions ?? null,
      classification_version: r.classificationVersion ?? null,
      benchmark_mapping_version: r.benchmarkMappingVersion ?? null,
      benchmark_data_version: r.benchmarkDataVersion ?? null,
      nav_data_version: r.navDataVersion ?? null,
      input_snapshot_version: r.inputSnapshotVersion,
      coverage: r.coverage ?? null,
      quality_status: r.qualityStatus,
      quality_reason: r.qualityReason ?? null,
      result_value: r.resultValue,
    }));
    const { error } = await admin.from('ii_r5_analytics_results').upsert(payload, {
      onConflict: 'user_id,scope_type,scope_id,metric_key,input_snapshot_version,engine_version',
      ignoreDuplicates: true,
    });
    if (error) return { persisted: 0, error: error.message };
    return { persisted: payload.length, error: null };
  } catch (e) {
    return { persisted: 0, error: e instanceof Error ? e.message : 'Unknown persistence error' };
  }
}
