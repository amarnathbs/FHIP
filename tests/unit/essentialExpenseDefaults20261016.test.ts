/**
 * PO decision 16-10-2026 ("use your recommendations"): the necessity expense items are pre-ticked ESSENTIAL when a row is
 * CREATED (grid and API), from ONE catalogue list; the user can still untick; existing rows are never rewritten here.
 *
 * Hand-calculated oracle - the PO's 22 recorded monthly-equivalent expenses (annual amounts from his production list):
 *   essential by the new default (electricity 364.50, groceries 697.58, health insurance 503.17, home insurance 505.33,
 *   council rates 249.58, fuel 228.33, public transport 95.50, body corporate 81.58, internet 64.42, medical 14.67)
 *       = 2,804.66 a month  (was 0)
 *   core survival (electricity, groceries, health insurance, council rates, fuel, public transport, medical) = 2,153.33
 *       (home insurance, body corporate and internet are essential but NOT core survival)
 *   total expenses 4,535.30 a month; discretionary = 4,535.30 - 2,804.66 = 1,730.64 (was 4,535.30)
 *   emergency-fund months = cash 21,798 / essential 2,804.66 = 7.77 months (was not computable)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_SURVIVAL_EXPENSE_KEYS, ESSENTIAL_DEFAULT_EXPENSE_KEYS, computeDashboard, defaultIsEssentialForExpenseItem, type DashboardInput } from '@/lib/engines/dashboard';
import { expenseGridConfig } from '@/lib/grid/configs';
import { rowFromMaster } from '@/components/grid/FinancialDataGrid';
import { expenseSchema } from '@/lib/validation/expense';

const saved: Record<string, unknown>[] = [];
vi.mock('@/lib/services/appCapability', () => ({
  requireModuleCapability: async () => ({ user: { id: 'u1' }, blocked: null, decision: null }),
}));
vi.mock('@/lib/services/registry', () => ({
  makeRegistry: () => ({
    list: async () => ({ data: [], error: null }),
    save: async (_userId: string, row: Record<string, unknown>) => {
      saved.push(row);
      return { data: row, error: null };
    },
  }),
}));

const PO_ITEMS = ['rent', 'mortgage', 'council_rates', 'water_rates', 'water', 'electricity', 'gas', 'groceries', 'health_insurance', 'medical', 'pharmacy', 'fuel', 'public_transport', 'home_insurance', 'body_corporate', 'internet'];

describe('one catalogue list of necessity expense items', () => {
  it('contains exactly the PO list: the 13 core-survival items plus home insurance, body corporate and internet', () => {
    expect([...ESSENTIAL_DEFAULT_EXPENSE_KEYS].sort()).toEqual([...PO_ITEMS].sort());
    for (const k of PO_ITEMS) expect(defaultIsEssentialForExpenseItem(k), k).toBe(true);
  });
  it('discretionary and unknown items are not pre-ticked', () => {
    for (const k of ['restaurants', 'clothing', 'entertainment', 'travel', 'gym', 'subscriptions', 'streaming_services', 'business_expenses', 'bank_fees', 'mobile_phone', 'miscellaneous']) {
      expect(defaultIsEssentialForExpenseItem(k), k).toBe(false);
    }
    expect(defaultIsEssentialForExpenseItem(null)).toBe(false);
    expect(defaultIsEssentialForExpenseItem(undefined)).toBe(false);
  });
  it('core survival is unchanged: the three extra items are essential by default but never core survival', () => {
    for (const k of ['home_insurance', 'body_corporate', 'internet']) expect(CORE_SURVIVAL_EXPENSE_KEYS.has(k), k).toBe(false);
    expect(CORE_SURVIVAL_EXPENSE_KEYS.size).toBe(13);
  });
});

describe('grid: a NEW row created from the catalogue starts ticked Essential for necessities, and the user can untick', () => {
  const item = (key: string) => ({ item_key: key, item_label: key, sort_order: 1 });
  it('electricity and groceries start essential; restaurants does not', () => {
    expect(rowFromMaster(item('electricity'), 'AUD', expenseGridConfig).is_essential).toBe(true);
    expect(rowFromMaster(item('groceries'), 'AUD', expenseGridConfig).is_essential).toBe(true);
    expect(rowFromMaster(item('restaurants'), 'AUD', expenseGridConfig).is_essential ?? false).toBe(false);
  });
  it('the grid sends the row value, so an unticked box is saved as false (the user wins)', () => {
    const row = { ...rowFromMaster(item('electricity'), 'AUD', expenseGridConfig), is_essential: false };
    expect(row.is_essential).toBe(false);
  });
});

describe('API: POST /api/expenses applies the catalogue default only when is_essential is omitted', () => {
  beforeEach(() => { saved.length = 0; });
  const post = async (body: Record<string, unknown>) => {
    const { POST } = await import('@/app/api/expenses/route');
    return POST(new Request('http://x/api/expenses', { method: 'POST', body: JSON.stringify(body) }));
  };
  const base = { amount: 100, frequency: 'monthly', currency_code: 'AUD' };

  it('schema has no default any more (omitted stays omitted)', () => {
    expect(expenseSchema.parse({ ...base, expense_name: 'x' }).is_essential).toBeUndefined();
    expect(expenseSchema.parse({ ...base, expense_name: 'x', is_essential: false }).is_essential).toBe(false);
  });
  it('omitted + necessity -> true; omitted + other -> false; explicit false on a necessity stays false', async () => {
    expect((await post({ ...base, expense_name: 'Electricity', master_item_key: 'electricity' })).status).toBe(200);
    expect((await post({ ...base, expense_name: 'Restaurants', master_item_key: 'restaurants' })).status).toBe(200);
    expect((await post({ ...base, expense_name: 'Electricity', master_item_key: 'electricity', is_essential: false })).status).toBe(200);
    expect((await post({ ...base, expense_name: 'My custom thing' })).status).toBe(200);
    expect(saved.map((r) => r.is_essential)).toEqual([true, false, false, false]);
  });
});

describe("the PO's household with the new default (hand oracle above)", () => {
  // Annual amounts from the PO's production expense list; the flag is what the new default would have set at creation.
  const rows: [string, string, number, 'annually' | 'one_off', string?][] = [
    ['Business Expenses', 'business_expenses', 8588.47, 'annually'], ['Groceries', 'groceries', 8371, 'annually'], ['Home Insurance', 'home_insurance', 6064, 'annually'],
    ['Health Insurance', 'health_insurance', 6038, 'annually'], ['Restaurants', 'restaurants', 5049, 'annually'], ['Electricity', 'electricity', 4374, 'annually'],
    ['Clothing', 'clothing', 3180, 'annually'], ['Council Rates', 'council_rates', 2995, 'annually'], ['Fuel', 'fuel', 2740, 'annually'],
    ['Entertainment', 'entertainment', 1314, 'annually'], ['Public Transport', 'public_transport', 1146, 'annually'], ['Body Corporate', 'body_corporate', 979, 'annually'],
    ['Internet', 'internet', 773, 'annually'], ['Travel', 'travel', 688, 'annually'], ['Miscellaneous', 'miscellaneous', 628, 'annually'], ['Gym', 'gym', 551, 'annually'],
    ['Subscriptions', 'subscriptions', 226, 'annually'], ['Other Household Expenses', 'other_household_expenses', 188, 'annually'], ['Parking', 'parking', 177, 'annually'],
    ['Medical', 'medical', 176, 'annually'], ['Streaming Services', 'streaming_services', 6000, 'annually', 'INR'], ['Bank Fees', 'bank_fees', 71, 'annually'], ['Mobile Phone', 'mobile_phone', 3338, 'one_off'],
  ];
  const input = (withDefault: boolean): DashboardInput => ({
    income: [{ source_name: 'Salary', amount: 20000, net_amount: 15000, frequency: 'monthly', master_item_key: 'employment_salary', owner: 'self' }] as never,
    expenses: rows.map(([name, key, amount, frequency, currency]) => ({
      expense_name: name, master_item_key: key, amount, frequency, owner: 'self', currency_code: currency ?? 'AUD',
      is_essential: withDefault && defaultIsEssentialForExpenseItem(key),
    })) as never,
    assets: [{ current_value: 21798, asset_class: 'cash', master_item_key: 'savings_account', currency_code: 'AUD' }] as never,
    liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [],
  });

  it('before: essential 0, emergency fund not computable', () => {
    const d = computeDashboard(input(false), 'AUD');
    expect(d.essentialMonthlyExpenses).toBe(0);
    expect(d.emergencyFundMonths).toBeNull();
  });
  it('after: essential 2,804.66, discretionary 1,730.64, core survival 2,153.33, emergency fund 7.77 months; total unchanged', () => {
    const before = computeDashboard(input(false), 'AUD');
    const d = computeDashboard(input(true), 'AUD');
    expect(d.essentialMonthlyExpenses).toBeCloseTo(2804.66, 1);
    expect(d.lifestyleMonthlyExpenses).toBeCloseTo(1730.64, 1);
    expect(d.coreSurvivalMonthlyExpenses).toBeCloseTo(2153.33, 1);
    expect(d.emergencyFundMonths).toBeCloseTo(21798 / 2804.66, 2);
    expect(d.totalMonthlyExpenses).toBeCloseTo(4535.3, 1);
    // The surplus, savings rate and debt-service ratio do not depend on the essential split.
    expect(d.monthlySurplus).toBeCloseTo(before.monthlySurplus, 6);
    expect(d.savingsRate).toBeCloseTo(before.savingsRate as number, 9);
  });
});
