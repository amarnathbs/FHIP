// II-PC2 — the Overview's analysis-availability model (spec sections 12, 13,
// 29, 30).
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE
// ------------------------------------------
// Spec section 30: "Never infer AVAILABLE merely because route exists.
// Availability must come from underlying API/data." Every status below is
// therefore a pure function of counts read from the user's own rows — never
// of the fact that a page exists, and never of a hard-coded default.
//
// Spec section 12 additionally forbids collapsing "unavailable" to a zero:
// a card that cannot be produced says WHY, and the Overview never renders a
// number for it.
//
// WHY THIS IS NOT THE R4 `CalculationStatus` UNION
// ------------------------------------------------
// `lib/engines/investment-intelligence/calculationStatus.ts` classifies ONE
// METRIC that an engine has already attempted to compute (it has reasons like
// AMBIGUOUS for multiple IRR roots). The Overview classifies WHETHER A WHOLE
// ANALYSIS IS WORTH OPENING, before any engine runs, and it needs two states
// R4 has no concept of (NEEDS_RECONCILIATION, UNSUPPORTED). The two
// vocabularies are related but not interchangeable, so rather than widen R4's
// union — which is persisted into `ii_analytics_results.quality_status` and
// must not gain values that constraint rejects — PC2 defines its own and
// provides `fromCalculationStatus` as the one-way bridge.

import type { CalculationStatus } from '@/lib/engines/investment-intelligence/calculationStatus';
import { MIN_CONTRIBUTIONS_FOR_INFERENCE } from '@/lib/config/investment-intelligence/sipThresholds';
import { MINIMUM_OBSERVATIONS } from '@/lib/config/investment-intelligence/minimumHistory';

export type AnalysisAvailability =
  /** The analysis can be produced from this user's certified data right now. */
  | 'AVAILABLE'
  /** The user's data is valid but too thin for this analysis to mean anything. */
  | 'NOT_ENOUGH_DATA'
  /** The user's data is fine; reference data we do not hold (NAV/benchmark/fund holdings) is missing. */
  | 'REFERENCE_DATA_MISSING'
  /** The analysis is meaningless for what this user holds. */
  | 'NOT_APPLICABLE'
  /** Data exists but is blocked behind an unresolved reconciliation issue. */
  | 'NEEDS_RECONCILIATION'
  /** A previously-produced result exists but its inputs have since moved. */
  | 'STALE'
  /** This asset type / workflow is not supported by the current engine. */
  | 'UNSUPPORTED'
  /** Status could not be determined — never silently rendered as "nothing here". */
  | 'ERROR';

/** One-way bridge from an engine's per-metric status onto the card vocabulary. */
export function fromCalculationStatus(status: CalculationStatus): AnalysisAvailability {
  switch (status) {
    case 'CALCULATED':
      return 'AVAILABLE';
    case 'INSUFFICIENT_HISTORY':
      return 'NOT_ENOUGH_DATA';
    case 'MISSING_REFERENCE_DATA':
      return 'REFERENCE_DATA_MISSING';
    case 'STALE':
      return 'STALE';
    case 'NOT_APPLICABLE':
      return 'NOT_APPLICABLE';
    case 'FAILED':
    case 'AMBIGUOUS':
      return 'ERROR';
  }
}

/** True only for statuses whose card may advertise a usable analysis. */
export function isAnalysisReachable(status: AnalysisAvailability): boolean {
  return status === 'AVAILABLE' || status === 'STALE';
}

/**
 * Short, user-facing status label. Deliberately plain English — spec section
 * 37 forbids exposing internal vocabulary as primary UX language, so the enum
 * name itself is never rendered.
 */
export const AVAILABILITY_LABEL: Record<AnalysisAvailability, string> = {
  AVAILABLE: 'Available',
  NOT_ENOUGH_DATA: 'Not enough data yet',
  REFERENCE_DATA_MISSING: 'Reference data missing',
  NOT_APPLICABLE: 'Not applicable',
  NEEDS_RECONCILIATION: 'Needs review first',
  STALE: 'Needs recalculating',
  UNSUPPORTED: 'Not supported',
  ERROR: 'Status unavailable',
};

