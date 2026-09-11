// G7 Contract 4 (docs/country-programme/g7-data-contracts.md) — net_worth,
// cash_flow and executive_summary gain a conditional cross-border blending
// caveat in their limitationText, additive only. Exercises the REAL
// buildReportSections() dispatcher (lib/engines/reportSections.ts) against
// a real computeDashboard()-built fixture, same convention as
// tests/unit/reportSectionsPremiumStressApplicability.test.ts.
import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput, type AssetRow } from '@/lib/engines/dashboard';
import { buildReportSections } from '@/lib/engines/reportSections';
import { buildEligibilityInput } from '@/lib/services/reportSnapshotResolver';
import type { ReportSourceData } from '@/lib/services/reportSnapshotResolver';

const BASE_INPUT: DashboardInput = {
  income: [{ amount: 5000, net_amount: 4200, frequency: 'monthly', master_item_key: 'salary' }],
  expenses: [{ expense_name: 'Rent', amount: 2000, frequency: 'monthly', is_essential: true }],
  assets: [],
  liabilities: [],
  investments: [],
  retirement: [],
  insurance: [],
  goals: [],
  snapshots: [],
};

function buildSource(assets: AssetRow[]): ReportSourceData {
  const dashboard = computeDashboard({ ...BASE_INPUT, assets }, 'AUD');
  return {
    userId: 'test-user',
    reportMonth: '2026-08-01',
    asOfDate: '2026-08-28',
    currency: 'AUD',
    profile: { fullName: null, householdName: null, householdType: null, countryOfResidence: 'AU', preferredCurrency: 'AUD', dependantsCount: 0 },
    dashboard,
    healthScore: null,
    resilience: null,
    dna: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    goals: {
      summary: { onTrackCount: 0, activeGoalsCount: 0 },
      goals: [],
      affordability: { status: 'comfortable', monthlySurplus: null, totalPlannedGoalContributions: 0, unallocatedAmount: null, overallocatedAmount: null, usageRatio: null, warning: null },
    } as any,
    previousGoalsOnTrackCount: null,
    previousActiveGoalsCount: null,
    dataFreshness: {},
    financialTwin: null,
    planTier: 'free',
    premium: null,
    commitments: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: {} as any,
    actionRecommendations: [],
  };
}

function sectionsFor(assets: AssetRow[]) {
  const source = buildSource(assets);
  const eligibilityInput = buildEligibilityInput(source);
  return buildReportSections(source, eligibilityInput, false);
}

function find(sections: ReturnType<typeof sectionsFor>, code: string) {
  const section = sections.find((s) => s.sectionCode === code);
  if (!section) throw new Error(`section ${code} not found`);
  return section;
}

describe('G7 Contract 4 — consolidated sections cross-border limitationText', () => {
  it('single-country household: no blending caveat on any of the three sections (additive-only, does not fire for the overwhelming majority of reports)', () => {
    const sections = sectionsFor([{ current_value: 100000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD' }]);
    expect(find(sections, 'executive_summary').limitationText).toBeNull();
    expect(find(sections, 'cash_flow').limitationText).toBeNull();
    expect(find(sections, 'net_worth').limitationText).toBeNull();
  });

  it('a genuinely multi-country household gets the blending caveat on all three consolidated sections', () => {
    const sections = sectionsFor([
      { current_value: 100000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD' },
      { current_value: 5500000, asset_class: 'cash', country_code: 'IN', currency_code: 'INR' },
    ]);
    expect(find(sections, 'executive_summary').limitationText).toBe('This section blends figures from 2 countries.');
    expect(find(sections, 'cash_flow').limitationText).toBe('This section blends figures from 2 countries.');
    expect(find(sections, 'net_worth').limitationText).toBe('This section blends figures from 2 countries.');
  });
});
