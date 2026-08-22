// Phase 0C: canonical Financial Health Score eligibility + Financial Data
// Confidence. Single source of truth consumed by the Dashboard, /score, and
// Reports, so those surfaces can never disagree about whether a household's
// score is Not Yet Scored, Preliminary, or Full (Phase 0B UX-004/FD-03).
//
// Deliberately pure and DB-free — everything it needs is passed in, so it's
// unit-testable without a live Supabase connection and can't accidentally
// diverge from what each page actually has on hand.
import {
  isReviewed,
  SECTION_LABELS,
  type FinancialSection,
  type FinancialSectionStatus,
} from './financialSectionStatus';
import type { Treatment } from './healthScore';

export type HealthScoreState = 'not_yet_scored' | 'preliminary' | 'full';
export type ConfidenceTier = 'high' | 'medium' | 'low';

export interface HealthScoreEligibility {
  state: HealthScoreState;
  reviewedSections: number;
  totalRelevantSections: number;
  scoredComponents: number;
  totalRelevantComponents: number;
  // The one canonical, user-facing "how much do we know about this
  // household" percentage — based on which financial SECTIONS have been
  // reviewed (real data, confirmed zero, or confirmed not-applicable), not
  // on a raw count of database rows (Phase 0C §20).
  confidencePercent: number;
  confidenceTier: ConfidenceTier;
  missingSections: FinancialSection[];
  preliminaryReasons: string[];
  canDisplayNumericScore: boolean;
}

// The 7 sections the Financial Health Score actually draws on. Household
// affects age/dependants inputs but isn't itself a scored component, and
// Goals are a separate product area the score doesn't depend on — neither
// is included here, per the Phase 0C instruction not to force categories
// into score eligibility that the score doesn't actually use.
export const CORE_SCORE_SECTIONS: FinancialSection[] = [
  'income',
  'expenses',
  'assets',
  'liabilities',
  'investments',
  'retirement',
  'insurance',
];

// The four core sections that must be fully RESOLVED (isReviewed — not
// merely 'in_progress') before any numeric score is shown. Income +
// Expenses alone would let a purely cash-flow-driven number stand in for a
// "financial health" verdict, so both sides of the balance sheet (Assets
// AND Liabilities) are required too, not just one.
//
// Phase 0C.2 §8-9 correction: Phase 0C.1 used the looser *progressed*
// threshold here (hasProgressed — rows exist, even unconfirmed), which let
// a household with real data in all four sections but zero explicit
// completion confirmations reach Preliminary at 0% Financial Data
// Confidence — a numeric score with no confirmed basis. That's now
// tightened: these four must be isReviewed (reviewed_with_data, or
// reviewed_zero for Liabilities specifically — Income/Expenses/Assets have
// no zero/not-applicable path in the UI, so isReviewed() only admits
// reviewed_with_data for those three; no per-section special-casing is
// needed here as a result). Investments/Retirement/Insurance remain
// unrequired for Preliminary — see CORE_SCORE_SECTIONS vs this list.
export const MINIMUM_FOR_PRELIMINARY: FinancialSection[] = ['income', 'expenses', 'assets', 'liabilities'];

export function confidenceTierFor(confidencePercent: number): ConfidenceTier {
  if (confidencePercent >= 80) return 'high';
  if (confidencePercent >= 50) return 'medium';
  return 'low';
}

export function computeHealthScoreEligibility(
  sectionStatus: Record<FinancialSection, FinancialSectionStatus>,
  components: { treatment: Treatment }[]
): HealthScoreEligibility {
  const reviewedSections = CORE_SCORE_SECTIONS.filter((s) => isReviewed(sectionStatus[s]));
  const missingSections = CORE_SCORE_SECTIONS.filter((s) => !isReviewed(sectionStatus[s]));

  const totalRelevantComponents = components.filter((c) => c.treatment !== 'not_applicable').length;
  const scoredComponents = components.filter((c) => c.treatment === 'scored').length;

  const confidencePercent =
    CORE_SCORE_SECTIONS.length > 0 ? Math.round((reviewedSections.length / CORE_SCORE_SECTIONS.length) * 100) : 100;
  const confidenceTier = confidenceTierFor(confidencePercent);

  // Phase 0C.2: Preliminary now requires the four minimum sections to be
  // fully RESOLVED (isReviewed), not merely progressed — see
  // MINIMUM_FOR_PRELIMINARY's comment. A section that's merely
  // 'in_progress' blocks both Preliminary and Full now; only
  // Investments/Retirement/Insurance may remain unresolved for Preliminary.
  const meetsMinimum = MINIMUM_FOR_PRELIMINARY.every((s) => isReviewed(sectionStatus[s]));
  const isComplete = missingSections.length === 0;

  const state: HealthScoreState = isComplete ? 'full' : meetsMinimum ? 'preliminary' : 'not_yet_scored';

  return {
    state,
    reviewedSections: reviewedSections.length,
    totalRelevantSections: CORE_SCORE_SECTIONS.length,
    scoredComponents,
    totalRelevantComponents,
    confidencePercent,
    confidenceTier,
    missingSections,
    preliminaryReasons: missingSections.map((s) => `${SECTION_LABELS[s]} not yet reviewed`),
    canDisplayNumericScore: state !== 'not_yet_scored',
  };
}