/**
 * The cheap, already-persisted counts the Overview derives every card from.
 *
 * EVERY FIELD HERE IS A COUNT OR A DATE FROM A PLAIN TABLE SELECT. Spec
 * section 40 forbids the Overview from running Performance + SIP + X-Ray +
 * Tax + Review engines just to draw status cards, and three of those engine
 * routes additionally WRITE derived rows on GET — so the Overview must never
 * call them. Nothing in this interface can be obtained only by running an
 * engine.
 */
export interface OverviewSignals {
  /** Latest holding snapshot per (account, instrument). */
  positionCount: number;
  /** Positions whose portfolio-truth status is certified or certified_with_warnings. */
  certifiedPositionCount: number;
  /** Positions parked in reconciliation_required. */
  reconciliationRequiredPositionCount: number;
  /** Open rows in ii_reconciliation_cases. */
  openReconciliationCaseCount: number;
  /** Any ii_transactions row for this user. */
  transactionCount: number;
  /** Acquisition-side transactions — the raw material for recurring-series inference. */
  contributionCount: number;
  /** Disposals, using the tax engine's own DISPOSAL_TYPES vocabulary. */
  disposalCount: number;
  /** Distinct instruments held that have at least one NAV price point. */
  instrumentsWithNavCount: number;
  /** Distinct instruments held that are mapped to a benchmark. */
  instrumentsWithBenchmarkCount: number;
  /** Distinct held instruments that have any fund-holdings disclosure line. */
  instrumentsWithFundHoldingsCount: number;
  /** Held instruments that are look-through-able at all (mutual funds / ETFs). */
  lookThroughEligibleInstrumentCount: number;
  /** Open ii_review_items. */
  openReviewItemCount: number;
  /** Rows the Review Centre has ever produced, open or not. */
  reviewItemCount: number;
}

export interface AnalysisCard {
  key: 'performance' | 'sip' | 'xray' | 'tax' | 'review';
  status: AnalysisAvailability;
  /** Why the status is what it is. Shown verbatim; never a fabricated number. */
  detail: string;
}

/**
 * Performance (R4).
 *
 * Ordering matters and is deliberate: a blocking reconciliation issue is
 * reported BEFORE a data-thinness verdict, because telling a user "not enough
 * data" when the real problem is an unresolved mismatch sends them to upload
 * more statements instead of to the fix.
 */
export function performanceAvailability(s: OverviewSignals): AnalysisCard {
  const base = { key: 'performance' as const };
  if (s.positionCount === 0) {
    return { ...base, status: 'NOT_ENOUGH_DATA', detail: 'No investment positions have been reconstructed yet. Import a statement to begin.' };
  }
  if (s.certifiedPositionCount === 0 && s.reconciliationRequiredPositionCount > 0) {
    return { ...base, status: 'NEEDS_RECONCILIATION', detail: 'Your positions still have data issues to resolve before performance can be calculated.' };
  }
  if (s.instrumentsWithNavCount === 0) {
    return {
      ...base,
      status: 'REFERENCE_DATA_MISSING',
      detail: 'We do not hold a price history for the schemes you own, so returns cannot be calculated.',
    };
  }
  // twrrMinValuationPoints is the engine's own floor: with a single valuation
  // point there is no sub-period, so no time-weighted return exists at all.
  if (s.instrumentsWithNavCount < 1 || s.positionCount < 1) {
    return { ...base, status: 'NOT_ENOUGH_DATA', detail: 'Not enough valuation history yet.' };
  }
  const benchmarkNote =
    s.instrumentsWithBenchmarkCount === 0
      ? ' Benchmark comparison is not available — none of your schemes is mapped to a benchmark.'
      : '';
  return {
    ...base,
    status: 'AVAILABLE',
    detail: `Returns and risk measures can be calculated from ${s.positionCount} position${s.positionCount === 1 ? '' : 's'}.${benchmarkNote}`,
  };
}

/**
 * Recurring investments (R5 SIP).
 *
 * The engine will not infer a recurring pattern from fewer than
 * MIN_CONTRIBUTIONS_FOR_INFERENCE contributions, so below that floor the
 * Overview says so rather than sending the user to a page that can only tell
 * them the same thing. At or above it, the card is AVAILABLE and the page's
 * own "no recurring contribution series were identified" state (which already
 * exists) handles a genuine no-series outcome — that is a real analytical
 * finding, not an unavailability.
 */
