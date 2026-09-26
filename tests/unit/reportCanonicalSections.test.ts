/**
 * WP-06 (DC-10 / EXP-G11 / GAP-02 / DC-08), end to end: the REAL
 * resolveReportSourceData() + the free and premium section builders for a
 * premium household on the PostgREST-shaped fake. The stored sections are
 * what the PDF export renders (app/api/reports/[id]/exports -> the report's
 * own print view), so "the export lists every imported line" is asserted on
 * exactly what gets stored.
 *
 * This file deliberately imports NO WP-06 module by value, so it runs
 * unchanged against the base branch as the negative control
 * (feature/canonical-upload-foundation f79374f): every `it` marked [NC] fails
 * there with an assertion failure, not an import error.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));
vi.mock('@/lib/services/healthScoreData', () => ({ loadHealthScore: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/resilienceData', () => ({ loadResilience: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/financialDnaData', () => ({ loadFinancialDna: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/goalsData', () => ({
  computeGoalsPagePayload: vi.fn().mockResolvedValue({
    payload: {
      goals: [],
      summary: { activeGoalsCount: 0, totalTargetAmount: 0, totalCurrentAmount: 0, overallProgressPct: 0, totalMonthlyContribution: 0, onTrackCount: 0, atRiskCount: 0, offTrackCount: 0, achievedCount: 0, nextGoalDue: null },
      affordability: { status: 'insufficient_data', monthlySurplus: null, totalPlannedGoalContributions: 0, unallocatedAmount: null, overallocatedAmount: null, usageRatio: null, warning: null },
      modelVersion: 'test',
      goalTypes: [],
    },
  }),
}));
vi.mock('@/lib/services/financialTwinService', () => ({ listTwinRuns: vi.fn().mockResolvedValue([]), getTwinRunDetail: vi.fn() }));
vi.mock('@/lib/services/recommendationsData', () => ({ buildReportActionMatches: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/services/forecastReportData', () => ({ buildForecastReportData: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/investmentIntelligenceReportData', () => ({
  loadInvestmentPerformanceForReport: vi.fn().mockResolvedValue(null),
  loadSipForReport: vi.fn().mockResolvedValue(null),
  loadXrayForReport: vi.fn().mockResolvedValue(null),
  loadTaxForReport: vi.fn().mockResolvedValue(null),
  loadReviewItemsForReport: vi.fn().mockResolvedValue(null),
}));

import type { CanonicalAppendix } from '@/lib/engines/reportCanonicalAppendix';
import { resolveReportSourceData, buildEligibilityInput } from '@/lib/services/reportSnapshotResolver';
import { buildPremiumSections } from '@/lib/engines/reportSectionsPremium';
import { buildReportSections } from '@/lib/engines/reportSections';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { tables } from './readModels/helpers/fixtures';
import { householdI, householdM, USER } from './helpers/canonicalGoldenHouseholds';

// ---------------------------------------------------------------------------
// End to end: the stored report sections (what the PDF export renders)
// ---------------------------------------------------------------------------

async function premiumReport(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(tables(t, { user_entitlements: [{ user_id: USER, plan_tier: 'premium' }] }));
  const source = await resolveReportSourceData(USER, undefined, client as never);
  return { source, premium: buildPremiumSections(source, false), free: buildReportSections(source, buildEligibilityInput(source), false) };
}

describe('WP-06 report sections on the canonical read models', () => {
  it('[NC] the stored appendix of Household I lists every imported statement line (the export renders these sections)', async () => {
    const { premium } = await premiumReport(householdI());
    const appendix = premium.find((s) => s.sectionCode === 'appendices')!;
    const stored = JSON.stringify(appendix.sectionData);
    expect((stored.match(/WOOLWORTHS/g) ?? []).length).toBe(3);
    expect((stored.match(/ACME PAYROLL/g) ?? []).length).toBe(3);
    expect(stored).toContain('Imported from bank statement');
    expect(stored).toContain('Retirement accounts');
  });

  it('[NC] the stored appendix marks the superseded manual row as NOT counted (it used to be listed as a counted item)', async () => {
    const { premium } = await premiumReport(householdM());
    const appendix = premium.find((s) => s.sectionCode === 'appendices')!;
    const canonical = (appendix.sectionData as { canonical?: CanonicalAppendix }).canonical;
    const row = canonical?.tables.find((t) => t.key === 'expenses_planned')?.rows.find((r) => r.name === 'Old groceries estimate');
    expect(row?.counted).toBe(false);
  });

  it('[NC] one portfolio total: the investment chapter total is the canonical published total (= Dashboard investments) and the unpublished holding is disclosed', async () => {
    const { source, premium } = await premiumReport(householdI());
    const inv = premium.find((s) => s.sectionCode === 'investment_analysis')!;
    expect(inv.sectionData.totalCurrentValue).toBe(50000);
    expect(inv.sectionData.totalCurrentValue).toBe(source.dashboard.totalInvestments);
    expect(inv.narrativeText).toContain('Imported, not yet in Net Worth');
    expect(inv.narrativeText).toContain('not included in this total or in your Net Worth');
  });

  it('[NC] Report Net Worth is the canonical Net Worth, and what is deliberately NOT in it is listed beside it', async () => {
    const { source, free } = await premiumReport(householdI());
    const nw = free.find((s) => s.sectionCode === 'net_worth')!;
    expect(nw.sectionData.netWorth).toBe(source.dashboard.netWorth);
    expect(nw.sectionData.notInNetWorth).toEqual([{ label: 'Imported, not yet in Net Worth', count: 1, total: 10000 }]);
  });

  it('a snapshot that cannot be read makes the appendix "unavailable" -- never an empty or partial list', async () => {
    const { client } = makeFakeSupabase(tables(householdM(), { user_entitlements: [{ user_id: USER, plan_tier: 'premium' }] }), { failOn: new Set(['forecast_global_assumptions']) });
    const source = await resolveReportSourceData(USER, undefined, client as never);
    const appendix = buildPremiumSections(source, false).find((s) => s.sectionCode === 'appendices')!;
    expect(appendix.sectionStatus).toBe('unavailable');
  });
});
