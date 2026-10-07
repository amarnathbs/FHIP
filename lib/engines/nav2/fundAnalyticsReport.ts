// NAV2 Stage 2 -- the FUND ANALYTICS REPORT model and its pure assembler.
//
// buildFundAnalyticsReport() turns already-loaded, already-prepared inputs (one PreparedSeries per held scheme,
// its declared benchmark segments, its investor flows and valuation, the risk-free supply) into the issued report
// and the dependency manifest that pins it. PURE: no I/O, no clock (the as-of date is an argument), deterministic
// (same inputs -> byte-identical JSON). The two result families stay separate in every scheme block; the ranking and
// the correlations are among the household's OWN schemes only and are labelled "Your held schemes".
//
// What is stored (pinned) is the issued output, so the trend results are stored COMPACTLY: the per-date points of an
// SMA / EMA / ROC are dropped (the latest value, the count and the first defined date are kept) and the chart carries
// a down-sampled NAV line plus the SMA 50 / 200 aligned to it. Nothing here estimates a number: an unavailable result
// is stored as its typed state with its reason and sentence, exactly as the engine produced it.

import { createHash } from 'crypto';
import { NAV2_ENGINE_VERSION, NAV2_METRICS, type Nav2Policy } from '@/lib/config/nav2/metricPolicy';
import { RISK_FREE_SERIES_LABELS, type RiskFreeSeriesId } from '@/lib/config/nav2/riskFreeSeriesConfig';
import type { IiOptionType, IiPlanType } from '@/lib/services/investment-intelligence/types';
import type { AnalysisSpec, ReportPeriodChoice } from './analysisSpec';
import { computeHeldSchemeAnalytics, type HeldSchemeAnalytics, type SchemePerformanceFamily } from './analyticsContract';
import { buildResultCacheKey, bundleDefinitionVersion, metricRegistryDigest, policyDigest, SCHEME_PERFORMANCE_BUNDLE, type ResultCacheKeyParts } from './cacheKeys';
import type { Nav2BenchmarkInput } from './benchmarkGate';
import { rankHeldSchemes, type HeldRankingValue, type RankingCandidate } from './heldRanking';
import type { OwnershipShare } from './ownershipShare';
import { coversSomeFundsNote, figuresAsAtNote, riskFreeShortNote } from './reportWording';
import { computeInvestorExperience, SCHEME_VS_INVESTOR_EXPLANATION, type InvestorExperienceInput } from './investorExperience';
import type { RiskFreeSupply } from './riskFree';
import { correlationBetweenHeldSchemes, type CorrelationValue } from './schemeRisk';
import type { SeriesGap, PreparedSeries } from './series';
import { sma, type TrendValue } from './schemeTrend';
import type { Nav2Context, Nav2Result, Nav2State } from './types';
import { showDate } from './types';
import { FUND_ANALYTICS_MAX_FUNDS } from '@/lib/config/nav2/reportLimits';

export const FUND_ANALYTICS_REPORT_VERSION = 'nav2-fund-analytics-report-v1';
export const FUND_ANALYTICS_MANIFEST_VERSION = 'nav2-fund-analytics-manifest-v1';
/** The chart carries at most this many NAV points (the last observation of each equal slice; the very last is always kept). */
export const CHART_MAX_POINTS = 600;
/** Pairs beyond this many schemes are not computed (the report would be a matrix nobody can read); the report says so. */
export const MAX_SCHEMES_FOR_PAIRS = 20;

export interface HeldSchemeInput {
  instrumentId: string;
  schemeName: string;
  planType: IiPlanType | null;
  optionType: IiOptionType | null;
  /** Normalised category key used for comparability in the ranking; null = unknown (never ranked). */
  category: string | null;
  categoryLabel: string | null;
  series: PreparedSeries;
  benchmarks: Nav2BenchmarkInput[];
  investor: InvestorExperienceInput | null;
  /** The user's ownership of the folios behind `investor` (a joint holding is the user's SHARE). Absent for a fund held only in the user's own name. */
  ownership?: OwnershipShare | null;
  /** Earliest date the scheme is held from (transaction / investment date / snapshot); null when unknown. */
  firstHeldDate: string | null;
  /** A compact scheme-performance family from the shared result cache (same key = same inputs); computed here when absent. */
  cachedScheme?: SchemePerformanceFamily | null;
}

