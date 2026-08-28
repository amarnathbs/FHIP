// G0-JA-1 Wave 1 — JA-D2 defect fix: lib/engines/resilienceStress.ts's
// 'currency_shock' scenario used to derive "home country" from the
// household's preferred/reporting currency (`d.currency === 'AUD' ? 'AU' :
// 'IN'`) instead of the caller's actual, already-resolved
// country_of_residence. A household's currency is an independent,
// currency-only concept (01-canonical-architecture.md §7/§8) — a household
// can legitimately hold AUD while resident in India, or vice versa, which
// is exactly the scenario the old line silently mishandled by inverting or
// over-broadening which holdings counted as "foreign".
//
// This suite drives the REAL exported applyStressScenario() against REAL
// DashboardSummary fixtures built via computeDashboard() (not a hand-rolled
// stub), so every assertion below exercises the same code path production
// traffic does.
import { describe, it, expect } from 'vitest';
import { computeDashboard, type DashboardInput, type InvestmentRow } from '@/lib/engines/dashboard';
import { applyStressScenario } from '@/lib/engines/resilienceStress';

const EMPTY_INPUT: DashboardInput = {
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

// One AU-domiciled investment (100,000) and one IN-domiciled investment
// (50,000) — deliberately unequal so a wrong home/foreign split produces a
// materially different (not just differently-labelled) shock loss.
// currency_code is deliberately left null on both rows (rather than tagged
// 'AUD'/'INR' to match country_code) — this is the whole point of the fix
// under test: a row's country and its currency are independent concepts,
// and null currency_code means computeDashboard's own reportingValue()
// leaves current_value unconverted, keeping this fixture's expected numbers
// simple and currency-parameter-independent.
function investmentsFixture(): InvestmentRow[] {
  return [
    { current_value: 100_000, cost_base: 100_000, investment_type: 'shares', master_item_key: 'international_shares', country_code: 'AU', annual_contribution: 0, currency_code: null },
    { current_value: 50_000, cost_base: 50_000, investment_type: 'shares', master_item_key: 'domestic_shares', country_code: 'IN', annual_contribution: 0, currency_code: null },
  ];
}

function buildDashboard(currency: 'AUD' | 'INR') {
  return computeDashboard({ ...EMPTY_INPUT, investments: investmentsFixture() }, currency);
}

describe('applyStressScenario — currency_shock home-country resolution (JA-D2)', () => {
  it('positive AU test: confirmed-AU resident with AUD currency (the common, currently-passing case) — foreign = the IN holding, loss = 50,000 * 10%', () => {
    const d = buildDashboard('AUD');
    const result = applyStressScenario(d, 'currency_shock', [], {}, 'AU');
    // Foreign (non-AU) holding is the 50,000 IN position.
    expect(d.totalInvestments - result.shockedDashboard.totalInvestments).toBeCloseTo(5_000, 5);
  });

  it('positive IN test: confirmed-IN resident with INR currency (the common, currently-passing case) — foreign = the AU holding, loss = 100,000 * 10%', () => {
    const d = buildDashboard('INR');
    const result = applyStressScenario(d, 'currency_shock', [], {}, 'IN');
    // Foreign (non-IN) holding is the 100,000 AU position.
    expect(d.totalInvestments - result.shockedDashboard.totalInvestments).toBeCloseTo(10_000, 5);
  });

  it('mismatch regression test 1: AU-resident household reporting in INR — corrected split follows residence, not currency', () => {
    // Old defect: d.currency === 'AUD' ? 'AU' : 'IN' would see currency
    // 'INR' and wrongly conclude home country 'IN', treating the AU holding
    // as "foreign" (loss 10,000) even though the household actually lives
    // in AU and the AU holding is their HOME holding.
    const d = buildDashboard('INR');
    const result = applyStressScenario(d, 'currency_shock', [], {}, 'AU');
    const loss = d.totalInvestments - result.shockedDashboard.totalInvestments;
    // Corrected: home = AU (real residence), foreign = the 50,000 IN holding.
    expect(loss).toBeCloseTo(5_000, 5);
    // Proves the split is no longer inverted by currency: the old
    // currency-derived answer for this exact fixture would have been 10,000.
    expect(loss).not.toBeCloseTo(10_000, 5);
  });

  it('mismatch regression test 2: IN-resident household reporting in AUD — corrected split follows residence, not currency', () => {
    // Old defect: currency 'AUD' would wrongly conclude home country 'AU',
    // treating the IN holding as "foreign" (loss 5,000) even though the
    // household actually lives in India.
    const d = buildDashboard('AUD');
    const result = applyStressScenario(d, 'currency_shock', [], {}, 'IN');
    const loss = d.totalInvestments - result.shockedDashboard.totalInvestments;
    // Corrected: home = IN (real residence), foreign = the 100,000 AU holding.
    expect(loss).toBeCloseTo(10_000, 5);
    expect(loss).not.toBeCloseTo(5_000, 5);
  });

  it('unresolved-country negative control: never guesses AU or IN from currency — skips the home/foreign split entirely (no fabricated loss)', () => {
    const d = buildDashboard('AUD');
    const result = applyStressScenario(d, 'currency_shock', [], {}, null);
    // No holding can be honestly labelled "foreign" relative to an unknown
    // home, so totalInvestments must be completely unaffected by this
    // scenario — not the old code's silent AU-shaped guess (which, for this
    // AUD fixture, would have produced a 5,000 loss against the IN holding).
    expect(result.shockedDashboard.totalInvestments).toBe(d.totalInvestments);
  });

  it('unresolved-country + IN-currency negative control: same fail-closed behaviour regardless of which currency is set', () => {
    const d = buildDashboard('INR');
    const result = applyStressScenario(d, 'currency_shock', [], {}, null);
    expect(result.shockedDashboard.totalInvestments).toBe(d.totalInvestments);
  });

  it('default parameter (no homeCountry argument at all) behaves identically to explicit null — every pre-existing caller that has not yet been updated fails closed, not AU-shaped', () => {
    const d = buildDashboard('AUD');
    // Deliberately omitting the new 5th parameter (it defaults to `null`) to
    // prove every existing/unmigrated call site fails closed automatically,
    // rather than needing every caller to be updated to stay safe.
    const result = applyStressScenario(d, 'currency_shock', []);
    expect(result.shockedDashboard.totalInvestments).toBe(d.totalInvestments);
  });

  it('other stress scenarios are completely unaffected by the new parameter (rollback-boundary check: only currency_shock reads homeCountry)', () => {
    const dAU = buildDashboard('AUD');
    const withCountry = applyStressScenario(dAU, 'income_falls_pct', [], {}, 'AU');
    const withoutCountry = applyStressScenario(dAU, 'income_falls_pct', [], {}, null);
    expect(withCountry.shockedDashboard.grossMonthlyIncome).toBe(withoutCountry.shockedDashboard.grossMonthlyIncome);
    expect(withCountry.after.monthlySurplus).toBe(withoutCountry.after.monthlySurplus);
  });
});
