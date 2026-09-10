import { describe, it, expect } from 'vitest';
import { applySmsfPropertyLoanLinkOverride, SMSF_OWNER } from '@/lib/engines/householdContext';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';

// ---------------------------------------------------------------------------
// LR-12R reconciliation (2026-09-11) — PO-directed check found that a
// liability structurally linked to an SMSF fund via
// property_liability_links.link_type='smsf_property_loan', but NOT
// separately owner-tagged 'smsf', was fully counted in personal household
// DTI/DSR. Live oracle: household income $10,000/mo, personal debt service
// $1,000/mo, SMSF-linked-but-untagged loan repayment $2,000/mo — expected
// DSR 10%, observed 30% before this fix (exact reproduction via a real
// live-DEV /api/dashboard/summary call, not just this unit test).
// ---------------------------------------------------------------------------

describe('applySmsfPropertyLoanLinkOverride — pure helper', () => {
  const EMPTY_SET = new Set<string>();

  it('is a no-op (same array reference) when no liability is SMSF-linked', () => {
    const liabilities = [{ id: 'a', owner: 'self' }];
    expect(applySmsfPropertyLoanLinkOverride(liabilities, EMPTY_SET)).toBe(liabilities);
  });

  it('overrides only the linked liability, leaving its own stored owner value untouched in the input', () => {
    const personal = { id: 'personal-1', owner: 'self' };
    const smsfLinked = { id: 'smsf-1', owner: 'self' }; // deliberately NOT owner='smsf'
    const result = applySmsfPropertyLoanLinkOverride([personal, smsfLinked], new Set(['smsf-1']));
    expect(result[0]).toBe(personal); // untouched row, same reference
    expect(result[0].owner).toBe('self');
    expect(result[1]).not.toBe(smsfLinked); // a new shallow copy
    expect(result[1].owner).toBe(SMSF_OWNER);
    expect(smsfLinked.owner).toBe('self'); // the ORIGINAL object is never mutated
  });

  it('leaves an already owner=smsf-tagged row unchanged in effect (idempotent)', () => {
    const alreadyTagged = { id: 'smsf-1', owner: SMSF_OWNER };
    const result = applySmsfPropertyLoanLinkOverride([alreadyTagged], new Set(['smsf-1']));
    expect(result[0].owner).toBe(SMSF_OWNER);
  });

  it('ignores a linked id that does not match any liability in the array', () => {
    const liabilities = [{ id: 'a', owner: 'self' }];
    const result = applySmsfPropertyLoanLinkOverride(liabilities, new Set(['does-not-exist']));
    expect(result[0].owner).toBe('self');
  });
});

describe('LR-12R live oracle, reproduced as a pure computeDashboard() assertion', () => {
  const EMPTY: DashboardInput = {
    income: [],
    expenses: [],
    assets: [],
    liabilities: [],
    investments: [],
    retirement: [],
    insurance: [],
    goals: [],
    snapshots: [],
  };

  const SALARY = {
    source_name: 'Salary',
    amount: 10000,
    net_amount: 10000,
    frequency: 'monthly' as const,
    master_item_key: 'salary_wages',
    owner: 'self',
  };

  const PERSONAL_LOAN = {
    id: 'personal-loan',
    balance: 20000,
    interest_rate: 6,
    monthly_repayment: 1000,
    debt_type: 'personal_loan',
    master_item_key: 'personal_loan',
    currency_code: 'AUD',
    owner: 'self',
  };

  const SMSF_LINKED_LOAN_UNTAGGED = {
    id: 'smsf-property-loan',
    balance: 400000,
    interest_rate: 6,
    monthly_repayment: 2000,
    debt_type: 'mortgage',
    master_item_key: 'smsf_property_loan',
    currency_code: 'AUD',
    owner: 'self', // deliberately NOT 'smsf' — the exact PO test scenario
  };

  it('BEFORE the fix (owner left as-is): DSR is 30%, not 10% — the confirmed defect', () => {
    const d = computeDashboard(
      { ...EMPTY, income: [SALARY], liabilities: [PERSONAL_LOAN, SMSF_LINKED_LOAN_UNTAGGED] },
      'AUD'
    );
    expect(d.debtServiceRatio).toBeCloseTo(0.3, 9); // 3,000 / 10,000 — the defect, reproduced
  });

  it('AFTER the fix (applySmsfPropertyLoanLinkOverride applied, as dashboardData.ts now does): DSR is exactly 10%', () => {
    const linkedIds = new Set(['smsf-property-loan']);
    const liabilitiesForHouseholdContext = applySmsfPropertyLoanLinkOverride(
      [PERSONAL_LOAN, SMSF_LINKED_LOAN_UNTAGGED],
      linkedIds
    );
    const d = computeDashboard({ ...EMPTY, income: [SALARY], liabilities: liabilitiesForHouseholdContext }, 'AUD');
    expect(d.debtServiceRatio).toBeCloseTo(0.1, 9); // exactly matches the PO's expected oracle value
    expect(d.debtMonthlyRepayments).toBe(1000);
    expect(d.householdLiabilityBalance).toBe(20000); // DTI basis also correctly excludes the SMSF-linked balance
    // Net Worth / total-liabilities stays whole — LR-FI-1 §28's own invariant, unaffected by this fix.
    expect(d.totalLiabilities).toBe(420000);
  });
});