export interface ReportScopeNotes {
  /** Schemes held through a trust, HUF or company: not in this personal report. */
  entityHeldSchemesExcluded: number;
  /** Instruments that are not Indian mutual funds (this report is for those only). */
  otherInstrumentsExcluded: number;
  /** Statement lines still waiting for a reconciliation decision (not yet a held scheme). */
  statementLinesAwaitingReview: number;
  /** Funds whose price history could not be loaded (named, with the plain reason). */
  priceHistoryUnavailable: Array<{ schemeName: string; reason: string }>;
}

/** Which of the funds held this report covers (PO decision 07-10-2026: one report covers at most FUND_ANALYTICS_MAX_FUNDS funds). */
export interface ReportSelection {
  /** 'all_held' when the report covers every fund held, 'chosen' when the person chose a subset. */
  basis: 'all_held' | 'chosen';
  /** How many Indian mutual funds were held (the personal ones this report can cover). */
  heldFundCount: number;
  /** The funds the report covers (instrument ids). */
  chosenInstrumentIds: string[];
  /** The cap in force when the report was made. */
  max: number;
}

export interface FundAnalyticsInput {
  asOfDate: string;
  displayCurrency: 'INR' | 'AUD';
  policy: Nav2Policy;
  spec: AnalysisSpec;
  periodChoice: ReportPeriodChoice;
  riskFree: RiskFreeSupply;
  schemes: readonly HeldSchemeInput[];
  scope: ReportScopeNotes;
  /** Which funds are covered; absent = every fund in `schemes` (all held). */
  selection?: ReportSelection;
  /** ISO timestamp of the calculation, stored in the pinned manifest (the engine itself reads no clock). */
  calculatedAt?: string;
}

export interface ChartData {
  /** [date, NAV] pairs, ascending, never connected across a material gap (see `gaps`). */
  navPoints: Array<[string, number]>;
  sma50: Array<[string, number]>;
  sma200: Array<[string, number]>;
  gaps: SeriesGap[];
  downsampled: boolean;
}

export interface FundAnalyticsSchemeBlock {
  instrumentId: string;
  schemeName: string;
  planType: IiPlanType | null;
  optionType: IiOptionType | null;
  categoryLabel: string | null;
  firstHeldDate: string | null;
  /** Present only when the user's figures are not simply the whole holding: a joint SHARE, or an ownership share that is not set. */
  ownership?: OwnershipShare;
  analytics: HeldSchemeAnalytics;
  chart: ChartData;
  navSeriesSummary: { firstDate: string | null; lastDate: string | null; count: number; checksum: string; materialGapCount: number; weekdayCoverageRatio: number | null };
}

export interface CorrelationPair {
  aInstrumentId: string;
  bInstrumentId: string;
  result: Nav2Result<CorrelationValue>;
}

export interface FundAnalyticsReport {
  reportVersion: typeof FUND_ANALYTICS_REPORT_VERSION;
  asOfDate: string;
  displayCurrency: 'INR' | 'AUD';
  periodChoice: ReportPeriodChoice;
  policyVersion: string;
  engineVersion: string;
  spec: AnalysisSpec;
  schemes: FundAnalyticsSchemeBlock[];
  comparison: {
    label: 'Your held schemes';
    rankings: Array<{ horizonId: string; result: Nav2Result<HeldRankingValue> }>;
    correlations: CorrelationPair[];
    correlationsSkippedReason: string | null;
  };
  scope: ReportScopeNotes;
  /** Present only when the report covers some, not all, of the funds held: the numbers behind the sentence in `notes`. Absent in reports made before 07-10-2026. */
  selection?: { heldFundCount: number; chosenCount: number; max: number; chosenInstrumentIds: string[] };
  /** Plain sentences stated once for the whole report (scope, risk-free series used, benchmark basis). */
  notes: string[];
  /** The long explanations (the risk-free formula and the dates of the rates used): kept with the report and shown collapsed on the page. Absent in reports made before 07-10-2026. */
  calculationNotes?: string[];
  stateCounts: Record<string, number>;
}

