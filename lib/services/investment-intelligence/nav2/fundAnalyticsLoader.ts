// NAV2 Stage 2 -- the user-scoped, READ-ONLY loader behind the Fund analytics report.
//
// It composes the existing, certified loaders instead of re-implementing them:
//   * loadOwnerClassScopeForReport  -> the personal (non-entity) client, so trust / HUF / company holdings are
//                                      never summed into a personal report (the exclusion is disclosed);
//   * loadAnalyticsDataset          -> per-scheme flows, the one valuation rule's result, declared benchmark
//                                      mappings and their entitlement-gated series, category references;
// and adds only what NAV2 needs that those do not carry: the instrument's plan / option / category, the RAW NAV
// rows with their lineage (id, checksum, provider, quality, supersession), unresolved coverage gaps, the
// hydration state from the report NAV gate, and the governed risk-free dataset.
//
// Everything is scoped to `userId` (which MUST come from the authenticated session). Nothing is written.

import type { SupabaseClient } from '@supabase/supabase-js';
import { NAV2_POLICY, type Nav2Policy } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec, type ReportPeriodChoice } from '@/lib/engines/nav2/analysisSpec';
import type { Nav2BenchmarkInput } from '@/lib/engines/nav2/benchmarkGate';
import type { FundAnalyticsInput, HeldSchemeInput, ReportScopeNotes } from '@/lib/engines/nav2/fundAnalyticsReport';
import type { InvestorExperienceInput, ValuationView } from '@/lib/engines/nav2/investorExperience';
import { prepareSeries, type CoverageGapInput, type RawNavRow } from '@/lib/engines/nav2/series';
import { splitTerminalFlow } from '@/lib/engines/investment-intelligence/holdingBenchmarkComparison';
import type { SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { resolveFundCategory } from '../benchmarkData/categoryReference';
import { loadAnalyticsDataset } from '../analyticsRepository';
import { loadOwnerClassScopeForReport } from '../ownerClassReportScope';
import { fetchAllRows } from '../pagination';
import type { ReportNavGate } from '../pc6/reportNavHistoryGate';
import type { IiOptionType, IiPlanType } from '../types';
import { loadRiskFreeSupply } from './riskFreeDatasetLoader';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';

const iso = (d: Date): string => d.toISOString().slice(0, 10);

export interface FundAnalyticsLoadArgs {
  userId: string;
  /** The caller's own session client (RLS applies). */
  sessionClient: SupabaseServerClient;
  /** Service client, used ONLY for reads of global reference data and the user's own gate state (every query filtered). */
  adminClient: SupabaseClient;
  asOfDate: string;
  displayCurrency: 'INR' | 'AUD';
  periodChoice: ReportPeriodChoice;
  gate: Pick<ReportNavGate, 'waiting' | 'unavailable'>;
  policy?: Nav2Policy;
}

export interface FundAnalyticsLoadResult {
  /** null when the household holds no fund this report covers. */
  input: FundAnalyticsInput | null;
  warnings: string[];
  /** Plain reason the risk-free rate data is missing (shown with the report); null when present. */
  riskFreeUnavailableReason: string | null;
}

interface InstrumentRow {
  id: string;
  instrument_name: string;
  instrument_class: string;
  base_currency: string;
  plan_type: IiPlanType | null;
  option_type: IiOptionType | null;
}

interface NavRowDb {
  id: string;
  instrument_id: string;
  price_date: string;
  price: number | string;
  currency_code: string | null;
  quality_status: string | null;
  superseded_by_id: string | null;
  correction_of_id: string | null;
  record_checksum: string | null;
  source_id: string | null;
  data_version: string | null;
}

/** Pure. The investor input from a scheme's loaded dataset: flows exclude the terminal value, which the valuation supplies. */
export function investorInputFor(s: SchemeDataset, asOfDate: string): InvestorExperienceInput | null {
  if (!s.valuation) return null;
  const { flows } = splitTerminalFlow(s.cashFlows, s.currentValue, s.currentValueDate);
  return { instrumentId: s.instrumentId, flows, valuation: s.valuation as ValuationView, asOfDate };
}

/** Pure. The earliest date the scheme is held from: its first real cash flow, else its earliest dated valuation. */
export function firstHeldDateFor(s: SchemeDataset): string | null {
  const dates: string[] = [];
  const { flows } = splitTerminalFlow(s.cashFlows, s.currentValue, s.currentValueDate);
  for (const f of flows) dates.push(iso(f.date));
  if (dates.length === 0) for (const p of s.valuationSeries) dates.push(iso(p.date));
  return dates.length ? dates.sort()[0] : null;
}

/** Pure. Declared mappings win; a category reference is offered only when there is no declared mapping (the gate then refuses or discloses it). */
export function benchmarkSegmentsFor(instrumentId: string, ds: NonNullable<Awaited<ReturnType<typeof loadAnalyticsDataset>>['dataset']>): Nav2BenchmarkInput[] {
  const declared = ds.mappings.filter((m) => m.instrumentId === instrumentId);
  const chosen = declared.length > 0 ? declared : (ds.categoryReferenceMappings ?? []).filter((m) => m.instrumentId === instrumentId);
  return chosen.map((m) => {
    const meta = ds.benchmarkMeta?.[m.benchmarkId];
    return {
      basis: m.basis ?? 'declared',
      categoryLabel: m.categoryLabel ?? null,
      benchmarkId: m.benchmarkId,
      benchmarkKey: m.benchmarkKey,
      label: meta?.label ?? m.benchmarkKey,
      returnType: m.returnType,
      effectiveFrom: m.effectiveFrom,
      effectiveTo: m.effectiveTo,
      catalogueVerified: meta?.catalogueVerified === true,
      entitled: meta?.entitled === true,
      entitlementDetail: meta?.entitlementDetail,
      series: ds.benchmarkSeriesById[m.benchmarkId] ?? [],
      datasetVersion: ds.benchmarkDataVersion,
      licenceStatus: null,
    };
  });
}

/** The label recorded when a row's source cannot be resolved (no source_id, or a source_id with no ii_sources row). Never guessed. */
export const UNKNOWN_NAV_SOURCE = 'unknown_source';

const toRaw = (r: NavRowDb, providerById: ReadonlyMap<string, string>): RawNavRow => ({
  id: r.id,
  instrumentId: r.instrument_id,
  priceDate: String(r.price_date).slice(0, 10),
  price: r.price,
  currencyCode: r.currency_code,
  qualityStatus: r.quality_status,
  supersededById: r.superseded_by_id,
  correctionOfId: r.correction_of_id,
  recordChecksum: r.record_checksum,
  // ii_prices_nav has no provider column: the provider identity is the ii_sources.source_key behind source_id.
  provider: (r.source_id ? providerById.get(r.source_id) : null) ?? UNKNOWN_NAV_SOURCE,
  dataVersion: r.data_version,
});

export async function loadFundAnalyticsInput(args: FundAnalyticsLoadArgs): Promise<FundAnalyticsLoadResult> {
  const policy = args.policy ?? NAV2_POLICY;
  const warnings: string[] = [];
  const { client } = await loadOwnerClassScopeForReport(args.userId, args.sessionClient);

  const loaded = await loadAnalyticsDataset(client as unknown as SupabaseClient, args.userId, { asOfDate: new Date(`${args.asOfDate}T00:00:00.000Z`), benchmarkAccessNeed: 'export' });
  warnings.push(...loaded.warnings.map((w) => w.detail));
  const rf = await loadRiskFreeSupply(args.adminClient);

  // ---- scope notes: entity-held funds excluded, non-fund holdings, items awaiting review -------------------------
  const personalIds = new Set<string>();
  const allTruth = await fetchAllRows<{ instrument_id: string; id: string }>(() =>
    (args.sessionClient as unknown as SupabaseClient).from('ii_portfolio_truth_status').select('instrument_id, id').eq('user_id', args.userId).order('id', { ascending: true })
  ).catch(() => [] as Array<{ instrument_id: string; id: string }>);
  const scopedTruth = await fetchAllRows<{ instrument_id: string; id: string }>(() =>
    (client as unknown as SupabaseClient).from('ii_portfolio_truth_status').select('instrument_id, id').eq('user_id', args.userId).order('id', { ascending: true })
  ).catch(() => [] as Array<{ instrument_id: string; id: string }>);
  for (const r of scopedTruth) personalIds.add(r.instrument_id);
  const entityOnly = new Set(allTruth.map((r) => r.instrument_id).filter((id) => !personalIds.has(id)));

  let awaiting = 0;
  try {
    const { count } = await (args.sessionClient as unknown as SupabaseClient)
      .from('ii_reconciliation_cases')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', args.userId)
      .in('status', ['open', 'user_reviewing']);
    awaiting = count ?? 0;
  } catch {
    awaiting = 0;
  }

  const baseScope: ReportScopeNotes = {
    entityHeldSchemesExcluded: entityOnly.size,
    otherInstrumentsExcluded: 0,
    statementLinesAwaitingReview: awaiting,
    priceHistoryUnavailable: args.gate.unavailable.map((f) => ({ schemeName: f.schemeName, reason: 'no published prices found' })),
  };

  const ds = loaded.dataset;
  if (!ds) return { input: null, warnings, riskFreeUnavailableReason: rf.unavailableReason };

  // ---- instrument facts: class, plan, option, category ------------------------------------------------------------
  const ids = ds.schemes.map((s) => s.instrumentId);
  const admin = args.adminClient;
  const { data: instData } = await admin.from('ii_instruments').select('id, instrument_name, instrument_class, base_currency, plan_type, option_type').in('id', ids);
  const inst = new Map(((instData ?? []) as InstrumentRow[]).map((i) => [i.id, i]));
  const { data: smData } = await admin.from('ii_scheme_master').select('instrument_id, sub_category, category_header_raw').in('instrument_id', ids).is('effective_to', null);
  const sm = new Map(((smData ?? []) as Array<{ instrument_id: string; sub_category: string | null; category_header_raw: string | null }>).map((r) => [r.instrument_id, r]));

  const fundSchemes = ds.schemes.filter((s) => inst.get(s.instrumentId)?.instrument_class === 'mutual_fund' && (inst.get(s.instrumentId)?.base_currency ?? 'INR') === 'INR');
  baseScope.otherInstrumentsExcluded = ds.schemes.length - fundSchemes.length;
  const fundIds = fundSchemes.map((s) => s.instrumentId);
  if (fundIds.length === 0) return { input: { asOfDate: args.asOfDate, displayCurrency: args.displayCurrency, policy, spec: reportAnalysisSpec(args.asOfDate, policy, args.periodChoice), periodChoice: args.periodChoice, riskFree: rf.supply, schemes: [], scope: baseScope }, warnings, riskFreeUnavailableReason: rf.unavailableReason };

  // ---- raw NAV rows with lineage + unresolved coverage gaps -------------------------------------------------------
  const navRows = await fetchAllRows<NavRowDb>(() =>
    admin
      .from('ii_prices_nav')
      .select('id, instrument_id, price_date, price, currency_code, quality_status, superseded_by_id, correction_of_id, record_checksum, source_id, data_version')
      .in('instrument_id', fundIds)
      .lte('price_date', args.asOfDate)
      .order('price_date', { ascending: true })
      .order('id', { ascending: true })
  );
  const sourceIds = [...new Set(navRows.map((r) => r.source_id).filter((x): x is string => !!x))];
  const providerById = new Map<string, string>();
  if (sourceIds.length > 0) {
    const { data: srcData, error: srcErr } = await admin.from('ii_sources').select('id, source_key').in('id', sourceIds);
    if (srcErr) throw new Error(`fund analytics: could not read the NAV sources (${srcErr.message})`);
    for (const x of (srcData ?? []) as Array<{ id: string; source_key: string | null }>) if (x.source_key) providerById.set(x.id, x.source_key);
  }
  const navBy = new Map<string, RawNavRow[]>();
  for (const r of navRows) {
    const list = navBy.get(r.instrument_id) ?? [];
    list.push(toRaw(r, providerById));
    navBy.set(r.instrument_id, list);
  }
  const { data: gapData } = await admin.from('ii_nav_source_coverage_gaps').select('instrument_id, gap_from, gap_to, reason_code').in('instrument_id', fundIds).is('resolved_at', null);
  const gapsBy = new Map<string, CoverageGapInput[]>();
  for (const g of (gapData ?? []) as Array<{ instrument_id: string; gap_from: string; gap_to: string; reason_code: string }>) {
    const list = gapsBy.get(g.instrument_id) ?? [];
    list.push({ from: String(g.gap_from).slice(0, 10), to: String(g.gap_to).slice(0, 10), reasonCode: g.reason_code });
    gapsBy.set(g.instrument_id, list);
  }
  const hydrating = new Set(args.gate.waiting.map((f) => f.instrumentId));

  const schemes: HeldSchemeInput[] = fundSchemes.map((s) => {
    const i = inst.get(s.instrumentId)!;
    const master = sm.get(s.instrumentId);
    const cat = resolveFundCategory({ subCategory: master?.sub_category ?? null, categoryHeaderRaw: master?.category_header_raw ?? null, instrumentName: i.instrument_name });
    const series = prepareSeries(
      {
        identity: { instrumentId: s.instrumentId, currency: i.base_currency, planType: i.plan_type, optionType: i.option_type, resolved: true, schemeName: i.instrument_name },
        asOfDate: args.asOfDate,
        rows: navBy.get(s.instrumentId) ?? [],
        hydrating: hydrating.has(s.instrumentId),
        knownCoverageGaps: gapsBy.get(s.instrumentId),
      },
      policy
    );
    return {
      instrumentId: s.instrumentId,
      schemeName: i.instrument_name,
      planType: i.plan_type,
      optionType: i.option_type,
      category: cat.key,
      categoryLabel: cat.displayCategory,
      series,
      benchmarks: benchmarkSegmentsFor(s.instrumentId, ds),
      investor: investorInputFor(s, args.asOfDate),
      firstHeldDate: firstHeldDateFor(s),
    };
  });

  return {
    input: { asOfDate: args.asOfDate, displayCurrency: args.displayCurrency, policy, spec: reportAnalysisSpec(args.asOfDate, policy, args.periodChoice), periodChoice: args.periodChoice, riskFree: rf.supply, schemes, scope: baseScope },
    warnings,
    riskFreeUnavailableReason: rf.unavailableReason,
  };
}
