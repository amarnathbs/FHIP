// II-PC2 — analysis-availability contract (spec sections 12, 13, 29, 30, 51,
// 52).
//
// THE PROHIBITION UNDER TEST
// --------------------------
// Spec section 12: "Do NOT reduce unavailable to 0 or 0.00%."
// Spec section 30: "Never infer AVAILABLE merely because route exists."
// Spec section 51: no personalised buy/sell/switch advice may appear.

import { describe, it, expect } from 'vitest';
import {
  buildAnalysisCards,
  performanceAvailability,
  sipAvailability,
  xrayAvailability,
  taxAvailability,
  reviewAvailability,
  fromCalculationStatus,
  isAnalysisReachable,
  nextStep,
  AVAILABILITY_LABEL,
  OVERVIEW_THRESHOLDS,
  type OverviewSignals,
} from '@/lib/investment-intelligence/analysisAvailability';
import { MIN_CONTRIBUTIONS_FOR_INFERENCE } from '@/lib/config/investment-intelligence/sipThresholds';
import { ACQUISITION_TRANSACTION_TYPES } from '@/lib/services/investment-intelligence/overviewSummary';
import { __sipAttributionInternals } from '@/lib/engines/investment-intelligence/sip/sipAttribution';

/** A user with nothing at all — the spec section 66 "empty user". */
const EMPTY: OverviewSignals = {
  positionCount: 0,
  certifiedPositionCount: 0,
  reconciliationRequiredPositionCount: 0,
  openReconciliationCaseCount: 0,
  transactionCount: 0,
  contributionCount: 0,
  disposalCount: 0,
  instrumentsWithNavCount: 0,
  instrumentsWithBenchmarkCount: 0,
  instrumentsWithFundHoldingsCount: 0,
  lookThroughEligibleInstrumentCount: 0,
  openReviewItemCount: 0,
  reviewItemCount: 0,
};

/** PC2-U1 — the "mutual fund rich" scenario (spec section 43). */
const RICH: OverviewSignals = {
  positionCount: 6,
  certifiedPositionCount: 6,
  reconciliationRequiredPositionCount: 0,
  openReconciliationCaseCount: 0,
  transactionCount: 120,
  contributionCount: 96,
  disposalCount: 4,
  instrumentsWithNavCount: 6,
  instrumentsWithBenchmarkCount: 6,
  instrumentsWithFundHoldingsCount: 6,
  lookThroughEligibleInstrumentCount: 6,
  openReviewItemCount: 2,
  reviewItemCount: 9,
};

const withSignals = (over: Partial<OverviewSignals>): OverviewSignals => ({ ...EMPTY, ...over });

describe('PC2-U1 — rich user sees maximum availability', () => {
  it('makes all five analyses available', () => {
    for (const card of buildAnalysisCards(RICH)) {
      expect(card.status, `${card.key} should be AVAILABLE for the rich scenario`).toBe('AVAILABLE');
    }
  });
});

describe('PC2-U2 / PC2-U6 — empty user gets explicit reasons, never zeros', () => {
  it('never reports AVAILABLE for a user with no data', () => {
    for (const card of buildAnalysisCards(EMPTY)) {
      expect(isAnalysisReachable(card.status)).toBe(false);
    }
  });

  it('gives every card a non-empty, number-free reason', () => {
    // Spec section 12/13: an unavailable card explains itself. It must never
    // present a fabricated quantity in place of the missing analysis.
    for (const card of buildAnalysisCards(EMPTY)) {
      expect(card.detail.trim().length).toBeGreaterThan(0);
      expect(card.detail).not.toMatch(/0\.00\s?%/);
      expect(card.detail).not.toMatch(/₹\s?0(\b|\.)/);
    }
  });
});

describe('Performance availability', () => {
  it('reports a reconciliation blockage BEFORE calling the data thin', () => {
    // Ordering matters: "not enough data" would send the user to upload more
    // statements when the real fix is resolving a mismatch they already have.
    const card = performanceAvailability(withSignals({ positionCount: 3, reconciliationRequiredPositionCount: 3 }));
    expect(card.status).toBe('NEEDS_RECONCILIATION');
  });

  it('distinguishes missing price history from thin user data', () => {
    const card = performanceAvailability(withSignals({ positionCount: 3, certifiedPositionCount: 3, instrumentsWithNavCount: 0 }));
    expect(card.status).toBe('REFERENCE_DATA_MISSING');
    expect(card.detail).toMatch(/price history/i);
  });

  it('is available but discloses the benchmark gap when no scheme is mapped', () => {
    const card = performanceAvailability(
      withSignals({ positionCount: 3, certifiedPositionCount: 3, instrumentsWithNavCount: 3, instrumentsWithBenchmarkCount: 0 })
    );
    expect(card.status).toBe('AVAILABLE');
    expect(card.detail).toMatch(/benchmark comparison is not available/i);
  });
});