export interface FundAnalyticsManifest {
  manifestVersion: typeof FUND_ANALYTICS_MANIFEST_VERSION;
  reportVersion: typeof FUND_ANALYTICS_REPORT_VERSION;
  asOfDate: string;
  policyVersion: string;
  engineVersion: string;
  metricDefinitionVersions: Record<string, string>;
  /** The ordered list behind the cache key: every metric definition (id, family, version) in the register, sorted by id. */
  metricDefinitions: Array<{ id: string; family: string; version: string }>;
  /** Digest of that list: the part of every cached bundle's definition version that changes when ANY metric definition changes. */
  metricRegistryDigest: string;
  /** When the calculation ran (ISO). null only for a manifest built without a clock (tests). */
  calculatedAt: string | null;
  periodChoice: ReportPeriodChoice;
  /** Which funds the report covers (the chosen ids are sorted). Absent in manifests made before 07-10-2026. */
  selection?: ReportSelection;
  /** The full risk-free formula text and the dates of the rates used (the report body prints one plain sentence). */
  calculationNotes: string[];
  riskFree: { seriesId: string; seriesLabel: string; datasetVersion: string; retrievedOn: string; termsReviewStatus: string; verifiedThroughDate: string | null; enabled: boolean } | null;
  schemes: Array<{
    instrumentId: string;
    /** The price-history audit figures (no longer printed in the report body): checksum, first and last date, number of prices, number of material gaps. */
    navSeries: { checksum: string; firstDate: string | null; lastDate: string | null; count: number; materialGapCount: number };
    /** The NAV range the figures rest on, for the retention pin. */
    navRange: { from: string | null; to: string | null };
    benchmark: { benchmarkId: string; datasetVersion: string | null; basis: string } | null;
    /** Every benchmark segment supplied for the scheme (id, dataset version, basis), whether or not beta / alpha could use it. */
    benchmarks: Array<{ benchmarkId: string; datasetVersion: string | null; basis: string }>;
    /** Fingerprint of the user's transactions and valuation the investor-experience figures rest on; null when the scheme has none. */
    transactionVersion: string | null;
    /** The ownership the investor figures were scaled by (member, basis points, allocation group): a changed allocation changes this and the transaction version. */
    ownership: OwnershipShare | null;
  }>;
}

// ---------------------------------------------------------------------------

function compactTrend(r: Nav2Result<TrendValue>): Nav2Result<TrendValue> {
  if (r.state !== 'available') return r;
  return { ...r, value: { ...r.value, points: [] } };
}

/** The stored form of a scheme family: per-date trend points dropped (latest value, count and first defined date are kept). Idempotent. */
export function compactSchemeFamily(f: SchemePerformanceFamily): SchemePerformanceFamily {
  return {
    ...f,
    movingAverages: f.movingAverages.map((m) => ({ ...m, result: compactTrend(m.result) })),
    rateOfChange: f.rateOfChange.map((m) => ({ ...m, result: compactTrend(m.result) })),
  };
}

/** The analysis spec a scheme is computed under (since_first_held narrows the window to that scheme's own first held date). */
export function schemeSpecFor(input: Pick<FundAnalyticsInput, 'spec' | 'periodChoice'>, h: Pick<HeldSchemeInput, 'firstHeldDate'>): AnalysisSpec {
  return { ...input.spec, analysisStart: input.periodChoice === 'since_first_held' ? h.firstHeldDate : input.spec.analysisStart };
}

