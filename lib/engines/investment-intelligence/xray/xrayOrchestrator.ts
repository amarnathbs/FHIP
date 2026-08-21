// Investment Intelligence R5 — Portfolio X-Ray orchestration.
//
// Pure: takes a fully-loaded dataset and returns versioned results. All
// database access lives in the repository layer.
//
// THE DISPLAY CONTRACT this module enforces for every consumer:
//   * `effectiveCoverage` is ALWAYS present and must always be displayed.
//   * Every sub-analysis independently reports 'unavailable' rather than
//     returning zeros, so a UI that renders only 'ok' results can never
//     draw a fabricated all-zero chart.
//   * Portfolio positions as-of and fund-holdings as-of are BOTH returned,
//     separately, because they legitimately differ and the difference must
//     be visible.

import {
  calculatePortfolioLookThrough,
  topEffectiveHoldings,
  type FundHoldingsSnapshot,
  type PortfolioFundPosition,
  type LookThroughResult,
} from './lookThrough';
import { calculateOverlapMatrix, calculateFundOverlap, type OverlapMatrix, type FundOverlapResult } from './overlap';
import {
  calculateSecurityConcentration,
  calculateSectorExposure,
  calculateIndustryExposure,
  calculateMarketCapExposure,
  calculateAmcConcentration,
  calculateSchemeConcentration,
  type SecurityConcentrationResult,
  type ClassificationExposureResult,
  type AmcConcentrationResult,
} from './concentration';
import {
  calculateCreditQuality,
  calculateMaturityBuckets,
  calculateWeightedDuration,
  calculateIssuerConcentration,
  type DebtExposureLine,
  type CreditQualityResult,
  type DurationResult,
  type IssuerConcentrationResult,
} from './debtXray';
import { TOP_HOLDINGS_DEFAULT_N } from '@/lib/config/investment-intelligence/xrayThresholds';
import { XRAY_ENGINE_VERSION, R5_XRAY_SUB_VERSIONS, fingerprintXrayInputs } from '../r5Versioning';

export interface XrayDataset {
  userId: string;
  asOfDate: string;
  /** Portfolio positions as-of date — may legitimately differ from asOfDate and from holdings dates. */
  portfolioAsOfDate: string;
  positions: PortfolioFundPosition[];
  snapshotsByFund: Map<string, FundHoldingsSnapshot[]>;
  classificationVersion: string | null;
  /** Debt exposure lines, already look-through-weighted by the repository where debt data exists. */
  debtLines?: DebtExposureLine[];
  /** Approved multi-agency rating consolidation methodology, or null when none is configured. */
  creditConsolidationMethodology?: string | null;
  sectorLabels?: Map<string, string>;
}

export interface XrayResult {
  asOfDate: string;
  portfolioAsOfDate: string;
  /** Newest / oldest contributing fund-holdings snapshot dates. Displayed separately from the above. */
  holdingsAsOfDate: string | null;
  oldestHoldingsDate: string | null;
  lookThrough: LookThroughResult;
  topHoldings: ReturnType<typeof topEffectiveHoldings>;
  securityConcentration: SecurityConcentrationResult;
  schemeConcentration: SecurityConcentrationResult;
  sectorExposure: ClassificationExposureResult;
  industryExposure: ClassificationExposureResult;
  marketCapExposure: ClassificationExposureResult;
  amcConcentration: AmcConcentrationResult;
  overlapMatrix: OverlapMatrix | null;
  debt: {
    /** True only when genuine debt holdings exist. When false the UI shows NOTHING, not empty widgets. */
    applicable: boolean;
    creditQuality: CreditQualityResult | null;
    maturity: ReturnType<typeof calculateMaturityBuckets> | null;
    duration: DurationResult | null;
    issuerConcentration: IssuerConcentrationResult | null;
  };
  /** Fund-manager concentration is DEFERRED — no reliable versioned metadata source exists. */
  fundManagerConcentration: { status: 'deferred'; detail: string };
  inputSnapshotVersion: string;
  engineVersion: typeof XRAY_ENGINE_VERSION;
  subVersions: typeof R5_XRAY_SUB_VERSIONS;
  classificationVersion: string | null;
  snapshotIdsUsed: string[];
}