describe('PC2-U3 — SIP availability', () => {
  it('is NOT_ENOUGH_DATA below the engine\'s own inference floor', () => {
    const card = sipAvailability(withSignals({ transactionCount: 2, contributionCount: MIN_CONTRIBUTIONS_FOR_INFERENCE - 1 }));
    expect(card.status).toBe('NOT_ENOUGH_DATA');
    expect(card.detail).toContain(String(MIN_CONTRIBUTIONS_FOR_INFERENCE));
  });

  it('becomes available exactly at the engine floor, not at an invented one', () => {
    const card = sipAvailability(withSignals({ transactionCount: 5, contributionCount: MIN_CONTRIBUTIONS_FOR_INFERENCE }));
    expect(card.status).toBe('AVAILABLE');
  });

  it('re-exports the engine threshold rather than hard-coding a copy', () => {
    expect(OVERVIEW_THRESHOLDS.minContributionsForRecurring).toBe(MIN_CONTRIBUTIONS_FOR_INFERENCE);
  });

  it('uses the same acquisition vocabulary as the R5 attribution engine', () => {
    // Guards the one genuine duplication in this feature: the Overview counts
    // "contributions" with its own list. If R5 ever adds an acquisition type,
    // this fails rather than the Overview silently undercounting.
    expect([...ACQUISITION_TRANSACTION_TYPES].sort()).toEqual([...__sipAttributionInternals.ACQUISITION_TYPES].sort());
  });
});

describe('PC2-U4 / PC2-U7 — X-Ray availability', () => {
  it('reports NOT_APPLICABLE (not a data gap) for a direct-equity-only portfolio', () => {
    // Spec sections 13, 28: there is nothing to look THROUGH in a directly
    // held share. Calling that "reference data missing" would imply we ought
    // to have data we could never legitimately have.
    const card = xrayAvailability(withSignals({ positionCount: 4, lookThroughEligibleInstrumentCount: 0 }));
    expect(card.status).toBe('NOT_APPLICABLE');
    expect(card.detail).toMatch(/no mutual funds or ETFs/i);
  });

  it('reports REFERENCE_DATA_MISSING when funds are held but undisclosed', () => {
    const card = xrayAvailability(withSignals({ positionCount: 4, lookThroughEligibleInstrumentCount: 4, instrumentsWithFundHoldingsCount: 0 }));
    expect(card.status).toBe('REFERENCE_DATA_MISSING');
    // Spec section 13's exact required framing.
    expect(card.detail).toMatch(/not available for these schemes/i);
    // And explicitly NOT a zero exposure claim.
    expect(card.detail).not.toMatch(/0%/);
  });

  it('discloses partial coverage rather than implying completeness', () => {
    const card = xrayAvailability(withSignals({ positionCount: 5, lookThroughEligibleInstrumentCount: 5, instrumentsWithFundHoldingsCount: 2 }));
    expect(card.status).toBe('AVAILABLE');
    expect(card.detail).toMatch(/2 of your 5/);
  });
});

describe('PC2-U5 / PC2-U6 — Tax availability', () => {
  it('treats "no disposal" as NOT_APPLICABLE, never as a zero realised gain', () => {
    // Spec section 13: "No recorded disposal requiring realised-gain
    // calculation" — NOT "₹0 realised gain".
    const card = taxAvailability(withSignals({ transactionCount: 40, contributionCount: 40, disposalCount: 0 }));
    expect(card.status).toBe('NOT_APPLICABLE');
    expect(card.detail).toMatch(/no recorded disposal/i);
    expect(card.detail).not.toMatch(/₹\s?0/);
  });

  it('is available once a disposal exists', () => {
    const card = taxAvailability(withSignals({ transactionCount: 40, disposalCount: 2 }));
    expect(card.status).toBe('AVAILABLE');
    expect(card.detail).toMatch(/2 recorded disposals/);
  });
});

