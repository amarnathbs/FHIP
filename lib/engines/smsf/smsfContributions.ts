// ---------------------------------------------------------------------------
// LR-6 WP-06 — SMSF contribution reconciliation.
//
// Reuses the existing employer_contribution/personal_contribution/
// contribution_frequency columns already on retirement_accounts (added by
// migration 0004, populated generically for any retirement account, not
// SMSF-specific) rather than adding new columns — "prefer reuse of an
// existing certified service" per this phase's own instruction, and
// consistent with "if two modules appear to store the same economic amount,
// stop and reconcile" (there is exactly one contribution-amount pair on the
// account; this module only reads it, on the fund's own linked account).
//
// DISCLOSED LIMITATION (real, not silently hidden): the data model has no
// spouse/rollover contribution-source distinction — only a generic
// employer/personal split. smsf_create_fund() never even writes these two
// columns today (confirmed: no employer_contribution/personal_contribution
// parameter anywhere in that RPC), so for a newly-created SMSF fund this
// reads 0/0 until a user or a future feature populates them directly on the
// fund's retirement_accounts row via the existing generic Retirement grid
// edit path (masterItemKey excludes 'smsf' from that grid today — see LR-5's
// own disclosed gap — so populating them currently requires a direct API/DB
// path, not a wired UI control; this phase reads whatever value is present,
// it does not add a new way to set it).
// ---------------------------------------------------------------------------

import { toMonthly, type Frequency } from '../money';

export interface SmsfContributionSource {
  employer_contribution: number | null;
  personal_contribution: number | null;
  contribution_frequency: Frequency | null;
}

export interface SmsfContributionSummary {
  employerContributionMonthly: number;
  personalContributionMonthly: number;
  totalContributionMonthly: number;
  /** Always true — see module header; not a defect, a disclosed data-model limit. */
  spouseAndRolloverNotModelled: true;
}

export function computeSmsfContributions(account: SmsfContributionSource): SmsfContributionSummary {
  const freq = account.contribution_frequency ?? 'monthly';
  const employerContributionMonthly = toMonthly(account.employer_contribution ?? 0, freq);
  const personalContributionMonthly = toMonthly(account.personal_contribution ?? 0, freq);
  return {
    employerContributionMonthly,
    personalContributionMonthly,
    totalContributionMonthly: employerContributionMonthly + personalContributionMonthly,
    spouseAndRolloverNotModelled: true,
  };
}