export function runXrayAnalytics(dataset: XrayDataset, options: { topN?: number } = {}): XrayResult {
  const lookThrough = calculatePortfolioLookThrough(dataset.positions, dataset.snapshotsByFund, dataset.asOfDate, dataset.portfolioAsOfDate);
  const labelFor = (k: string) => dataset.sectorLabels?.get(k) ?? k;

  // Overlap is only meaningful across two or more funds that have snapshots.
  const fundsWithSnapshots = dataset.positions.map((p) => {
    const snaps = dataset.snapshotsByFund.get(p.fundInstrumentId) ?? [];
    const eligible = snaps
      .filter((s) => s.holdingsAsOfDate <= dataset.asOfDate)
      .sort((a, b) => (b.holdingsAsOfDate.localeCompare(a.holdingsAsOfDate)) || b.snapshotId.localeCompare(a.snapshotId));
    return { fundInstrumentId: p.fundInstrumentId, fundName: p.fundName, snapshot: eligible[0] ?? null };
  });
  const overlapMatrix = fundsWithSnapshots.filter((f) => f.snapshot).length >= 2 ? calculateOverlapMatrix(fundsWithSnapshots, dataset.asOfDate) : null;

  const debtLines = dataset.debtLines ?? [];
  const debtApplicable = debtLines.length > 0;

  const inputSnapshotVersion = fingerprintXrayInputs({
    positions: dataset.positions.map((p) => ({ fundInstrumentId: p.fundInstrumentId, value: p.value })),
    snapshotIds: lookThrough.snapshotIdsUsed,
    holdingsSourceVersions: lookThrough.snapshotIdsUsed.map((id) => {
      for (const snaps of dataset.snapshotsByFund.values()) {
        const s = snaps.find((x) => x.snapshotId === id);
        if (s) return s.sourceDataVersion ?? '';
      }
      return '';
    }),
    classificationVersion: dataset.classificationVersion,
    asOfDate: dataset.asOfDate,
    portfolioAsOfDate: dataset.portfolioAsOfDate,
    methodVersions: { ...R5_XRAY_SUB_VERSIONS, engine: XRAY_ENGINE_VERSION },
  });

  return {
    asOfDate: dataset.asOfDate,
    portfolioAsOfDate: dataset.portfolioAsOfDate,
    holdingsAsOfDate: lookThrough.newestHoldingsDate,
    oldestHoldingsDate: lookThrough.oldestHoldingsDate,
    lookThrough,
    topHoldings: topEffectiveHoldings(lookThrough, options.topN ?? TOP_HOLDINGS_DEFAULT_N),
    securityConcentration: calculateSecurityConcentration(lookThrough),
    schemeConcentration: calculateSchemeConcentration(dataset.positions),
    sectorExposure: calculateSectorExposure(lookThrough, dataset.classificationVersion, labelFor),
    industryExposure: calculateIndustryExposure(lookThrough, dataset.classificationVersion, labelFor),
    marketCapExposure: calculateMarketCapExposure(lookThrough, dataset.classificationVersion),
    amcConcentration: calculateAmcConcentration(dataset.positions),
    overlapMatrix,
    debt: {
      applicable: debtApplicable,
      creditQuality: debtApplicable ? calculateCreditQuality(debtLines, dataset.creditConsolidationMethodology ?? null) : null,
      maturity: debtApplicable ? calculateMaturityBuckets(debtLines, dataset.asOfDate) : null,
      duration: debtApplicable ? calculateWeightedDuration(debtLines) : null,
      issuerConcentration: debtApplicable ? calculateIssuerConcentration(debtLines) : null,
    },
    fundManagerConcentration: {
      status: 'deferred',
      detail:
        'Fund-manager concentration is not shown. No reliable, versioned fund-manager metadata source is available to this platform, and inferring a manager from scheme names would not be dependable. This analysis is deferred rather than estimated.',
    },
    inputSnapshotVersion,
    engineVersion: XRAY_ENGINE_VERSION,
    subVersions: R5_XRAY_SUB_VERSIONS,
    classificationVersion: dataset.classificationVersion,
    snapshotIdsUsed: lookThrough.snapshotIdsUsed,
  };
}

