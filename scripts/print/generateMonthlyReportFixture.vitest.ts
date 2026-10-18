// Generates scripts/print/fixtures/monthlyReport.fixture.json and forecastReport.fixture.json: the stored sections of a SYNTHETIC Premium
// Monthly Report (see fixtures/monthlyReportHousehold.ts), produced by the REAL source resolver and the REAL section builders against the
// in-memory PostgREST fake, and the data of the Consolidated Forecasting Report. No database, no network, no real data.
//
//   npx vitest run --config scripts/print/vitest.print.config.ts
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/supabase/server', () => ({ createClient: () => { throw new Error('createClient() must not be called'); } }));
vi.mock('@/lib/services/healthScoreData', async () => { const f = await import('./fixtures/monthlyReportHousehold'); return { loadHealthScore: async () => f.healthScorePayload() }; });
vi.mock('@/lib/services/resilienceData', async () => { const f = await import('./fixtures/monthlyReportHousehold'); return { loadResilience: async () => f.resiliencePayload() }; });
vi.mock('@/lib/services/financialDnaData', async () => { const f = await import('./fixtures/monthlyReportHousehold'); return { loadFinancialDna: async () => f.dnaPayload() }; });
vi.mock('@/lib/services/goalsData', async () => { const f = await import('./fixtures/monthlyReportHousehold'); return { computeGoalsPagePayload: async () => ({ payload: f.goalsPayload() }) }; });
vi.mock('@/lib/services/financialTwinService', async () => { const f = await import('./fixtures/monthlyReportHousehold'); return { listTwinRuns: async () => [{ id: 'twin-1', status: 'completed' }], getTwinRunDetail: async () => f.twinDetail() }; });
vi.mock('@/lib/services/recommendationsData', () => ({
  buildReportActionMatches: async () => [
    { code: 'a1', title: 'Reduce debt and commitment pressure', reason: 'Debt repayments take a large share of monthly net income.', priority: 'high', pillarCode: 'debt', content: 'Review the interest rate on the investment loan and consider whether extra repayments suit your plan.' },
    { code: 'a2', title: 'Build liquid reserves', reason: 'Property is a large share of recorded assets.', priority: 'medium', pillarCode: 'savings', content: 'Add to a savings buffer.' },
    { code: 'a3', title: 'Review insurance cover', reason: 'No income protection is recorded.', priority: 'medium', pillarCode: 'insurance', content: 'Compare cover options.' },
  ],
}));
vi.mock('@/lib/services/forecastReportData', async () => { const f = await import('./fixtures/monthlyReportHousehold'); return { buildForecastReportData: async () => f.forecastReportData() }; });
vi.mock('@/lib/services/investmentIntelligenceReportData', async () => {
  const f = await import('./fixtures/monthlyReportHousehold');
  const c = f.iiChapters();
  return {
    loadInvestmentPerformanceForReport: async () => c.performance,
    loadSipForReport: async () => c.sip,
    loadXrayForReport: async () => c.xray,
    loadTaxForReport: async () => c.taxAndCost,
    loadReviewItemsForReport: async () => c.reviewItems,
  };
});
vi.mock('@/lib/services/investment-intelligence/indiaMfReportData', async () => {
  const f = await import('./fixtures/monthlyReportHousehold');
  return { loadIndiaMfReportForReport: async () => ({ status: 'ok', report: f.indiaMfReport() }) };
});

import { resolveReportSourceData, buildEligibilityInput } from '@/lib/services/reportSnapshotResolver';
import { buildReportSections } from '@/lib/engines/reportSections';
import { makeFakeSupabase } from '../../tests/unit/readModels/helpers/fakeSupabase';
import { tables } from '../../tests/unit/readModels/helpers/fixtures';
import { forecastingReportData, monthlyReportTables, USER } from './fixtures/monthlyReportHousehold';

// The Forecasting report reads only these fields of the Dashboard summary; the fixture carries just those.
const pick = (d: Record<string, unknown>) => Object.fromEntries(['netWorth', 'totalAssetsCombined', 'totalLiabilities', 'monthlySurplus', 'netWorthAllocation', 'hasRetirement', 'countriesInUse'].map((k) => [k, d[k]]));

describe('generate the synthetic Premium Monthly Report fixture', () => {
  it('writes monthlyReport.fixture.json and forecastReport.fixture.json', async () => {
    const snapshots = ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'].map((m, i) => ({
      user_id: USER, snapshot_month: m, net_worth: 1_250_000 + i * 42_000, monthly_income: 14_775, monthly_expenses: 12_650, monthly_surplus: 2_125, savings_rate: 0.14,
      total_assets: 2_700_000 + i * 20_000, total_liabilities: 1_450_000 - i * 22_000, fx_rate_aud_inr: 56,
    }));
    const { client } = makeFakeSupabase(tables(monthlyReportTables(), { financial_snapshots: snapshots, user_entitlements: [{ user_id: USER, plan_tier: 'premium' }] }));
    const source = await resolveReportSourceData(USER, undefined, client as never);
    expect(source.planTier).toBe('premium');
    const sections = buildReportSections(source, buildEligibilityInput(source), false);
    const report = {
      id: '00000000-0000-4000-8000-000000000001', user_id: USER, report_type_code: 'monthly_premium', report_month: source.reportMonth, as_of_date: source.asOfDate, title: 'Monthly report',
      status: 'ready', version_number: 1, revises_report_id: null, reporting_currency: 'AUD', country_scope: 'household', data_completeness_pct: 92, generated_at: '2026-10-18T08:00:00Z', published_at: null,
      failure_code: null, failure_message: null, created_at: '2026-10-18T08:00:00Z',
    };
    fs.writeFileSync(path.resolve(__dirname, 'fixtures', 'monthlyReport.fixture.json'), JSON.stringify({ report, sections, currency: 'AUD' }, null, 1));
    expect(sections.length).toBeGreaterThan(20);
    fs.writeFileSync(path.resolve(__dirname, 'fixtures', 'forecastReport.fixture.json'), JSON.stringify({ data: forecastingReportData(pick(source.dashboard as unknown as Record<string, unknown>)), currency: 'AUD' }));
  });
});
