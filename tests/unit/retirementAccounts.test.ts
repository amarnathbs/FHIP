import { describe, it, expect } from 'vitest';
import {
  computeRetirementAccountCurrentValue,
  sumRetirementContributionsMonthly,
  isSpouseContribution,
  type RetirementContribution,
} from '@/lib/engines/retirementAccounts';

// Chunk 3a items 4-5 (Spec 2 §29-36, Spec 1 §21-22): retirement account-vs-
// contribution separation and spouse contribution as a relationship,
// exercised against Spec 2's exact worked example.

describe('computeRetirementAccountCurrentValue — Spec 2 worked example', () => {
  it('reports current_balance = 200,000 as the current value, never balance + contribution', () => {
    const account = { current_balance: 200000 };
    expect(computeRetirementAccountCurrentValue(account)).toBe(200000);
  });

  it('a 1,000/month employer contribution does not change the account current value', () => {
    const account = { current_balance: 200000 };
    const contributions: RetirementContribution[] = [
      { contribution_type: 'employer_contributions', amount: 1000, frequency: 'monthly', contributor: 'self' },
    ];
    expect(sumRetirementContributionsMonthly(contributions)).toBe(1000);
    const currentValue = computeRetirementAccountCurrentValue(account);
    expect(currentValue).toBe(200000);
    expect(currentValue).not.toBe(201000);
  });
});

describe('sumRetirementContributionsMonthly', () => {
  it('normalises non-monthly frequencies before summing', () => {
    const contributions: RetirementContribution[] = [
      { contribution_type: 'salary_sacrifice', amount: 6000, frequency: 'annually', contributor: 'self' }, // 500/mo
      { contribution_type: 'personal_concessional', amount: 100, frequency: 'weekly', contributor: 'self' }, // ~433.33/mo
    ];
    expect(sumRetirementContributionsMonthly(contributions)).toBeCloseTo(500 + (100 * 52) / 12, 5);
  });

  it('returns 0 for an empty contribution list', () => {
    expect(sumRetirementContributionsMonthly([])).toBe(0);
  });
});

describe('spouse contribution as a relationship, not a standalone asset class (Spec 1 §21, Spec 2 §36)', () => {
  it('identifies a spouse contribution purely via contributor="spouse" on a normal contribution row', () => {
    const spouseContribution: RetirementContribution = {
      contribution_type: 'spouse_contribution',
      contributor: 'spouse',
      amount: 500,
      frequency: 'monthly',
      retirement_account_id: 'recipient-account-id', // the RECIPIENT member's account
    };
    expect(isSpouseContribution(spouseContribution)).toBe(true);
    expect(sumRetirementContributionsMonthly([spouseContribution])).toBe(500);
  });

  it('a self contribution is not mistaken for a spouse contribution', () => {
    const selfContribution: RetirementContribution = {
      contribution_type: 'personal_concessional',
      contributor: 'self',
      amount: 500,
      frequency: 'monthly',
    };
    expect(isSpouseContribution(selfContribution)).toBe(false);
  });
});