/** Single-pair overlap detail, for a drill-down view. */
export function runPairOverlap(dataset: XrayDataset, fundAId: string, fundBId: string): FundOverlapResult {
  const pick = (id: string) => {
    const snaps = (dataset.snapshotsByFund.get(id) ?? [])
      .filter((s) => s.holdingsAsOfDate <= dataset.asOfDate)
      .sort((a, b) => (b.holdingsAsOfDate.localeCompare(a.holdingsAsOfDate)) || b.snapshotId.localeCompare(a.snapshotId));
    return snaps[0] ?? null;
  };
  return calculateFundOverlap(pick(fundAId), pick(fundBId), dataset.asOfDate, fundAId, fundBId);
}

/** The mandatory data-quality summary every X-Ray view must render. */
export interface XrayDataQualitySummary {
  effectiveCoverage: number;
  schemeCoverage: number;
  holdingsCoverageWithinSchemes: number;
  freshness: string;
  qualityStatuses: string[];
  portfolioConclusionSuppressed: boolean;
  mixedDateWarning: boolean;
  mixedDateSpreadDays: number | null;
  portfolioAsOfDate: string;
  holdingsAsOfDate: string | null;
  oldestHoldingsDate: string | null;
  /** Human-readable, safe to render verbatim. */
  statement: string;
}

export function summariseXrayDataQuality(result: XrayResult): XrayDataQualitySummary {
  const lt = result.lookThrough;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  let statement: string;
  if (lt.status !== 'ok') {
    statement =
      lt.detail ??
      'Look-through exposure is not available for this portfolio, so no underlying-holdings analysis is shown.';
  } else {
    const parts = [
      `This analysis covers ${pct(lt.effectiveCoverage)} of the portfolio: ${pct(lt.schemeCoverage)} of its value is in schemes with published holdings, and those schemes disclose ${pct(lt.holdingsCoverageWithinSchemes)} of their portfolios.`,
    ];
    parts.push(
      `Portfolio positions are as at ${result.portfolioAsOfDate}; fund holdings are as at ${result.holdingsAsOfDate}${
        result.oldestHoldingsDate && result.oldestHoldingsDate !== result.holdingsAsOfDate ? ` (oldest contributing disclosure ${result.oldestHoldingsDate})` : ''
      }.`
    );
    if (lt.mixedDateWarning) {
      parts.push(`Contributing disclosures span ${lt.mixedDateSpreadDays} days, so this view mixes more than one portfolio date.`);
    }
    if (lt.freshness === 'STALE' || lt.freshness === 'VERY_STALE') {
      parts.push('At least one scheme’s holdings disclosure is older than the freshness threshold, so this describes an older composition.');
    }
    if (lt.portfolioConclusionSuppressed) {
      parts.push('Coverage is too low, or disclosure dates too far apart, for a portfolio-level conclusion; the figures below describe only the covered portion.');
    }
    statement = parts.join(' ');
  }

  return {
    effectiveCoverage: lt.effectiveCoverage,
    schemeCoverage: lt.schemeCoverage,
    holdingsCoverageWithinSchemes: lt.holdingsCoverageWithinSchemes,
    freshness: lt.freshness,
    qualityStatuses: lt.qualityStatuses,
    portfolioConclusionSuppressed: lt.portfolioConclusionSuppressed,
    mixedDateWarning: lt.mixedDateWarning,
    mixedDateSpreadDays: lt.mixedDateSpreadDays,
    portfolioAsOfDate: result.portfolioAsOfDate,
    holdingsAsOfDate: result.holdingsAsOfDate,
    oldestHoldingsDate: result.oldestHoldingsDate,
    statement,
  };
}
