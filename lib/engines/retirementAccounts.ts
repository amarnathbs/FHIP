// Chunk 3a items 4-5 (Spec 2 §29-36): retirement account-vs-contribution
// separation, and spouse contribution modeled as a relationship rather than
// a standalone holding. Pure functions — no DB access.
//
// dashboard.ts already gets the *existing* per-account employer_contribution/
// personal_contribution fields right (lib/engines/dashboard.ts:540 sums only
// current_balance into totalRetirement; the two contribution fields feed a
// separate retirementContributionRate metric, never added to the balance).
// This module gives the NEW retirement_contributions table (migration 0036)
// the same guarantee for the Class-F catalogue items — see the discovery
// doc's Class-F finding: today, ticking e.g. "Employer Contributions" in the
// Retirement grid creates an ordinary retirement_accounts row like any other,
// which DOES get summed into totalRetirement by current_balance, because
// dashboard.ts has no way to know that row represents a contribution flow
// rather than a real account. That is the live defect this new schema is
// designed to let 3b/3c actually fix by moving those catalogue rows off the
// flat grid and onto retirement_contributions instead — this sub-chunk adds
// the schema and the calculation contract, not the migration/rewire itself.
import { toMonthly, type Frequency } from './money';

export interface RetirementAccountBalance {
  current_balance: number;
}

/**
 * The current retirement asset value for one account is its own balance,
 * full stop — contributions (employer, salary sacrifice, personal, spouse,
 * etc.) are future-flow inputs for Forecasting, never added here. Matches
 * Spec 2's exact worked example: current_balance = 200,000 plus a
 * 1,000/month employer contribution must report 200,000, never 201,000.
 */
export function computeRetirementAccountCurrentValue(account: RetirementAccountBalance): number {
  return account.current_balance;
}

export type RetirementContributionType =
  | 'employer_contributions'
  | 'salary_sacrifice'
  | 'personal_concessional'
  | 'non_concessional'
  | 'government_co_contribution'
  | 'spouse_contribution';

export type RetirementContributor = 'self' | 'spouse';

export interface RetirementContribution {
  contribution_type: RetirementContributionType;
  amount: number;
  frequency: Frequency;
  contributor: RetirementContributor;
  retirement_account_id?: string;
}

/**
 * Total monthly contribution flow across a set of contribution rows — a
 * separate figure from account current value, never folded into it. Useful
 * for whatever eventually replaces dashboard.ts's
 * retirementEmployerMonthlyContribution/retirementPersonalMonthlyContribution
 * once the Class-F catalogue rows are migrated onto this table (3b/3c).
 */
export function sumRetirementContributionsMonthly(contributions: RetirementContribution[]): number {
  return contributions.reduce((sum, c) => sum + toMonthly(c.amount, c.frequency), 0);
}

/**
 * A spouse contribution (Spec 1 §21, Spec 2 §36) is identified purely by
 * contributor = 'spouse' on a normal retirement_contributions row targeting
 * the RECIPIENT member's account — not by any separate catalogue item or
 * table. This helper exists so callers/tests can assert that relationship
 * directly rather than relying on string-matching a contribution_type.
 */
export function isSpouseContribution(contribution: RetirementContribution): boolean {
  return contribution.contributor === 'spouse';
}
