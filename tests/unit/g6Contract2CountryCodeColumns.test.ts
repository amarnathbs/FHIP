// G6 Contract 2 (docs/country-programme/g6-data-contracts.md) — new
// optional/nullable country_code field on income_sources/expense_items/
// insurance_policies (migration 0138). Additive-only: every existing
// payload with no country_code key at all must remain valid.
import { describe, it, expect } from 'vitest';
import { incomeSchema } from '@/lib/validation/income';
import { expenseSchema } from '@/lib/validation/expense';
import { insuranceSchema } from '@/lib/validation/insurance';

const BASE_INCOME = { source_name: 'Salary', amount: 5000, frequency: 'monthly', currency_code: 'AUD' };
const BASE_EXPENSE = { expense_name: 'Rent', amount: 2000, frequency: 'monthly', currency_code: 'AUD' };
const BASE_INSURANCE = { policy_name: 'Life cover', cover_amount: 500000, premium: 50, premium_frequency: 'monthly', currency_code: 'AUD' };

describe('G6 Contract 2 — country_code on income_sources/expense_items/insurance_policies', () => {
  it('income: backward compatible — a payload with no country_code key at all remains valid', () => {
    const parsed = incomeSchema.safeParse(BASE_INCOME);
    expect(parsed.success).toBe(true);
  });
  it('expense: backward compatible — a payload with no country_code key at all remains valid', () => {
    const parsed = expenseSchema.safeParse(BASE_EXPENSE);
    expect(parsed.success).toBe(true);
  });
  it('insurance: backward compatible — a payload with no country_code key at all remains valid', () => {
    const parsed = insuranceSchema.safeParse(BASE_INSURANCE);
    expect(parsed.success).toBe(true);
  });

  it('all three accept an explicit null country_code (matching the nullable DB column, a permanent valid state for pre-G6 rows)', () => {
    expect(incomeSchema.safeParse({ ...BASE_INCOME, country_code: null }).success).toBe(true);
    expect(expenseSchema.safeParse({ ...BASE_EXPENSE, country_code: null }).success).toBe(true);
    expect(insuranceSchema.safeParse({ ...BASE_INSURANCE, country_code: null }).success).toBe(true);
  });

  it('all three accept every authoritative country code, not just AU/IN (widened alongside G6 Contract 1)', () => {
    for (const code of ['AU', 'IN', 'GB', 'US', 'SG', 'AE']) {
      expect(incomeSchema.safeParse({ ...BASE_INCOME, country_code: code }).success).toBe(true);
      expect(expenseSchema.safeParse({ ...BASE_EXPENSE, country_code: code }).success).toBe(true);
      expect(insuranceSchema.safeParse({ ...BASE_INSURANCE, country_code: code }).success).toBe(true);
    }
  });

  it('all three reject an unrecognised country code, never silently accepting a forged value', () => {
    expect(incomeSchema.safeParse({ ...BASE_INCOME, country_code: 'ZZ' }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...BASE_EXPENSE, country_code: 'ZZ' }).success).toBe(false);
    expect(insuranceSchema.safeParse({ ...BASE_INSURANCE, country_code: 'ZZ' }).success).toBe(false);
  });
});
