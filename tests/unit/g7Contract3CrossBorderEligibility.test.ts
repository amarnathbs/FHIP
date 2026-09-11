// G7 Contract 3 (docs/country-programme/g7-data-contracts.md) —
// hasCrossBorderEligibility() (lib/engines/reportEligibility.ts), shared by
// reportEligibility.ts's own 'cross_border' check (tests/unit/reports.test.ts)
// and reportSectionsPremium.ts's buildCrossBorderFull() (exercised here).
import { describe, it, expect } from 'vitest';
import { hasCrossBorderEligibility } from '@/lib/engines/reportEligibility';
import { computeDashboard, type DashboardInput, type AssetRow } from '@/lib/engines/dashboard';
import { buildCrossBorderFull } from '@/lib/engines/reportSectionsPremium';
import type { ReportSourceData } from '@/lib/services/reportSnapshotResolver';

describe('hasCrossBorderEligibility (pure)', () => {
  it('a single country in use is NOT cross-border eligible', () => {
    expect(hasCrossBorderEligibility(1)).toBe(false);
  });
  it('zero countries recorded is NOT cross-border eligible', () => {
    expect(hasCrossBorderEligibility(0)).toBe(false);
  });
  it('more than one country in use IS cross-border eligible', () => {
    expect(hasCrossBorderEligibility(2)).toBe(true);
    expect(hasCrossBorderEligibility(5)).toBe(true);
  });
});

const BASE_INPUT: DashboardInput = {
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
    goals: {} as any,
    previousGoalsOnTrackCount: null,
    previousActiveGoalsCount: null,
    dataFreshness: {},
    financialTwin: null,
    planTier: 'premium',
    premium: null,
    commitments: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: {} as any,
    actionRecommendations: [],
  };
}

describe('buildCrossBorderFull — uses the shared eligibility threshold (G7 Contract 3)', () => {
  it('a single-country household omits the section, matching hasCrossBorderEligibility(1) === false', () => {
    const source = buildSource([{ current_value: 100000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD' }]);
    const section = buildCrossBorderFull(source);
    expect(section.sectionStatus).toBe('omitted');
    expect(section.limitationText).toMatch(/single country/i);
  });

  it('a genuinely multi-country household includes the section, matching hasCrossBorderEligibility(2) === true', () => {
    const source = buildSource([
      { current_value: 100000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD' },
      { current_value: 5500000, asset_class: 'cash', country_code: 'IN', currency_code: 'INR' },
    ]);
    const section = buildCrossBorderFull(source);
    expect(section.sectionStatus).toBe('included');
  });
});
