// G0-JA-1 Wave 1 follow-up — applicabilityNote() (lib/engines/reportSectionsPremium.ts)
// used to derive "home country" for the currency_shock scenario's note text
// from the household's preferred/reporting currency
// (`d.currency === 'AUD' ? 'AU' : 'IN'`) instead of the caller's actual,
// already-resolved country_of_residence. This is the same defect shape as
// JA-D2, already fixed in lib/engines/resilienceStress.ts (see
// tests/unit/resilienceStressHomeCountry.test.ts) — buildStressTesting
// already threaded the correct homeCountry into applyStressScenario, so the
// shock figures themselves were already correct; only this note-text helper
// still re-derived home country from currency, which could make the "Not
// applicable — no overseas investment holdings are currently recorded"
// message wrong for a household whose preferred_currency doesn't match
// their country_of_residence.
//
// This suite drives the REAL exported buildStressTesting() against REAL
// DashboardSummary fixtures built via computeDashboard() (not a hand-rolled
// stub), so every assertion below exercises the same code path production
// traffic does, all the way through to the rendered applicabilityNote text.
import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput, type InvestmentRow } from '@/lib/engines/dashboard';
import { buildStressTesting } from '@/lib/engines/reportSectionsPremium';
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

function buildSource(currency: 'AUD' | 'INR', countryOfResidence: string | null, investments: InvestmentRow[]): ReportSourceData {
  const dashboard = computeDashboard({ ...BASE_INPUT, investments }, currency);
  return {
    userId: 'test-user',
    reportMonth: '2026-08-01',
    asOfDate: '2026-08-28',
    currency,
    profile: {
      fullName: null,
      householdName: null,
      householdType: null,
      countryOfResidence,
      preferredCurrency: currency,
      dependantsCount: 0,
    },
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

function currencyShockNote(source: ReportSourceData): string | null {
  const section = buildStressTesting(source);
  expect(section.sectionStatus).toBe('included');
  const scenarios = section.sectionData.scenarios as { scenario: string; applicabilityNote: string | null }[];
  const row = scenarios.find((s) => s.scenario === 'currency_shock');
  if (!row) throw new Error('currency_shock scenario missing from stress_testing section');
  return row.applicabilityNote;
}

describe('buildStressTesting — currency_shock applicabilityNote home-country resolution', () => {
  it('positive AU test: confirmed-AU resident with AUD currency and only an IN-domiciled holding — the IN holding is genuinely foreign, note is null (scenario applies)', () => {
    const source = buildSource('AUD', 'AU', [
      { current_value: 50_000, cost_base: 50_000, investment_type: 'shares', master_item_key: 'domestic_shares', country_code: 'IN', annual_contribution: 0, currency_code: null },
    ]);
    expect(currencyShockNote(source)).toBeNull();
  });

  it('positive AU test, no foreign holdings: AU resident, AUD currency, only an AU-domiciled holding — genuinely nothing overseas, note says "Not applicable"', () => {
    const source = buildSource('AUD', 'AU', [
      { current_value: 50_000, cost_base: 50_000, investment_type: 'shares', master_item_key: 'domestic_shares', country_code: 'AU', annual_contribution: 0, currency_code: null },
    ]);
    expect(currencyShockNote(source)).toMatch(/not applicable/i);
  });

  it('currency/country mismatch — IN resident reporting in AUD, only an AU-domiciled holding: relative to the TRUE home (IN) that holding is foreign, so the note must be null, not "Not applicable"', () => {
    // Old defect: `d.currency === 'AUD' ? 'AU' : 'IN'` would see currency
    // 'AUD' and wrongly conclude home country 'AU', excluding this
    // AU-domiciled holding from the "foreign" filter entirely — leaving 0
    // foreign investments and wrongly printing "Not applicable" even though
    // the household actually lives in India and this holding is genuinely
    // an overseas asset for them.
    const source = buildSource('AUD', 'IN', [
      { current_value: 100_000, cost_base: 100_000, investment_type: 'shares', master_item_key: 'international_shares', country_code: 'AU', annual_contribution: 0, currency_code: null },
    ]);
    expect(currencyShockNote(source)).toBeNull();
  });

  it('currency/country mismatch, correctly "Not applicable" — IN resident reporting in AUD, only an IN-domiciled holding: relative to the TRUE home (IN) there is nothing foreign, so the note must say "Not applicable"', () => {
    // Old defect (inverted direction): home wrongly resolved to 'AU' from
    // currency would treat this IN-domiciled holding as "foreign" (it isn't
    // AU), wrongly showing the scenario as applicable when the household
    // has no overseas holdings at all relative to their real home, India.
    const source = buildSource('AUD', 'IN', [
      { current_value: 100_000, cost_base: 100_000, investment_type: 'shares', master_item_key: 'domestic_shares', country_code: 'IN', annual_contribution: 0, currency_code: null },
    ]);
    expect(currencyShockNote(source)).toMatch(/not applicable/i);
  });

  it('unresolved-country negative control: never guesses AU or IN from currency — fails closed the same way applyCurrencyShock itself does (no shock applied -> "Not applicable")', () => {
    const source = buildSource('AUD', 'somewhere-unrecognised', [
      { current_value: 100_000, cost_base: 100_000, investment_type: 'shares', master_item_key: 'international_shares', country_code: 'IN', annual_contribution: 0, currency_code: null },
    ]);
    expect(currencyShockNote(source)).toMatch(/not applicable/i);
  });

  it('no investments at all: note is "Not applicable" regardless of currency/country combination', () => {
    const source = buildSource('INR', 'IN', []);
    expect(currencyShockNote(source)).toMatch(/not applicable/i);
  });
});
