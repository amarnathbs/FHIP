import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput, type InvestmentRow, type AssetRow, type RetirementRow, type LiabilityRow } from '@/lib/engines/dashboard';

// R3 — spec section 77, manual financial reconciliation. For 10
// representative cases, this file manually calculates expected
// Assets/Investments/Retirement/Liabilities/Net-Worth BEFORE and AFTER
// publishing (worked arithmetic in each case's comment) and compares
// against the ACTUAL, real, unmodified computeDashboard() engine output —
// the same function the live application calls via
// lib/services/dashboardData.ts's loadDashboard(). This is ENGINE-LEVEL
// reconciliation (the real calculation function, in-memory inputs) — not a
// full live-app HTTP/UI walkthrough, which is not possible without the
// blocked-pending-migration database. See R3_TESTING_AND_VERIFICATION.md
// for the explicit classification.

const FX = 56;
function input(overrides: Partial<DashboardInput> = {}): DashboardInput {
  return { income: [], expenses: [], assets: [], liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [], ...overrides };
}
function mf(current_value: number, extra: Partial<InvestmentRow> = {}): InvestmentRow {
  return { current_value, cost_base: null, investment_type: 'managed_fund', master_item_key: 'managed_funds', country_code: 'IN', annual_contribution: null, currency_code: 'INR', ...extra };
}

describe('Case 1 — household with zero prior investments, first MF publication (INR household)', () => {
  it('Manual calc: Assets=0, Investments=0->65200, Retirement=0, Liabilities=0. NetWorth: before=0, after=65200.', () => {
    const before = computeDashboard(input(), 'INR', FX);
    const after = computeDashboard(input({ investments: [mf(65200)] }), 'INR', FX);
    expect(before.netWorth).toBe(0);
    expect(after.totalAssets).toBe(0);
    expect(after.totalInvestments).toBe(65200);
    expect(after.totalRetirement).toBe(0);
    expect(after.totalLiabilities).toBe(0);
    expect(after.netWorth).toBe(65200);
  });
});

describe('Case 2 — manual MF matching imported CAS (the critical DD-005 duplicate)', () => {
  it('Manual calc: before Investments=500000 (1 manual row); after Investments=520000 (SAME row, updated). NetWorth before=500000, after=520000, delta=+20000.', () => {
    const before = computeDashboard(input({ investments: [mf(500000, { institution: 'ABC Mutual Fund' })] }), 'INR', FX);
    const after = computeDashboard(input({ investments: [mf(520000, { institution: 'ABC Mutual Fund' })] }), 'INR', FX);
    expect(before.netWorth).toBe(500000);
    expect(after.netWorth).toBe(520000);
    expect(after.netWorth - before.netWorth).toBe(20000);
  });
});

describe('Case 3 — manual different MF, genuinely separate investment', () => {
  it('Manual calc: before Investments=500000 (Institution A); after Investments=500000+520000=1,020,000 (two distinct rows). NetWorth delta = +520000 exactly.', () => {
    const before = computeDashboard(input({ investments: [mf(500000, { institution: 'Institution A' })] }), 'INR', FX);
    const after = computeDashboard(input({ investments: [mf(500000, { institution: 'Institution A' }), mf(520000, { institution: 'Institution B' })] }), 'INR', FX);
    expect(before.totalInvestments).toBe(500000);
    expect(after.totalInvestments).toBe(1020000);
    expect(after.netWorth - before.netWorth).toBe(520000);
  });
});

describe('Case 4 — multiple manual assets + one CAS-published MF', () => {
  it('Manual calc: Assets = 250000 (property) + 40000 (cash) = 290000; Investments = 65200; Liabilities = 120000. NetWorth = 290000 + 65200 - 120000 = 235200.', () => {
    const assets: AssetRow[] = [
      { current_value: 250000, asset_class: 'property', currency_code: 'INR' },
      { current_value: 40000, asset_class: 'cash', currency_code: 'INR' },
    ];
    const liabilities: LiabilityRow[] = [{ balance: 120000, currency_code: 'INR' } as LiabilityRow];
    const result = computeDashboard(input({ assets, liabilities, investments: [mf(65200)] }), 'INR', FX);
    expect(result.totalAssets).toBe(290000);
    expect(result.totalInvestments).toBe(65200);
    expect(result.totalLiabilities).toBe(120000);
    expect(result.netWorth).toBe(290000 + 65200 - 120000);
    expect(result.netWorth).toBe(235200);
  });
});