export function sipAvailability(s: OverviewSignals): AnalysisCard {
  const base = { key: 'sip' as const };
  if (s.transactionCount === 0) {
    return { ...base, status: 'NOT_ENOUGH_DATA', detail: 'No investment transactions have been imported yet.' };
  }
  if (s.contributionCount < MIN_CONTRIBUTIONS_FOR_INFERENCE) {
    return {
      ...base,
      status: 'NOT_ENOUGH_DATA',
      detail: `A recurring pattern needs at least ${MIN_CONTRIBUTIONS_FOR_INFERENCE} contributions to the same scheme. ${s.contributionCount} contribution${
        s.contributionCount === 1 ? ' has' : 's have'
      } been imported so far.`,
    };
  }
  return { ...base, status: 'AVAILABLE', detail: `${s.contributionCount} contributions are available to analyse for recurring patterns.` };
}

/**
 * Fund holdings / X-Ray (R5).
 *
 * The distinction between NOT_APPLICABLE and REFERENCE_DATA_MISSING is the
 * whole point of this card (spec section 13): a portfolio of only direct
 * equities has nothing to look THROUGH — that is not a data gap and must not
 * be reported as one — whereas funds we hold no disclosure for is exactly a
 * reference-data gap, and must never render as 0% sector exposure.
 */
export function xrayAvailability(s: OverviewSignals): AnalysisCard {
  const base = { key: 'xray' as const };
  if (s.positionCount === 0) {
    return { ...base, status: 'NOT_ENOUGH_DATA', detail: 'No investment positions have been reconstructed yet.' };
  }
  if (s.lookThroughEligibleInstrumentCount === 0) {
    return {
      ...base,
      status: 'NOT_APPLICABLE',
      detail: 'You hold no mutual funds or ETFs. Look-through analysis applies to pooled investments, not to shares you hold directly.',
    };
  }
  if (s.instrumentsWithFundHoldingsCount === 0) {
    return {
      ...base,
      status: 'REFERENCE_DATA_MISSING',
      detail: 'Underlying holdings analysis is not available for these schemes — we hold no portfolio disclosure for them.',
    };
  }
  const partial = s.instrumentsWithFundHoldingsCount < s.lookThroughEligibleInstrumentCount;
  return {
    ...base,
    status: 'AVAILABLE',
    detail: partial
      ? `Disclosure is available for ${s.instrumentsWithFundHoldingsCount} of your ${s.lookThroughEligibleInstrumentCount} funds. Coverage and as-at dates are shown on the page.`
      : `Underlying holdings are available for all ${s.lookThroughEligibleInstrumentCount} of your funds.`,
  };
}

/**
 * Tax & cost (R6).
 *
 * "No disposal" is NOT_APPLICABLE, not NOT_ENOUGH_DATA: capital-gains tax
 * genuinely does not arise until units are redeemed or switched out, so
 * calling it a data shortfall would imply the user should go and find more
 * data. Spec section 13 requires this exact distinction, and forbids
 * rendering a fabricated zero realised gain in its place.
 */
export function taxAvailability(s: OverviewSignals): AnalysisCard {
  const base = { key: 'tax' as const };
  if (s.transactionCount === 0) {
    return { ...base, status: 'NOT_ENOUGH_DATA', detail: 'No investment transactions have been imported yet.' };
  }
  if (s.disposalCount === 0) {
    return {
      ...base,
      status: 'NOT_APPLICABLE',
      detail: 'No recorded disposal requiring a realised-gain calculation. Capital gains arise only once units are redeemed, switched out, or sold.',
    };
  }
  return {
    ...base,
    status: 'AVAILABLE',
    detail: `${s.disposalCount} recorded disposal${s.disposalCount === 1 ? '' : 's'} can be assessed for estimated realised gains.`,
  };
}

/**
 * Review Centre (R9).
 *
 * Unlike the four analytics cards this one is never NOT_ENOUGH_DATA: the
 * Review Centre's job is to say what needs attention, and "nothing currently
 * needs your attention" is a genuine, useful answer rather than an
 * unavailability. It is only unavailable when there is no investment data at
 * all to review.
 */
