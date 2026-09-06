// G5B Phase 2 closure — reload-edit 422 regression coverage.
//
// Root cause (see the matching comment on each schema in lib/validation/):
// income_sources/expense_items/insurance_policies each have several
// genuinely nullable optional columns (no NOT NULL, no default — migrations
// 0004/0008). GET returns an untouched row's value for these as JSON null;
// the shared grid save path (components/grid/FinancialDataGrid.tsx's
// runSave) resends every configured field on every save, including fields
// it never touched. Before this fix these fields were `.optional()` only
// (undefined-only), so a `.partial().safeParse()` (PATCH) or full
// `.safeParse()` (POST/upsert) rejected the resent `null` with a 422 —
// reproducible only after a real reload rehydrated the row with actual
// nulls instead of merely-absent keys.
//
// These tests assert: (1) the exact reload-edit round trip now validates
// (both the create/upsert full schema and the PATCH partial schema); (2) a
// genuinely invalid non-null value is still rejected — the fix is additive
// nullability, not loosened validation; (3) required fields remain required
// and reject null exactly as they did before.
import { describe, it, expect } from 'vitest';
import { incomeSchema } from '@/lib/validation/income';
import { expenseSchema } from '@/lib/validation/expense';
import { insuranceSchema } from '@/lib/validation/insurance';

describe('reload-edit: income schema tolerates the null shape GET actually returns', () => {
  const untouchedRowFromReload = {
    source_name: 'Salary',
    income_type: 'salary' as const,
    amount: 5000,
    net_amount: null,
    frequency: 'monthly' as const,
    currency_code: 'AUD' as const,
    owner: 'self' as const,
    is_taxable: true,
    employer_name: null,
    master_item_key: null,
    notes: null,
  };

  it('full create/upsert schema accepts a resent row whose untouched optional fields are null', () => {
    const parsed = incomeSchema.safeParse(untouchedRowFromReload);
    expect(parsed.success).toBe(true);
  });

  it('PATCH partial schema accepts an edit that resends untouched null fields alongside one real change', () => {
    const parsed = incomeSchema.partial().safeParse({ ...untouchedRowFromReload, amount: 5500 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBe(5500);
  });

  it('still rejects a genuinely invalid non-null value (negative net_amount)', () => {
    const parsed = incomeSchema.safeParse({ ...untouchedRowFromReload, net_amount: -1 });
    expect(parsed.success).toBe(false);
  });

  it('still rejects null for a required field (amount) — nullability was added only to genuinely optional columns', () => {
    const parsed = incomeSchema.safeParse({ ...untouchedRowFromReload, amount: null });
    expect(parsed.success).toBe(false);
  });

  it('an explicit null patch against an already-null column round-trips as null, not a coerced default', () => {
    const parsed = incomeSchema.partial().safeParse({ employer_name: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.employer_name).toBeNull();
  });
});

describe('reload-edit: expense schema tolerates the null shape GET actually returns', () => {
  const untouchedRowFromReload = {
    expense_name: 'Rent',
    expense_category: 'housing' as const,
    amount: 2000,
    frequency: 'monthly' as const,
    currency_code: 'AUD' as const,
    owner: 'self' as const,
    is_essential: true,
    master_item_key: null,
    notes: null,
  };

  it('full create/upsert schema accepts a resent row whose untouched optional fields are null', () => {
    expect(expenseSchema.safeParse(untouchedRowFromReload).success).toBe(true);
  });

  it('PATCH partial schema accepts an edit that resends untouched null fields alongside one real change', () => {
    const parsed = expenseSchema.partial().safeParse({ ...untouchedRowFromReload, amount: 2100 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBe(2100);
  });

  it('still rejects a genuinely invalid non-null value (negative amount)', () => {
    expect(expenseSchema.safeParse({ ...untouchedRowFromReload, amount: -1 }).success).toBe(false);
  });

  it('still rejects null for a required field (expense_name)', () => {
    expect(expenseSchema.safeParse({ ...untouchedRowFromReload, expense_name: null }).success).toBe(false);
  });
});

describe('reload-edit: insurance schema tolerates the null shape GET actually returns', () => {
  const untouchedRowFromReload = {
    policy_name: 'Life cover',
    cover_type: 'life' as const,
    cover_amount: 500000,
    premium: 80,
    premium_frequency: 'monthly' as const,
    currency_code: 'AUD' as const,
    renewal_date: null,
    waiting_period_days: null,
    benefit_period: null,
    provider: null,
    owner: 'self' as const,
    master_item_key: null,
    notes: null,
  };

  it('full create/upsert schema accepts a resent row whose untouched optional fields are null', () => {
    expect(insuranceSchema.safeParse(untouchedRowFromReload).success).toBe(true);
  });

  it('PATCH partial schema accepts an edit that resends untouched null fields alongside one real change', () => {
    const parsed = insuranceSchema.partial().safeParse({ ...untouchedRowFromReload, premium: 95 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.premium).toBe(95);
  });

  it('still rejects a genuinely invalid non-null value (negative waiting_period_days)', () => {
    expect(insuranceSchema.safeParse({ ...untouchedRowFromReload, waiting_period_days: -5 }).success).toBe(false);
  });

  it('still rejects a malformed non-null renewal_date', () => {
    expect(insuranceSchema.safeParse({ ...untouchedRowFromReload, renewal_date: 'not-a-date' }).success).toBe(false);
  });

  it('still rejects null for a required field (premium)', () => {
    expect(insuranceSchema.safeParse({ ...untouchedRowFromReload, premium: null }).success).toBe(false);
  });
});
