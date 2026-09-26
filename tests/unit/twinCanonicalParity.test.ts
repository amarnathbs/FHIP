/**
 * WP-05 (DC-04 / GAP-02 / EXP-G10 / DC-13 / DC-18): the Financial Twin reads
 * the SAME Dashboard figures and the SAME canonical read models as every other
 * consumer.
 *
 * Drives the REAL loadTwinSourceData() and the REAL loadDashboard() against
 * the PostgREST-shaped fake (tests/unit/readModels/helpers/fakeSupabase.ts,
 * which enforces the 1000-row cap). Only the four downstream engines the Twin
 * fans out to (Score, Resilience, DNA, Goals) are stubbed -- their own logic
 * is not under test here.
 *
 * NEGATIVE CONTROL (run against the base branch, feature/canonical-upload-
 * foundation f79374f): the Twin's private computeDashboard() ignored approved
 * bank lines, the superseded flag and business entities, read the OLDEST 12
 * snapshots, summed AUD + INR raw, and truncated a 1000+ row register -- every
 * `it` below except the fail-closed one fails there.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));
vi.mock('@/lib/services/healthScoreData', () => ({
  loadHealthScore: vi.fn().mockResolvedValue({ overallScore: 60, statusLabel: 'Stable', components: [], recommendations: [], previousScore: null, scoreChange: null, history: [] }),
}));
vi.mock('@/lib/services/resilienceData', () => ({
  loadResilience: vi.fn().mockResolvedValue({ overallScore: 60, statusLabel: 'Resilient', components: [], componentScores: [], risks: [], previousScore: null, scoreChange: null, history: [], eligibility: 'full' }),
}));
vi.mock('@/lib/services/financialDnaData', () => ({ loadFinancialDna: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/services/goalsData', () => ({
  computeGoalsPagePayload: vi.fn().mockResolvedValue({
    payload: { goals: [], summary: { activeGoalsCount: 0, overallProgressPct: 0 }, affordability: { usageRatio: null } },
  }),
}));

import { loadTwinSourceData } from '@/lib/services/twinData';
import { loadDashboard } from '@/lib/services/dashboardData';
import { computeTwinMetricValues } from '@/lib/engines/twin/metricDerivation';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { tables } from './readModels/helpers/fixtures';
import { householdI, householdM, USER } from './helpers/canonicalGoldenHouseholds';

async function twin(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(t);
  const outcome = await loadTwinSourceData(USER, client as never);
  if (outcome.status !== 'ok') throw new Error('country unresolved');
  return outcome.data;
}

async function dashboard(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(t);
  return loadDashboard(USER, client as never);
}

describe('WP-05 Twin parity with the Dashboard (M and I)', () => {
  for (const [name, build] of [['M (manual)', householdM], ['I (imported)', householdI]] as const) {
    it(`${name}: Twin income, surplus and Net Worth are the Dashboard's own figures`, async () => {
      const t = build();
      const [tw, db] = await Promise.all([twin(t), dashboard(t)]);
      expect(tw.dashboard.grossMonthlyIncome).toBe(db.grossMonthlyIncome);
      expect(tw.dashboard.netMonthlyIncome).toBe(db.netMonthlyIncome);
      expect(tw.dashboard.totalMonthlyExpenses).toBe(db.totalMonthlyExpenses);
      expect(tw.dashboard.monthlySurplus).toBe(db.monthlySurplus);
      expect(tw.dashboard.netWorth).toBe(db.netWorth);
      // Business entities are inside the ONE Net Worth figure (the private
      // Twin copy left them out): 50% of 100,000.
      expect(tw.dashboard.netWorth - (tw.dashboard.totalAssets + tw.dashboard.totalInvestments + tw.dashboard.totalRetirement - tw.dashboard.totalLiabilities)).toBe(50000);
    });
  }

  it('the superseded manual row is not in the Twin income/expense base (it is not on the Dashboard)', async () => {
    const t = householdM();
    const [tw, db] = await Promise.all([twin(t), dashboard(t)]);
    // Rent 2,000 + groceries 800 + remittance 500 = 3,300 (the mortgage row is
    // a debt-service duplicate; the 999 superseded row and the SMSF row never count).
    expect(db.totalMonthlyExpenses).toBe(3300);
    expect(tw.dashboard.totalMonthlyExpenses).toBe(3300);
  });
});

describe('WP-05 Twin-only inputs come from the canonical read models', () => {
  it('housing cost: M and I both 5,000 (rent 2,000 + owner-occupied home-loan debt service 3,000, the duplicate mortgage row counted once)', async () => {
    const [m, i] = await Promise.all([twin(householdM()), twin(householdI())]);
    expect(m.expenseHousingMonthly).toBe(5000);
    expect(i.expenseHousingMonthly).toBe(5000);
  });

  it('remittance: 500 -- the superseded and SMSF-owned remittance rows never count', async () => {
    const [m, i] = await Promise.all([twin(householdM()), twin(householdI())]);
    expect(m.remittanceMonthly).toBe(500);
    expect(i.remittanceMonthly).toBe(500);
  });

  it('balance-sheet rows are in the REPORTING currency: an INR 5,600,000 property is AUD 100,000 (DC-13)', async () => {
    const tw = await twin(householdM());
    const prop = tw.rawAssets.find((a) => a.country_code === 'IN');
    expect(prop?.current_value).toBe(100000);
    expect(prop?.currency_code).toBe('INR');
    const metrics = computeTwinMetricValues({ ...tw, household: { ...tw.household, isCrossBorder: true } });
    // AUD 20,000 cash + AUD 50,000 ETF = 70,000 AUD-denominated vs 100,000
    // INR-denominated (converted): 100,000 / 170,000. The raw sum would be
    // 5,600,000 / 5,670,000 = 98.8%.
    expect(metrics.currency_concentration.value).toBeCloseTo((100000 / 170000) * 100, 6);
  });

  it('a USD asset is left out of the Twin rows (fail closed), never summed as if it were AUD', async () => {
    const t = tables(householdM(), {
      assets: [{ id: 'as-usd', user_id: USER, asset_name: 'US brokerage cash', asset_class: 'cash', current_value: 1_000_000, currency_code: 'USD', owner: 'self', master_item_key: 'savings_account', source_type: 'manual', linked_liability_id: null, country_code: 'US', is_active: true }],
    });
    const tw = await twin(t);
    expect(tw.rawAssets.some((a) => a.currency_code === 'USD')).toBe(false);
  });

  it('1,001 active assets: all 1,001 reach the Twin (no 1000-row truncation, DC-18)', async () => {
    const many: Row[] = Array.from({ length: 1001 }, (_, n) => ({
      id: `as-${String(n).padStart(5, '0')}`, user_id: USER, asset_name: `Asset ${n}`, asset_class: 'other', current_value: 1, currency_code: 'AUD', owner: 'self',
      master_item_key: 'other_assets', source_type: 'manual', linked_liability_id: null, country_code: 'AU', is_active: true,
    }));
    const tw = await twin(tables(householdM(), { assets: many }));
    expect(tw.rawAssets.filter((a) => a.asset_class === 'other')).toHaveLength(1001);
  });

  it('snapshot history is the MOST RECENT 12 months, oldest first; a null month is missing, not 0', async () => {
    const snaps: Row[] = Array.from({ length: 14 }, (_, n) => {
      const d = new Date(Date.UTC(2025, n, 1));
      return {
        user_id: USER, snapshot_month: d.toISOString().slice(0, 10),
        net_worth: n === 13 ? null : 1000 * (n + 1), monthly_income: 100, monthly_expenses: 50, monthly_surplus: 50,
      };
    });
    const tw = await twin(tables(householdM(), { financial_snapshots: snaps }));
    expect(tw.snapshots12m).toHaveLength(12);
    expect(tw.snapshots12m[0].month).toBe('2025-03-01');
    expect(tw.snapshots12m[11].month).toBe('2026-02-01');
    expect(tw.snapshots12m[11].netWorth).toBeNull();
    // Growth uses the known points only: 3,000 -> 13,000 (never "-> 0").
    expect(computeTwinMetricValues(tw).net_worth_growth_12m.value).toBeCloseTo(((13000 - 3000) / 3000) * 100, 6);
  });

  it('a failed canonical read fails the Twin closed -- never a benchmark computed from zeros (DC-14)', async () => {
    const { client } = makeFakeSupabase(householdM(), { failOn: new Set(['assets']) });
    await expect(loadTwinSourceData(USER, client as never)).rejects.toThrow();
  });
});
