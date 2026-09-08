// ---------------------------------------------------------------------------
// LR-6 (WP-07, NEG-06 "forecast contaminates household") — pure guard used by
// forecastData.ts's retirement-forecast branch.
//
// WHY THIS EXISTS: the household retirement forecast correctly sums EVERY
// active retirement_accounts row's current_balance (SMSF wealth genuinely
// belongs in retirement net worth — this is unchanged). Its contribution
// component summed employer_contribution/personal_contribution the same
// way, with NO filter at all. Discovery for this phase found that this
// happened to be harmless only because smsf_create_fund() has never written
// those two columns on a fund's account — an incidental NULL, not a
// structural guarantee. LR-6's own contribution-reconciliation view
// (lib/engines/smsf/smsfContributions.ts) is the first feature to read those
// columns on an SMSF-linked account, so this guard is added now, before any
// future feature could populate them and silently leak an SMSF operating
// flow into the household forecast.
//
// The correct discriminator is SET MEMBERSHIP in `smsf_funds.
// retirement_account_id` for this user's active funds — NOT the `owner`
// column (smsf_create_fund()'s p_owner is constrained to self/spouse/joint;
// a fund's own retirement_accounts row is never owner='smsf', see
// lib/engines/householdContext.ts's own header for the full explanation of
// why that column cannot be reused here).
// ---------------------------------------------------------------------------

export interface ContributionBearingAccount {
  id: string;
  employer_contribution?: number | null;
  personal_contribution?: number | null;
  contribution_frequency?: string | null;
}

/**
 * The accounts whose employer/personal contributions may count toward the
 * household retirement forecast's contribution component — every active
 * account EXCEPT one linked to an active SMSF fund. Never filters
 * current_balance; callers must keep summing that over every account
 * unchanged.
 */
export function accountsEligibleForHouseholdContributionForecast<T extends ContributionBearingAccount>(
  accounts: T[],
  smsfLinkedAccountIds: ReadonlySet<string>
): T[] {
  return accounts.filter((a) => !smsfLinkedAccountIds.has(a.id));
}
