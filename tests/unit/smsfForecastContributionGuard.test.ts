/**
 * LR-6 (WP-07, NEG-06 "forecast contaminates household") — the household
 * retirement forecast's contribution component must never include an
 * SMSF-fund-linked account's employer/personal contribution, even though its
 * current_balance correctly stays in the household forecast's opening
 * balance (SMSF wealth belongs in retirement net worth).
 */
import { describe, expect, it } from 'vitest';
import { accountsEligibleForHouseholdContributionForecast } from '@/lib/engines/forecast/smsfContributionGuard';

describe('accountsEligibleForHouseholdContributionForecast', () => {
  const householdAccount = { id: 'acct-household', employer_contribution: 500, personal_contribution: 200, contribution_frequency: 'monthly' };
  const smsfLinkedAccount = { id: 'acct-smsf', employer_contribution: 9000, personal_contribution: 3000, contribution_frequency: 'monthly' };

  it('NEG-06: excludes an account linked to an active SMSF fund from the eligible set', () => {
    const eligible = accountsEligibleForHouseholdContributionForecast(
      [householdAccount, smsfLinkedAccount],
      new Set(['acct-smsf'])
    );
    expect(eligible).toEqual([householdAccount]);
    expect(eligible.find((a) => a.id === 'acct-smsf')).toBeUndefined();
  });

  it('never excludes a genuine household account just because some other account is SMSF-linked', () => {
    const eligible = accountsEligibleForHouseholdContributionForecast([householdAccount], new Set(['acct-smsf']));
    expect(eligible).toEqual([householdAccount]);
  });

  it('excludes nothing when the household holds no SMSF fund at all (the common case, zero behaviour change)', () => {
    const eligible = accountsEligibleForHouseholdContributionForecast([householdAccount], new Set());
    expect(eligible).toEqual([householdAccount]);
  });
});
