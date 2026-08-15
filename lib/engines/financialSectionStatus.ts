// Phase 0C: canonical per-section review status. Replaces the ad hoc
// hasEngaged() heuristic and the narrow 3-flag notApplicable object that
// healthScore.ts and resilience.ts previously used to infer "confirmed
// zero debt" / "confirmed no insurance" purely from an absence of rows.
// This is a pure, DB-free module — the actual explicit confirmations are
// persisted by lib/services/financialSectionStatusData.ts (migration 0031,
// extended by 0032 for the 'reviewed_with_data' confirmation) and combined
// with row-presence here.
//
// Phase 0C.1: corrects a semantic gap the Phase 0C completion report left
// open — one data row was previously enough to mark a whole section
// 'reviewed_with_data'. That conflated two different facts: "the user has
// entered something" and "the user has finished reviewing this section."
// One salary row doesn't prove Income is fully reviewed any more than one
// rent row proves Expenses is. See effectiveSectionStatus below for the
// corrected state machine.

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

// The three states a user can explicitly persist:
//   'reviewed_zero'      — "I have none of this" (e.g. no liabilities)
//   'not_applicable'     — "this doesn't apply to me" (e.g. no retirement scheme)
//   'reviewed_with_data' — "I've added everything relevant to me" (positive-data
//                          sections: Income, Expenses, Assets, Investments,
//                          Retirement, and Liabilities/Insurance once rows exist)
// 'not_started' and 'in_progress' are never persisted — they're always
// derived from row presence, since that already answers them unambiguously
// (see effectiveSectionStatus below).
export type ExplicitSectionConfirmation = 'reviewed_zero' | 'not_applicable' | 'reviewed_with_data';

export interface SectionStatusInput {
  hasRows: boolean;
  explicitConfirmation: ExplicitSectionConfirmation | null;
}

// Combines "does real data exist" with "did the user explicitly confirm a
// review/zero/not-applicable state" into one of the 5 canonical statuses.
//
// Priority order, and why:
//   1. 'not_applicable' always wins, even over real rows — matches the
//      pre-0C behaviour investments/retirement/insurance already had
//      (migration 0029): a household that says "this doesn't apply to me"
//      stays excluded even if a stray custom row exists.
//   2. A 'reviewed_with_data' confirmation only holds while it's still
//      backed by real rows. If every row in the section was deleted after
//      the user confirmed it complete, the confirmation is stale — the
//      section reverts to 'not_started' rather than silently claiming a
//      reviewed, complete picture for data that no longer exists
//      (Phase 0C §17 "do not leave an accidental stale confirmed state").
//   3. Real rows beat a 'reviewed_zero' confirmation, but no longer jump
//      straight to 'reviewed_with_data' — new data superseding an old zero
//      answer means there's now something to review, so the section goes
//      to 'in_progress' until the user confirms it's complete again.
//   4. A standing 'reviewed_zero' confirmation with no rows is the explicit,
//      user-confirmed zero Phase 0B found missing, distinct from simply
//      never having visited the section.
//   5. Rows with no explicit confirmation at all are 'in_progress' — the
//      household has started, but hasn't told FHIP they're done. This is
//      the Phase 0C.1 correction: previously this case returned
//      'reviewed_with_data' directly, which meant one salary row was
//      enough to call Income "reviewed."
//   6. No rows and no confirmation is 'not_started' — never silently
//      treated as zero or as reviewed.
export function effectiveSectionStatus(input: SectionStatusInput): FinancialSectionStatus {
  if (input.explicitConfirmation === 'not_applicable') return 'not_applicable';

  if (input.explicitConfirmation === 'reviewed_with_data') {
    return input.hasRows ? 'reviewed_with_data' : 'not_started';
  }

  if (input.explicitConfirmation === 'reviewed_zero') {
    return input.hasRows ? 'in_progress' : 'reviewed_zero';
  }

  return input.hasRows ? 'in_progress' : 'not_started';
}

// A section counts as "reviewed" for eligibility/confidence purposes once
// it's in any of these three states — the household has either explicitly
// confirmed their data is complete, explicitly confirmed zero, or
// explicitly confirmed it doesn't apply to them. 'not_started' and
// 'in_progress' both mean "we don't actually know the full picture yet" —
// 'in_progress' specifically means data exists but hasn't been confirmed
// complete (Phase 0C.1).
export function isReviewed(status: FinancialSectionStatus): boolean {
  return status === 'reviewed_with_data' || status === 'reviewed_zero' || status === 'not_applicable';
}

// True once a section has any engagement at all (data entered, or any
// explicit confirmation) — the threshold used to leave "Not Yet Scored,"
// as distinct from isReviewed()'s stricter "fully resolved" threshold used
// for "Full." A section that's merely 'in_progress' clears this but not
// isReviewed() (Phase 0C.1 §21).
export function hasProgressed(status: FinancialSectionStatus): boolean {
  return status !== 'not_started';
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