/**
 * The shared-cache key parts of one scheme's performance bundle. Every input that can change a number is in the key:
 * the policy and engine versions, a digest of the spec, the NAV series checksum and window, the benchmark (id, dataset
 * version and the gate facts that decide availability) and the risk-free dataset. No user scope: the bundle depends
 * on public data only (spec 14), so one entry serves every household holding the scheme.
 */
export function schemeBundleCacheParts(input: Pick<FundAnalyticsInput, 'spec' | 'periodChoice' | 'policy' | 'riskFree' | 'displayCurrency'>, h: HeldSchemeInput): ResultCacheKeyParts {
  const spec = schemeSpecFor(input, h);
  const specDigest = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 12);
  const segs = h.benchmarks;
  const benchId = segs.length ? segs.map((x) => x.benchmarkId).sort().join('+') : null;
  const benchVersion = segs.length
    ? createHash('sha256')
        .update(JSON.stringify(segs.map((x) => [x.benchmarkId, x.basis ?? 'declared', x.datasetVersion, x.entitled, x.catalogueVerified, x.returnType, x.series.length, x.series.length ? x.series[x.series.length - 1].value : null, x.effectiveFrom.toISOString(), x.effectiveTo ? x.effectiveTo.toISOString() : null])))
        .digest('hex')
        .slice(0, 16)
    : null;
  return {
    scopeId: null,
    instrumentId: h.instrumentId,
    metricId: SCHEME_PERFORMANCE_BUNDLE,
    // Engine, report, spec, EVERY metric definition and EVERY policy value: bumping any one is a different key (spec 12.2).
    definitionVersion: bundleDefinitionVersion({ engineVersion: NAV2_ENGINE_VERSION, reportVersion: FUND_ANALYTICS_REPORT_VERSION, specDigest, registryDigest: metricRegistryDigest(NAV2_METRICS), policyDigest: policyDigest(input.policy) }),
    policyVersion: input.policy.version,
    requested: { start: spec.analysisStart, end: spec.asOfDate },
    actual: { start: h.series.firstDate, end: h.series.lastDate },
    navSeriesChecksum: h.series.checksum,
    benchmarkId: benchId,
    benchmarkDatasetVersion: benchVersion,
    riskFreeDatasetId: input.riskFree?.seriesId ?? null,
    riskFreeDatasetVersion: input.riskFree ? `${input.riskFree.datasetVersion}|${input.riskFree.enabled}` : null,
    transactionVersion: null,
    currency: input.displayCurrency,
  };
}

export function schemeBundleCacheKey(input: Parameters<typeof schemeBundleCacheParts>[0], h: HeldSchemeInput): string {
  return buildResultCacheKey(schemeBundleCacheParts(input, h));
}

function downsample<T extends [string, number]>(points: T[]): { out: T[]; downsampled: boolean } {
  if (points.length <= CHART_MAX_POINTS) return { out: points, downsampled: false };
  const out: T[] = [];
  const step = points.length / CHART_MAX_POINTS;
  for (let i = 0; i < CHART_MAX_POINTS - 1; i++) out.push(points[Math.min(points.length - 1, Math.floor((i + 1) * step) - 1)]);
  out.push(points[points.length - 1]);
  return { out: out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0]), downsampled: true };
}

function chartFor(s: PreparedSeries, ctx: Nav2Context): ChartData {
  const obs = s.observations.map((o) => [o.date, o.value] as [string, number]);
  const { out: navPoints, downsampled } = downsample(obs);
  const keep = new Set(navPoints.map((p) => p[0]));
  const align = (r: Nav2Result<TrendValue>): Array<[string, number]> => (r.state === 'available' ? r.value.points.filter((p) => keep.has(p.date)).map((p) => [p.date, p.value] as [string, number]) : []);
  return {
    navPoints,
    sma50: align(sma(s, ctx, 50)),
    sma200: align(sma(s, ctx, 200)),
    gaps: s.gaps,
    downsampled,
  };
}

