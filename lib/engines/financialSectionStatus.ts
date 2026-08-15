// Phase 0C: canonical per-section review status. Replaces the ad hoc
// hasEngaged() heuristic and the narrow 3-flag notApplicable object that
// healthScore.ts and resilience.ts previously used to infer "confirmed
// zero debt" / "confirmed no insurance" purely from an absence of rows.
// This is a pure, DB-free module — the actual explicit confirmations are
// persisted by lib/services/financialSectionStatusData.ts (migration 0031)
// and combined with row-presence here.

export type FinancialSection =
  | 'household'
  | 'income'
  | 'expenses'
  | 'assets'
  | 'liabilities'
  | 'investments'
  | 'retirement'
  | 'insurance';

export type FinancialSectionStatus =
  | 'not_started'
  | 'in_progress'
  | 'reviewed_with_data'
  | 'reviewed_zero'
  | 'not_applicable';

// The only two states a user can explicitly set — 'reviewed_with_data' and
// 'not_started'/'in_progress' are always derived from whether real rows
// exist, never persisted, since row presence already answers those
// unambiguously (see effectiveSectionStatus below).
export type ExplicitSectionConfirmation = 'reviewed_zero' | 'not_applicable';

export interface SectionStatusInput {
  hasRows: boolean;
  explicitConfirmation: ExplicitSectionConfirmation | null;
}

// Combines "does real data exist" with "did the user explicitly confirm a
// zero/not-applicable state" into one of the 5 canonical statuses.
//
// Priority order, and why:
//   1. 'not_applicable' always wins, even over real rows — matches the
//      pre-0C behaviour investments/retirement/insurance already had
//      (migration 0029): a household that says "this doesn't apply to me"
//      stays excluded even if a stray custom row exists.
//   2. Real rows beat a 'reviewed_zero' confirmation — data is a stronger,
//      more current signal than an older "I have none of this" answer, so
//      if rows now exist we trust them rather than presenting a
//      contradiction (score says "no debt" while a mortgage row exists).
//   3. A standing 'reviewed_zero' confirmation with no rows is exactly the
//      state Phase 0B found missing: an explicit, user-confirmed zero,
//      distinct from simply never having visited the section.
//   4. No rows and no confirmation is 'not_started' — never silently
//      treated as zero.
export function effectiveSectionStatus(input: SectionStatusInput): FinancialSectionStatus {
  if (input.explicitConfirmation === 'not_applicable') return 'not_applicable';
  if (input.hasRows) return 'reviewed_with_data';
  if (input.explicitConfirmation === 'reviewed_zero') return 'reviewed_zero';
  return 'not_started';
}

// A section counts as "reviewed" for eligibility/confidence purposes once
// it's in any of these three states — the household has either supplied
// real data, explicitly confirmed zero, or explicitly confirmed it doesn't
// apply to them. 'not_started' and 'in_progress' are the only two states
// that mean "we don't actually know yet."
export function isReviewed(status: FinancialSectionStatus): boolean {
  return status === 'reviewed_with_data' || status === 'reviewed_zero' || status === 'not_applicable';
}

export const ALL_SECTIONS: FinancialSection[] = [
  'household',
  'income',
  'expenses',
  'assets',
  'liabilities',
  'investments',
  'retirement',
  'insurance',
];

export const SECTION_LABELS: Record<FinancialSection, string> = {
  household: 'Household',
  income: 'Income',
  expenses: 'Expenses',
  assets: 'Assets',
  liabilities: 'Liabilities',
  investments: 'Investments',
  retirement: 'Retirement',
  insurance: 'Insurance',
};