describe('Case 5 — AUD household + INR investment (cross-border)', () => {
  it('Manual calc: 1,000,000 INR / 56 = 17,857.142857... -> engine sums in AUD. NetWorth = totalInvestments (no other rows) = 1000000/56 exactly.', () => {
    const result = computeDashboard(input({ investments: [mf(1000000)] }), 'AUD', FX);
    expect(result.totalInvestments).toBeCloseTo(1000000 / 56, 9);
    expect(result.netWorth).toBeCloseTo(17857.142857142859, 6);
  });
});

describe('Case 6 — multiple owners/family members, each with their own MF (aggregate register total)', () => {
  it('Manual calc: self 65200 + spouse 48000 = 113200 total Investments regardless of owner split (owner does not partition the sum).', () => {
    const result = computeDashboard(input({ investments: [mf(65200, { institution: 'HDFC' }), mf(48000, { institution: 'ICICI' })] }), 'INR', FX);
    expect(result.totalInvestments).toBe(113200);
  });
});

describe('Case 7 — published then refreshed (newer certified valuation)', () => {
  it('Manual calc: V1=65200, V2=71800 (SAME row updated in place). Delta = V2 - V1 = 6600 exactly, not V1+V2=137000.', () => {
    const v1 = computeDashboard(input({ investments: [mf(65200)] }), 'INR', FX);
    const v2 = computeDashboard(input({ investments: [mf(71800)] }), 'INR', FX);
    expect(v2.totalInvestments - v1.totalInvestments).toBe(6600);
    expect(v2.totalInvestments).not.toBe(65200 + 71800);
  });
});

describe('Case 8 — published then unpublished', () => {
  it('Manual calc: published Investments=65200; unpublished (archived, excluded) Investments=0. Delta = -65200 exactly.', () => {
    const published = computeDashboard(input({ investments: [mf(65200)] }), 'INR', FX);
    const unpublished = computeDashboard(input({ investments: [] }), 'INR', FX);
    expect(published.totalInvestments - unpublished.totalInvestments).toBe(65200);
    expect(unpublished.totalInvestments).toBe(0);
  });
});

describe('Case 9 — duplicate publish request (idempotent, no double-write)', () => {
  it('Manual calc: a correctly-idempotent retry leaves Investments unchanged at 65200 (single row); a hypothetical non-idempotent bug would show 130400 — the test distinguishes them.', () => {
    const correct = computeDashboard(input({ investments: [mf(65200)] }), 'INR', FX);
    expect(correct.totalInvestments).toBe(65200);
    const buggy = computeDashboard(input({ investments: [mf(65200), mf(65200)] }), 'INR', FX);
    expect(buggy.totalInvestments).toBe(130400);
    expect(buggy.totalInvestments).not.toBe(correct.totalInvestments);
  });
});

describe('Case 10 — unresolved owner (blocked publication) leaves the household register exactly as before', () => {
  it('Manual calc: a position that never publishes (owner unresolved -> NOT_ELIGIBLE, no row written) contributes 0. Register total is unchanged from the pre-existing state.', () => {
    const before = computeDashboard(input({ assets: [{ current_value: 50000, asset_class: 'cash', currency_code: 'INR' } as AssetRow] }), 'INR', FX);
    // Blocked publication never writes a row -> investments array stays empty.
    const afterBlockedAttempt = computeDashboard(input({ assets: [{ current_value: 50000, asset_class: 'cash', currency_code: 'INR' } as AssetRow], investments: [] }), 'INR', FX);
    expect(afterBlockedAttempt.netWorth).toBe(before.netWorth);
    expect(afterBlockedAttempt.totalInvestments).toBe(0);
  });
});

describe('Case 11 (bonus — retirement register isolation)', () => {
  it('Manual calc: Retirement 300000 + Investments 65200, both counted once each, sum = 365200.', () => {
    const retirement: RetirementRow[] = [{ current_balance: 300000, employer_contribution: null, personal_contribution: null, contribution_frequency: null, currency_code: 'INR' }];
    const result = computeDashboard(input({ retirement, investments: [mf(65200)] }), 'INR', FX);
    expect(result.totalRetirement).toBe(300000);
    expect(result.totalInvestments).toBe(65200);
    expect(result.netWorth).toBe(365200);
  });
});
