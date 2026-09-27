/**
 * Security/integrity review (canonical-upload stage 3): "an error is never a 0".
 *
 * Found by the adversarial review of the Dashboard core:
 *  1. writeFinancialSnapshots() persisted monthly_income / monthly_expenses /
 *     monthly_surplus from sections the canonical snapshot reported as
 *     UNAVAILABLE -- the `?? 0` stand-ins became stored history (Twin trends,
 *     Score history read it back as real zeros).
 *  2. The Expense Ratio indicator divided an unavailable (0) expense figure by
 *     the income and scored it 0% "good"; Savings Rate and DSR were already
 *     gated on availability, this one was not.
 *
 * Drives the REAL loader (loadDashboard -> computeDashboard) against the
 * in-memory PostgREST fake, with failure injection on one table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadDashboard } from '@/lib/services/dashboardData';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { tables, USER } from './readModels/helpers/fixtures';
import { householdI, householdM } from './readModels/helpers/goldenPair';

afterEach(() => vi.restoreAllMocks());

const now = new Date();
const CUR_MONTH = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

async function dashboard(t: Record<string, Row[]>, options: Parameters<typeof makeFakeSupabase>[1] = {}) {
  const fake = makeFakeSupabase(t, options);
  const d = await loadDashboard(USER, fake.client as never);
  return { d, fake };
}

describe('financial_snapshots never stores an unavailable section as 0', () => {
  it('the approved ledger cannot be read: this month keeps NO cash-flow figure (null), not 0 / 0 / 0', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = tables(householdI(), {
      financial_snapshots: [{ user_id: USER, snapshot_month: CUR_MONTH, net_worth: -19000, monthly_income: 9000, monthly_expenses: 5100, monthly_surplus: 1900, savings_rate: 0.27, total_assets: 12000, total_liabilities: 31000 }],
    });
    const { d, fake } = await dashboard(t, { failOn: new Set(['fdh_transactions']) });
    const sections = d.dataStatus?.unavailable.map((u) => u.section) ?? [];
    expect(sections).toEqual(expect.arrayContaining(['income', 'expenses', 'liabilities']));
    const row = fake.upserts.find((u) => u.table === 'financial_snapshots')?.row;
    expect(row).toBeDefined();
    expect(row?.monthly_income).toBeNull();
    expect(row?.monthly_expenses).toBeNull();
    expect(row?.monthly_surplus).toBeNull();
    expect(row?.savings_rate).toBeNull();
  });

  it('only the planned-expense register fails: income is stored, expenses and surplus are not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { d, fake } = await dashboard(householdM(), { failOn: new Set(['expense_items']) });
    const sections = d.dataStatus?.unavailable.map((u) => u.section) ?? [];
    expect(sections).toContain('expenses');
    expect(sections).not.toContain('income');
    const row = fake.upserts.find((u) => u.table === 'financial_snapshots')?.row;
    expect(row?.monthly_income).toBe(9000);
    expect(row?.monthly_expenses).toBeNull();
    expect(row?.monthly_surplus).toBeNull();
  });

  it('control: with every section readable the three figures are still written', async () => {
    const { fake } = await dashboard(householdM());
    const row = fake.upserts.find((u) => u.table === 'financial_snapshots')?.row;
    expect(typeof row?.monthly_income).toBe('number');
    expect(typeof row?.monthly_expenses).toBe('number');
    expect(typeof row?.monthly_surplus).toBe('number');
  });
});

describe('Expense Ratio is never scored from an unavailable expense figure', () => {
  it('expenses unavailable: the ratio is null and neutral, never 0% "good"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { d } = await dashboard(householdM(), { failOn: new Set(['expense_items']) });
    const r = d.ratios.find((x) => x.key === 'expense_ratio');
    expect(r).toBeDefined();
    expect(r?.value).toBeNull();
    expect(r?.status).toBe('neutral');
  });

  it('control: both readable -> a real ratio', async () => {
    const { d } = await dashboard(householdM());
    const r = d.ratios.find((x) => x.key === 'expense_ratio');
    expect(typeof r?.value).toBe('number');
    expect(r?.status).not.toBe('neutral');
  });
});