export function reviewAvailability(s: OverviewSignals): AnalysisCard {
  const base = { key: 'review' as const };
  if (s.positionCount === 0 && s.transactionCount === 0 && s.openReconciliationCaseCount === 0) {
    return { ...base, status: 'NOT_ENOUGH_DATA', detail: 'There is no investment data to review yet.' };
  }
  if (s.openReviewItemCount > 0) {
    return {
      ...base,
      status: 'AVAILABLE',
      detail: `${s.openReviewItemCount} item${s.openReviewItemCount === 1 ? '' : 's'} currently need your attention.`,
    };
  }
  return {
    ...base,
    status: 'AVAILABLE',
    detail: s.reviewItemCount > 0 ? 'Nothing currently needs your attention.' : 'No review items have been raised for your investment data.',
  };
}

/** All five analysis cards, in the order the Overview renders them. */
export function buildAnalysisCards(s: OverviewSignals): AnalysisCard[] {
  return [performanceAvailability(s), sipAvailability(s), xrayAvailability(s), taxAvailability(s), reviewAvailability(s)];
}

/**
 * The workflow "what should I do next?" hint (spec section 10).
 *
 * Deliberately NEUTRAL and never financial advice: every branch describes a
 * DATA or WORKFLOW action the user can take inside this product. None of them
 * suggests buying, selling, switching, or changing a contribution — spec
 * section 51 forbids that outright.
 */
export interface NextStep {
  code: 'IMPORT_FIRST_STATEMENT' | 'RESOLVE_DATA_ISSUE' | 'CERTIFY_POSITION' | 'PUBLISH_POSITION' | 'REVIEW_ITEMS' | 'VIEW_ANALYSIS';
  message: string;
  href: string;
  ctaLabel: string;
}

export function nextStep(s: OverviewSignals, publishedCount: number): NextStep {
  if (s.positionCount === 0) {
    return {
      code: 'IMPORT_FIRST_STATEMENT',
      message: 'Import a CAMS or KFintech statement to reconstruct your mutual fund holdings.',
      href: '/investment-intelligence/data',
      ctaLabel: 'Import a statement',
    };
  }
  if (s.openReconciliationCaseCount > 0) {
    return {
      code: 'RESOLVE_DATA_ISSUE',
      message: `${s.openReconciliationCaseCount} data issue${s.openReconciliationCaseCount === 1 ? '' : 's'} need${
        s.openReconciliationCaseCount === 1 ? 's' : ''
      } review before your figures can be relied on.`,
      href: '/investment-intelligence/data',
      ctaLabel: 'Review data issues',
    };
  }
  if (s.certifiedPositionCount === 0) {
    return {
      code: 'CERTIFY_POSITION',
      message: 'None of your positions is certified yet. Certifying confirms the reconstructed holding matches your statement.',
      href: '/investment-intelligence/data',
      ctaLabel: 'Review positions',
    };
  }
  if (publishedCount === 0) {
    return {
      code: 'PUBLISH_POSITION',
      message: 'Publish a certified position to include it in your FHIP net worth alongside your other investments.',
      href: '/investment-intelligence/data',
      ctaLabel: 'Publish a position',
    };
  }
  if (s.openReviewItemCount > 0) {
    return {
      code: 'REVIEW_ITEMS',
      message: `${s.openReviewItemCount} item${s.openReviewItemCount === 1 ? '' : 's'} in the Review Centre need your attention.`,
      href: '/investment-intelligence/review',
      ctaLabel: 'Open Review Centre',
    };
  }
  return {
    code: 'VIEW_ANALYSIS',
    message: 'Your investment data is up to date. Explore the analysis available for it.',
    href: '/investment-intelligence/performance',
    ctaLabel: 'View performance',
  };
}

/** Re-exported so callers cannot drift from the engines' own eligibility floors. */
export const OVERVIEW_THRESHOLDS = {
  minContributionsForRecurring: MIN_CONTRIBUTIONS_FOR_INFERENCE,
  minValuationPointsForTwrr: MINIMUM_OBSERVATIONS.twrrMinValuationPoints,
} as const;