describe('Review Centre availability', () => {
  it('treats "nothing needs attention" as a real answer, not an unavailability', () => {
    const card = reviewAvailability(withSignals({ positionCount: 3, transactionCount: 20, reviewItemCount: 5, openReviewItemCount: 0 }));
    expect(card.status).toBe('AVAILABLE');
    expect(card.detail).toMatch(/nothing currently needs your attention/i);
  });

  it('is unavailable only when there is genuinely nothing to review', () => {
    expect(reviewAvailability(EMPTY).status).toBe('NOT_ENOUGH_DATA');
  });
});

describe('Engine status bridge', () => {
  it('never maps an engine failure onto AVAILABLE', () => {
    // The R4 rule this mirrors: a malformed/suppressed calculation may NEVER
    // surface as CALCULATED. The card vocabulary must not launder it either.
    expect(fromCalculationStatus('FAILED')).toBe('ERROR');
    expect(fromCalculationStatus('AMBIGUOUS')).toBe('ERROR');
    expect(fromCalculationStatus('INSUFFICIENT_HISTORY')).toBe('NOT_ENOUGH_DATA');
    expect(fromCalculationStatus('MISSING_REFERENCE_DATA')).toBe('REFERENCE_DATA_MISSING');
    expect(fromCalculationStatus('NOT_APPLICABLE')).toBe('NOT_APPLICABLE');
    expect(fromCalculationStatus('CALCULATED')).toBe('AVAILABLE');
    expect(fromCalculationStatus('STALE')).toBe('STALE');
  });

  it('treats only CALCULATED and STALE as showing a usable analysis', () => {
    expect(isAnalysisReachable('AVAILABLE')).toBe(true);
    expect(isAnalysisReachable('STALE')).toBe(true);
    for (const s of ['NOT_ENOUGH_DATA', 'REFERENCE_DATA_MISSING', 'NOT_APPLICABLE', 'NEEDS_RECONCILIATION', 'UNSUPPORTED', 'ERROR'] as const) {
      expect(isAnalysisReachable(s)).toBe(false);
    }
  });

  it('gives every status a plain-English label', () => {
    for (const [status, label] of Object.entries(AVAILABILITY_LABEL)) {
      expect(label.trim().length).toBeGreaterThan(0);
      // The enum name itself must never be what the user reads.
      expect(label).not.toBe(status);
    }
  });
});

describe('Next-step guidance stays workflow guidance, never financial advice', () => {
  const scenarios: OverviewSignals[] = [
    EMPTY,
    withSignals({ positionCount: 3, openReconciliationCaseCount: 2 }),
    withSignals({ positionCount: 3, certifiedPositionCount: 0 }),
    withSignals({ positionCount: 3, certifiedPositionCount: 3 }),
    withSignals({ positionCount: 3, certifiedPositionCount: 3, openReviewItemCount: 4 }),
    RICH,
  ];

  it('never emits a buy/sell/switch/allocation instruction', () => {
    // Spec section 51's forbidden list, verbatim in spirit.
    const forbidden = [/\byou should\b/i, /\bsell\b/i, /\bbuy\b/i, /\bswitch to\b/i, /increase your sip/i, /reduce (your )?exposure/i, /\brebalance\b/i];
    for (const s of scenarios) {
      for (const published of [0, 3]) {
        const step = nextStep(s, published);
        for (const pattern of forbidden) {
          expect(step.message, `"${step.message}" violates ${pattern}`).not.toMatch(pattern);
        }
        expect(step.href.startsWith('/')).toBe(true);
        expect(step.ctaLabel.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('sends a brand-new user to import a statement', () => {
    expect(nextStep(EMPTY, 0).code).toBe('IMPORT_FIRST_STATEMENT');
    expect(nextStep(EMPTY, 0).href).toBe('/investment-intelligence/data');
  });

  it('prioritises an open data issue over certification and publishing', () => {
    const step = nextStep(withSignals({ positionCount: 3, certifiedPositionCount: 0, openReconciliationCaseCount: 1 }), 0);
    expect(step.code).toBe('RESOLVE_DATA_ISSUE');
  });

  it('points a fully-prepared user at analysis rather than more data entry', () => {
    expect(nextStep(withSignals({ positionCount: 3, certifiedPositionCount: 3 }), 3).code).toBe('VIEW_ANALYSIS');
  });
});
