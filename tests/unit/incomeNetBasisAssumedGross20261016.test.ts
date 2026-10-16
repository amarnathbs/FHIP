/**
 * PO DECISION 16-10-2026 - deliberately REVERSES the certified GAP-09 rule.
 *
 * Before: a blank take-home was "unknown" and contributed nothing to net income.
 * Now:    (a) the app asks for the take-home pay, (b) until it is given the GROSS is used as take-home (no tax
 *         deducted) so every calculation proceeds, (c) every screen that shows the affected figures says so and
 *         names the sources, (d) the user may instead enter the TAX per period: net = gross - tax.
 *
 * Hand-calculated oracles (never produced by running the code under test):
 *   Salary 8,000 monthly, net blank, tax blank                  -> net 8,000 (assumed gross)
 *   Salary 7,576.71 fortnightly, tax 1,800 per fortnight        -> net 5,776.71 per fortnight (derived)
 *   Salary 8,000 monthly, net 6,000, tax 500                    -> net 6,000 (entered wins)
 *   Salary 8,000 monthly, tax 9,000 (more than gross)           -> tax ignored, net 8,000 (assumed)
 *   Registers path: salary 8,000 + side job 1,200 (net 1,000), expenses 2,000, debt 1,500:
 *       gross 9,200; net 8,000 + 1,000 = 9,000; surplus 9,000 - 2,000 - 1,500 = 5,500; savings rate 5,500 / 9,000;
 *       debt-service ratio 1,500 / 9,000.
 *       Under the OLD GAP-09 rule net would have been 1,000, surplus -2,500 and DSR 150%.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveNetBasis } from '@/lib/engines/incomeNetBasis';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import { incomeTaxProblem } from '@/lib/validation/income';
import { DashboardDataStatusNotice } from '@/components/dashboard/DashboardDataStatusNotice';

describe('resolveNetBasis', () => {
  it('entered take-home wins, then gross minus tax, then the assumed gross', () => {
    expect(resolveNetBasis(8000, 6000, 500)).toEqual({ net: 6000, basis: 'entered' });
    expect(resolveNetBasis(7576.71, null, 1800)).toEqual({ net: 5776.71, basis: 'derived_from_tax' });
    expect(resolveNetBasis(8000, null, null)).toEqual({ net: 8000, basis: 'assumed_gross' });
    expect(resolveNetBasis(8000, undefined, undefined)).toEqual({ net: 8000, basis: 'assumed_gross' });
  });
  it('a tax of 0 is an explicit "no tax" statement (derived), not an assumption', () => {
    expect(resolveNetBasis(8000, null, 0)).toEqual({ net: 8000, basis: 'derived_from_tax' });
  });
  it('a tax above the gross, or negative, is ignored and the gross is assumed', () => {
    expect(resolveNetBasis(8000, null, 9000)).toEqual({ net: 8000, basis: 'assumed_gross' });
    expect(resolveNetBasis(8000, null, -5)).toEqual({ net: 8000, basis: 'assumed_gross' });
  });
});

describe('incomeTaxProblem (API validation)', () => {
  it('tax may not exceed the gross; absent values are not a problem', () => {
    expect(incomeTaxProblem({ amount: 1000, tax_amount: 1001 })).toMatch(/cannot be more than the gross/);
    expect(incomeTaxProblem({ amount: 1000, tax_amount: 1000 })).toBeNull();
    expect(incomeTaxProblem({ amount: 1000, tax_amount: null })).toBeNull();
    expect(incomeTaxProblem({ tax_amount: 5 })).toBeNull();
  });
});

const EMPTY: DashboardInput = { income: [], expenses: [], assets: [], liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [] };

describe('registers-only Dashboard path uses the same rule (single source of truth)', () => {
  const input: DashboardInput = {
    ...EMPTY,
    income: [
      { source_name: 'Salary', amount: 8000, net_amount: null, frequency: 'monthly', master_item_key: 'employment_salary', owner: 'self' },
      { source_name: 'Side job', amount: 1200, net_amount: 1000, frequency: 'monthly', master_item_key: null, owner: 'self' },
    ] as never,
    expenses: [{ expense_name: 'Living', amount: 2000, frequency: 'monthly', is_essential: false, master_item_key: null, owner: 'self' }] as never,
    liabilities: [{ balance: 300000, monthly_repayment: 1500, debt_type: 'mortgage', master_item_key: 'home_loan', owner: 'self', interest_rate: 6 }] as never,
  };
  it('blank take-home -> gross as net; surplus 5,500; savings rate and DSR on net 9,000; the source is named', () => {
    const d = computeDashboard(input, 'AUD');
    expect(d.grossMonthlyIncome).toBe(9200);
    expect(d.netMonthlyIncome).toBe(9000);
    expect(d.monthlySurplus).toBe(5500);
    expect(d.savingsRate).toBeCloseTo(5500 / 9000, 6);
    expect(d.debtServiceRatio).toBeCloseTo(1500 / 9000, 6);
    expect(d.dataStatus?.netIncomeAssumed).toEqual({ count: 1, grossMonthly: 8000, sources: [{ name: 'Salary', grossMonthly: 8000 }] });
    expect(d.dataStatus?.netIncomeBasis).toBe('net_partial');
  });
  it('entering the tax replaces the assumption: net = gross - tax on the same period, nothing flagged', () => {
    const withTax = { ...input, income: [{ ...(input.income[0] as object), tax_amount: 2500 }, input.income[1]] as never };
    const d = computeDashboard(withTax, 'AUD');
    expect(d.netMonthlyIncome).toBe(5500 + 1000);
    expect(d.dataStatus?.netIncomeAssumed.count).toBe(0);
    expect(d.dataStatus?.netIncomeBasis).toBe('net');
  });
  it('every source blank -> basis gross_fallback (all assumed)', () => {
    const d = computeDashboard({ ...input, income: [input.income[0]] as never }, 'AUD');
    expect(d.dataStatus?.netIncomeBasis).toBe('gross_fallback');
    expect(d.netMonthlyIncome).toBe(8000);
  });
});

describe('Dashboard notice highlights the assumption and says how many sources', () => {
  it('renders an amber banner naming the sources; renders nothing when none are assumed', () => {
    const d = computeDashboard({ ...EMPTY, income: [{ source_name: 'Salary', amount: 8000, net_amount: null, frequency: 'monthly', master_item_key: null, owner: 'self' }] as never }, 'AUD');
    const html = renderToStaticMarkup(createElement(DashboardDataStatusNotice, { status: d.dataStatus, currency: 'AUD' }));
    expect(html).toContain('Gross is being treated as take-home: no tax has been deducted.');
    expect(html).toContain('1 income source has no take-home pay or tax entered');
    expect(html).toContain('Salary ($8,000 a month)');
    expect(html).toContain('bg-amber-50');
    const clean = computeDashboard({ ...EMPTY, income: [{ source_name: 'Salary', amount: 8000, net_amount: 6000, frequency: 'monthly', master_item_key: null, owner: 'self' }] as never }, 'AUD');
    expect(renderToStaticMarkup(createElement(DashboardDataStatusNotice, { status: clean.dataStatus, currency: 'AUD' }))).toBe('');
  });
});
