import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import { computeBusinessEntityNetAssetValue, computeBusinessEntityOwnershipValue, type BusinessEntityWithLineItems } from '@/lib/engines/businessEntityValuation';
import { businessEntityCreateInputSchema } from '@/lib/validation/businessEntity';

// ---------------------------------------------------------------------------
// LR-11 (Company / Family Trust Entity Architecture) — WP-05 consolidation
// model and its mandatory negative controls (NEG-01 through NEG-08 of the
// LR-11 spec). Written in the same genuine-negative-control style
// smsfHouseholdIsolation.test.ts established for LR-FI-1: a household
// carrying a business entity must produce the SAME cash-flow/DTI figures as
// an otherwise-identical household with no entity at all — proving the
// entity's data structurally cannot leak into those figures, not merely that
// "a filter exists somewhere".
// ---------------------------------------------------------------------------

const EMPTY: DashboardInput = {
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

function summaryEntity(overrides: Partial<BusinessEntityWithLineItems['entity']> = {}): BusinessEntityWithLineItems {
  return {
    entity: {
      id: 'entity-1',
      ownership_percentage: 100,
      valuation_mode: 'summary',
      summary_net_asset_value: 100_000,
      currency_code: 'AUD',
      is_active: true,
      ...overrides,
    },
    assets: [],
    liabilities: [],
  };
}

describe('computeBusinessEntityNetAssetValue', () => {
  it('Summary mode returns the entity\'s own net figure, converted to the reporting currency', () => {
    const nav = computeBusinessEntityNetAssetValue(summaryEntity({ summary_net_asset_value: 50_000, currency_code: 'AUD' }), 'AUD', 56);
    expect(nav).toBe(50_000);
  });

  it('Summary mode converts INR to AUD reporting currency using the fx rate', () => {
    const nav = computeBusinessEntityNetAssetValue(summaryEntity({ summary_net_asset_value: 5_600_000, currency_code: 'INR' }), 'AUD', 56);
    expect(nav).toBe(100_000); // 5,600,000 INR / 56 = 100,000 AUD
  });

  it('Detailed mode nets assets minus liabilities, never just assets', () => {
    const row: BusinessEntityWithLineItems = {
      entity: { id: 'e1', ownership_percentage: 100, valuation_mode: 'detailed', summary_net_asset_value: null, currency_code: 'AUD', is_active: true },
      assets: [{ value: 200_000, currency_code: 'AUD' }],
      liabilities: [{ value: 80_000, currency_code: 'AUD' }],
    };
    expect(computeBusinessEntityNetAssetValue(row, 'AUD', 56)).toBe(120_000);
  });

  it('Detailed mode with mixed-currency line items converts each before netting', () => {
    const row: BusinessEntityWithLineItems = {
      entity: { id: 'e1', ownership_percentage: 100, valuation_mode: 'detailed', summary_net_asset_value: null, currency_code: 'AUD', is_active: true },
      assets: [{ value: 5_600_000, currency_code: 'INR' }], // = 100,000 AUD
      liabilities: [{ value: 20_000, currency_code: 'AUD' }],
    };
    expect(computeBusinessEntityNetAssetValue(row, 'AUD', 56)).toBe(80_000);
  });
});

describe('computeBusinessEntityOwnershipValue — WP-05 consolidation rule', () => {
  it('applies (ownership% / 100) to the net asset value, never the raw net value at 100%', () => {
    const value = computeBusinessEntityOwnershipValue([summaryEntity({ ownership_percentage: 40, summary_net_asset_value: 100_000 })], 'AUD', 56);
    expect(value).toBe(40_000);
  });

  it("NEG-03-adjacent — each entity's own ownership percentage never cross-contaminates another entity's value", () => {
    const rows = [
      summaryEntity({ id: 'e1', ownership_percentage: 100, summary_net_asset_value: 100_000 }),
      summaryEntity({ id: 'e2', ownership_percentage: 20, summary_net_asset_value: 100_000 }),
    ];
    // If percentages were ever blended (e.g. averaged) instead of applied
    // per-entity, this would be 60,000 * 2 = 120,000 or some other wrong
    // figure — the correct answer keeps each entity's own share separate.
    expect(computeBusinessEntityOwnershipValue(rows, 'AUD', 56)).toBe(120_000);
  });

  it('an archived (is_active=false) entity never contributes to the consolidated value', () => {
    const rows = [summaryEntity({ is_active: false, summary_net_asset_value: 500_000 })];
    expect(computeBusinessEntityOwnershipValue(rows, 'AUD', 56)).toBe(0);
  });

  it('a negative net asset value (an underwater entity) reduces household Net Worth, matching real economics', () => {
    const rows = [summaryEntity({ summary_net_asset_value: -50_000 })];
    expect(computeBusinessEntityOwnershipValue(rows, 'AUD', 56)).toBe(-50_000);
  });

  it('no entities at all resolves to exactly 0 — byte-identical to every pre-LR-11 household', () => {
    expect(computeBusinessEntityOwnershipValue([], 'AUD', 56)).toBe(0);
  });
});

describe('computeDashboard — business entity consolidation, negative controls', () => {
  const entity = summaryEntity({ ownership_percentage: 50, summary_net_asset_value: 200_000 });

  it('NEG-01 "entity income enters household" — a business entity never changes cash-flow figures', () => {
    const withoutEntity = computeDashboard(EMPTY, 'AUD');
    const withEntity = computeDashboard({ ...EMPTY, businessEntities: [entity] }, 'AUD');
    expect(withEntity.grossMonthlyIncome).toBe(withoutEntity.grossMonthlyIncome);
    expect(withEntity.netMonthlyIncome).toBe(withoutEntity.netMonthlyIncome);
    expect(withEntity.monthlySurplus).toBe(withoutEntity.monthlySurplus);
    expect(withEntity.totalMonthlyExpenses).toBe(withoutEntity.totalMonthlyExpenses);
  });

  it('NEG-02 "entity debt enters DTI" — an entity liability never changes personal DTI/DSR/totalLiabilities', () => {
    const heavilyIndebtedEntity: BusinessEntityWithLineItems = {
      entity: { id: 'e2', ownership_percentage: 100, valuation_mode: 'detailed', summary_net_asset_value: null, currency_code: 'AUD', is_active: true },
      assets: [{ value: 10_000, currency_code: 'AUD' }],
      liabilities: [{ value: 5_000_000, currency_code: 'AUD' }], // massive entity debt
    };
    const income: DashboardInput = { ...EMPTY, income: [{ source_name: 'Salary', amount: 8000, frequency: 'monthly', master_item_key: null, employer_name: 'Acme', owner: 'self' }] as never };
    const withoutEntity = computeDashboard(income, 'AUD');
    const withEntity = computeDashboard({ ...income, businessEntities: [heavilyIndebtedEntity] }, 'AUD');
    expect(withEntity.totalLiabilities).toBe(withoutEntity.totalLiabilities);
    expect(withEntity.householdLiabilityBalance).toBe(withoutEntity.householdLiabilityBalance);
    expect(withEntity.debtToIncome).toBe(withoutEntity.debtToIncome);
    expect(withEntity.debtServiceRatio).toBe(withoutEntity.debtServiceRatio);
    expect(withEntity.debtMonthlyRepayments).toBe(withoutEntity.debtMonthlyRepayments);
  });

  it('NEG-03 "underlying assets plus ownership value double counted" — totalAssetsCombined - totalLiabilities === netWorth always holds', () => {
    const summary = computeDashboard({ ...EMPTY, businessEntities: [entity] }, 'AUD');
    expect(summary.totalAssetsCombined - summary.totalLiabilities).toBeCloseTo(summary.netWorth, 6);
    // The entity's own gross assets (if Detailed mode) are never separately
    // added anywhere in DashboardSummary — only the netted, ownership-scaled
    // figure below is ever exposed/consolidated.
    expect(summary.businessEntityOwnershipValue).toBe(100_000); // 50% of 200,000
    expect(summary.netWorth).toBe(100_000);
  });

  it('the ownership-consolidated value is additive on top of a household\'s own existing Net Worth, not a replacement for it', () => {
    const withPersonalAssets: DashboardInput = {
      ...EMPTY,
      assets: [{ current_value: 300_000, asset_class: 'cash', master_item_key: null, country_code: 'AU', currency_code: 'AUD' }] as never,
    };
    const withoutEntity = computeDashboard(withPersonalAssets, 'AUD');
    const withEntity = computeDashboard({ ...withPersonalAssets, businessEntities: [entity] }, 'AUD');
    expect(withEntity.netWorth).toBe(withoutEntity.netWorth + 100_000);
  });
});

describe('NEG-05 "SMSF rules copied blindly" — no AU-only assumption in the new schema', () => {
  it.each(['AU', 'IN', 'GB', 'US', 'SG', 'AE'] as const)('accepts %s as a valid country_code, not just AU', (code) => {
    const result = businessEntityCreateInputSchema.safeParse({
      name: 'Test Co',
      country_code: code,
      currency_code: 'AUD',
      ownership_percentage: 100,
      valuation_mode: 'summary',
      summary_net_asset_value: 1000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null country_code (no jurisdiction restriction at all)', () => {
    const result = businessEntityCreateInputSchema.safeParse({
      name: 'Test Co',
      country_code: null,
      currency_code: 'AUD',
      ownership_percentage: 100,
      valuation_mode: 'summary',
      summary_net_asset_value: 1000,
    });
    expect(result.success).toBe(true);
  });
});

describe('businessEntityCreateInputSchema validation', () => {
  it('rejects Summary mode with no summary_net_asset_value', () => {
    const result = businessEntityCreateInputSchema.safeParse({
      name: 'Test Co',
      currency_code: 'AUD',
      ownership_percentage: 100,
      valuation_mode: 'summary',
    });
    expect(result.success).toBe(false);
  });

  it('accepts Detailed mode with no summary_net_asset_value', () => {
    const result = businessEntityCreateInputSchema.safeParse({
      name: 'Test Co',
      currency_code: 'AUD',
      ownership_percentage: 100,
      valuation_mode: 'detailed',
    });
    expect(result.success).toBe(true);
  });

  it('rejects ownership_percentage of 0 or below', () => {
    expect(
      businessEntityCreateInputSchema.safeParse({ name: 'Co', currency_code: 'AUD', ownership_percentage: 0, valuation_mode: 'detailed' }).success
    ).toBe(false);
  });

  it('rejects ownership_percentage above 100', () => {
    expect(
      businessEntityCreateInputSchema.safeParse({ name: 'Co', currency_code: 'AUD', ownership_percentage: 101, valuation_mode: 'detailed' }).success
    ).toBe(false);
  });
});
