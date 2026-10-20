/**
 * Retirement contribution FLOW ledger (Document2 (4) F25 / F25b). A contribution is a flow (an amount paid in over time), never a balance.
 * These are the shared shapes; the rules live in runRate.ts (what counts, exactly once) and routing.ts (which destination a payslip line names).
 */
export const CONTRIBUTION_TYPES = ['employer', 'salary_sacrifice', 'personal', 'spouse', 'government'] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];

export const CONTRIBUTION_TYPE_LABEL: Record<ContributionType, string> = {
  employer: 'Employer contribution',
  salary_sacrifice: 'Salary sacrifice',
  personal: 'Personal contribution',
  spouse: 'Spouse contribution',
  government: 'Government co-contribution',
};

/**
 * The two columns the rest of the app already reads on retirement_accounts (Dashboard, Health Score, Twin, Forecast, SMSF reports).
 * Employer-side money never passes through take-home pay, so it is the genuinely additive bucket (LR-FI-3); everything else is the personal bucket.
 */
export type ContributionBucket = 'employer' | 'personal';
export const BUCKET_OF_TYPE: Record<ContributionType, ContributionBucket> = {
  employer: 'employer',
  salary_sacrifice: 'employer',
  personal: 'personal',
  spouse: 'personal',
  government: 'personal',
};

export const CONTRIBUTION_FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off'] as const;
export type ContributionFrequency = (typeof CONTRIBUTION_FREQUENCIES)[number];

export type ContributionStatus = 'active' | 'needs_destination' | 'superseded' | 'removed';
export type ContributionSource = 'manual' | 'payslip';
export type DestinationKind = 'retirement_account' | 'smsf';

/** A ledger row as the rules need it (camelCase; the service maps the snake_case table row). */
export interface LedgerRow {
  id: string;
  retirementAccountId: string | null;
  destinationKind: DestinationKind | null;
  memberId: string | null;
  type: ContributionType;
  amount: number;
  currency: string;
  frequency: ContributionFrequency | null;
  /** yyyy-mm-dd */
  contributionDate: string | null;
  sourceType: ContributionSource;
  payrollEventId: string | null;
  employerNormalised: string | null;
  status: ContributionStatus;
  /** ISO timestamp; breaks ties when two rows have the same effective date. */
  createdAt: string;
  /**
   * True for a row created from a figure the account already held in its own contribution columns (metadata.adopted_legacy).
   * It is a placeholder: any dated or newer record for the same flow replaces it.
   */
  isAdoptedLegacy?: boolean;
}