/** Every Nav2Result inside a value, counted by typed state. */
export function countStates(value: unknown, acc: Record<string, number> = {}): Record<string, number> {
  if (Array.isArray(value)) value.forEach((v) => countStates(v, acc));
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.state === 'string' && 'provenance' in o) acc[o.state as Nav2State] = (acc[o.state as Nav2State] ?? 0) + 1;
    for (const v of Object.values(o)) countStates(v, acc);
  }
  return acc;
}

function sortedObject<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function buildFundAnalyticsReport(input: FundAnalyticsInput): { report: FundAnalyticsReport; manifest: FundAnalyticsManifest } {
  const ctx: Nav2Context = { policy: input.policy, currency: input.displayCurrency };
  const schemes = [...input.schemes].sort((a, b) => (a.schemeName < b.schemeName ? -1 : a.schemeName > b.schemeName ? 1 : a.instrumentId < b.instrumentId ? -1 : 1));

  const blocks: FundAnalyticsSchemeBlock[] = schemes.map((h) => {
    // `since_first_held` narrows each scheme's metric window to ITS OWN first held date.
    const analysisStart = input.periodChoice === 'since_first_held' ? h.firstHeldDate : input.spec.analysisStart;
    const spec: AnalysisSpec = { ...input.spec, analysisStart };
    const analytics: HeldSchemeAnalytics = h.cachedScheme
      ? { scheme: h.cachedScheme, investor: h.investor ? computeInvestorExperience(h.investor, ctx) : null, explanation: SCHEME_VS_INVESTOR_EXPLANATION }
      : computeHeldSchemeAnalytics({ series: h.series, spec, ctx, benchmarks: h.benchmarks, riskFree: input.riskFree }, h.investor);
    const chart = chartFor(h.series, ctx);
    const stored: HeldSchemeAnalytics = { ...analytics, scheme: compactSchemeFamily(analytics.scheme) };
    return {
      instrumentId: h.instrumentId,
      schemeName: h.schemeName,
      planType: h.planType,
      optionType: h.optionType,
      categoryLabel: h.categoryLabel,
      firstHeldDate: h.firstHeldDate,
      ...(h.ownership ? { ownership: h.ownership } : {}),
      analytics: stored,
      chart,
      navSeriesSummary: { firstDate: h.series.firstDate, lastDate: h.series.lastDate, count: h.series.count, checksum: h.series.checksum, materialGapCount: h.series.gaps.length, weekdayCoverageRatio: h.series.weekdayCoverageRatio },
    };
  });

  // ---- ranking among HELD schemes (CAGR by trailing period) --------------------------------
  const rankings = input.spec.pointToPoint.map((p) => {
    const candidates: RankingCandidate[] = blocks.map((b, i) => {
      const entry = b.analytics.scheme.pointToPoint.find((x) => x.id === p.id);
      const r = entry?.cagr;
      return {
        instrumentId: b.instrumentId,
        category: schemes[i].category,
        planType: schemes[i].planType,
        optionType: schemes[i].optionType,
        horizonId: p.id,
        metricId: 'cagr',
        metricDefinitionVersion: NAV2_METRICS.cagr.version,
        state: r?.state ?? 'insufficient_history',
        value: r && r.state === 'available' ? r.value.cagr : null,
      };
    });
    return { horizonId: p.id, result: rankHeldSchemes(candidates, input.asOfDate, ctx) };
  });

  // ---- correlations among held schemes -----------------------------------------------------
  const held = new Set(schemes.map((s) => s.instrumentId));
  const correlations: CorrelationPair[] = [];
  let skipped: string | null = null;
  if (schemes.length > MAX_SCHEMES_FOR_PAIRS) {
    skipped = `Correlations are shown for up to ${MAX_SCHEMES_FOR_PAIRS} funds. This report has ${schemes.length} funds, so pairs are not calculated.`;
  } else {
    for (let i = 0; i < schemes.length; i++) {
      for (let j = i + 1; j < schemes.length; j++) {
        const a = schemes[i];
        const b = schemes[j];
        const start = input.periodChoice === 'since_first_held' ? [a.firstHeldDate, b.firstHeldDate].filter((d): d is string => !!d).sort().slice(-1)[0] ?? null : input.spec.analysisStart;
        correlations.push({ aInstrumentId: a.instrumentId, bInstrumentId: b.instrumentId, result: correlationBetweenHeldSchemes(a.series, b.series, ctx, held, { start, end: input.spec.analysisEnd }, input.spec.frequency) });
      }
    }
  }

  // ---- notes stated once -------------------------------------------------------------------
  const notes: string[] = [];
  if (input.scope.entityHeldSchemesExcluded > 0) {
    notes.push(`${input.scope.entityHeldSchemesExcluded} fund${input.scope.entityHeldSchemesExcluded === 1 ? ' is' : 's are'} held through a trust, HUF or company and ${input.scope.entityHeldSchemesExcluded === 1 ? 'is' : 'are'} not included in this personal report.`);
  }
  if (input.scope.otherInstrumentsExcluded > 0) notes.push(`${input.scope.otherInstrumentsExcluded} holding${input.scope.otherInstrumentsExcluded === 1 ? ' is' : 's are'} not Indian mutual funds and ${input.scope.otherInstrumentsExcluded === 1 ? 'is' : 'are'} not covered by this report.`);
  if (input.scope.statementLinesAwaitingReview > 0) notes.push(`${input.scope.statementLinesAwaitingReview} statement line${input.scope.statementLinesAwaitingReview === 1 ? ' is' : 's are'} waiting for a review decision and ${input.scope.statementLinesAwaitingReview === 1 ? 'is' : 'are'} not shown here yet.`);
  for (const u of input.scope.priceHistoryUnavailable) notes.push(`Price history for ${u.schemeName} could not be loaded (${u.reason}); its figures are marked not available.`);
  const firstRf = blocks.flatMap((b) => [b.analytics.scheme.sharpe, b.analytics.scheme.sortino, b.analytics.scheme.alpha]).find((r) => r && r.state === 'available');
  const calculationNotes: string[] = [];
  if (firstRf && firstRf.state === 'available' && firstRf.provenance.riskFree) {
    notes.push(riskFreeShortNote(firstRf.provenance.riskFree));
    calculationNotes.push(firstRf.provenance.riskFree.disclosureText);
  }
  const bench = blocks.flatMap((b) => [b.analytics.scheme.beta, b.analytics.scheme.alpha]).find((r) => r && r.state === 'available' && r.provenance.benchmark);
  if (bench && bench.state === 'available' && bench.provenance.benchmark) notes.push(`Beta and alpha use ${bench.provenance.benchmark.label} (${bench.provenance.benchmark.basisLabel}) where a declared benchmark is available.`);
  const selection: ReportSelection = input.selection ?? { basis: 'all_held', heldFundCount: schemes.length, chosenInstrumentIds: schemes.map((h) => h.instrumentId), max: FUND_ANALYTICS_MAX_FUNDS };
  const partial = selection.heldFundCount > selection.chosenInstrumentIds.length;
  if (partial) notes.push(coversSomeFundsNote(selection.chosenInstrumentIds.length, selection.heldFundCount));
  notes.push(figuresAsAtNote(showDate(ctx, input.asOfDate)));

  const report: FundAnalyticsReport = {
    reportVersion: FUND_ANALYTICS_REPORT_VERSION,
    asOfDate: input.asOfDate,
    displayCurrency: input.displayCurrency,
    periodChoice: input.periodChoice,
    policyVersion: input.policy.version,
    engineVersion: NAV2_ENGINE_VERSION,
    spec: input.spec,
    schemes: blocks,
    comparison: { label: 'Your held schemes', rankings, correlations, correlationsSkippedReason: skipped },
    scope: input.scope,
    ...(partial ? { selection: { heldFundCount: selection.heldFundCount, chosenCount: selection.chosenInstrumentIds.length, max: selection.max, chosenInstrumentIds: [...selection.chosenInstrumentIds].sort() } } : {}),
    notes,
    ...(calculationNotes.length > 0 ? { calculationNotes } : {}),
    stateCounts: {},
  };
  report.stateCounts = sortedObject(countStates(report));

  const rfProv = firstRf && firstRf.state === 'available' ? firstRf.provenance.riskFree : undefined;
  const supply = input.riskFree;
  const manifest: FundAnalyticsManifest = {
    manifestVersion: FUND_ANALYTICS_MANIFEST_VERSION,
    reportVersion: FUND_ANALYTICS_REPORT_VERSION,
    asOfDate: input.asOfDate,
    policyVersion: input.policy.version,
    engineVersion: NAV2_ENGINE_VERSION,
    metricDefinitionVersions: sortedObject(Object.fromEntries(Object.values(NAV2_METRICS).map((m) => [m.id, m.version]))),
    metricDefinitions: Object.values(NAV2_METRICS).map((m) => ({ id: m.id, family: m.family, version: m.version })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    metricRegistryDigest: metricRegistryDigest(NAV2_METRICS),
    calculatedAt: input.calculatedAt ?? null,
    periodChoice: input.periodChoice,
    selection: { ...selection, chosenInstrumentIds: [...selection.chosenInstrumentIds].sort() },
    calculationNotes,
    riskFree: supply ? { seriesId: supply.seriesId, seriesLabel: RISK_FREE_SERIES_LABELS[supply.seriesId as RiskFreeSeriesId] ?? supply.seriesName, datasetVersion: rfProv?.datasetVersion ?? supply.datasetVersion, retrievedOn: supply.retrievedOn, termsReviewStatus: supply.termsReviewStatus, verifiedThroughDate: supply.verifiedThroughDate, enabled: supply.enabled } : null,
    schemes: schemes.map((h) => {
      const b = blocks.find((x) => x.instrumentId === h.instrumentId)!;
      const betaR = b.analytics.scheme.beta;
      const bp = betaR && betaR.state === 'available' ? betaR.provenance.benchmark : undefined;
      return {
        instrumentId: h.instrumentId,
        navSeries: { checksum: h.series.checksum, firstDate: h.series.firstDate, lastDate: h.series.lastDate, count: h.series.count, materialGapCount: h.series.gaps.length },
        navRange: { from: h.series.firstDate, to: h.series.lastDate },
        benchmark: bp ? { benchmarkId: bp.benchmarkId, datasetVersion: bp.datasetVersion, basis: bp.basis } : null,
        benchmarks: h.benchmarks.map((x) => ({ benchmarkId: x.benchmarkId, datasetVersion: x.datasetVersion ?? null, basis: x.basis ?? 'declared' })),
        transactionVersion: h.investor ? transactionFingerprint(h.investor) : null,
        ownership: h.ownership ?? null,
      };
    }),
  };
  return { report, manifest };
}

/** Fingerprint of an investor's transactions and valuation (what the XIRR / value / gain figures rest on). Order-independent for the flows. */
export function transactionFingerprint(i: InvestorExperienceInput): string {
  const flows = [...i.flows].map((f) => [f.date instanceof Date ? f.date.toISOString().slice(0, 10) : String(f.date).slice(0, 10), f.amount]).sort((a, b) => (String(a[0]) + String(a[1]) < String(b[0]) + String(b[1]) ? -1 : 1));
  return createHash('sha256').update(JSON.stringify({ flows, valuation: i.valuation, asOf: i.asOfDate }), 'utf8').digest('hex').slice(0, 16);
}

/** SHA-256 of the canonical (key-sorted) manifest JSON: the value stored beside the pinned report. */
export function manifestChecksum(manifest: FundAnalyticsManifest): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(manifest)), 'utf8').digest('hex');
}
