import { describe, it, expect } from 'vitest';
import { sumRetirementBalanceExcludingContributions } from '@/lib/services/forecastData';

// lib/engines/dashboard.ts's totalRetirement fix (Chunk 3b,
// isRetirementContributionRow — tests/unit/dashboard.test.ts's "Class-F
// retirement contribution-row exclusion" suite) excludes the 6 Class-F
// contribution-type retirement_accounts rows (employer_contributions,
// salary_sacrifice, personal_concessional, non_concessional,
// government_co_contribution, spouse_contribution) from being summed as
// phantom balances. That fix only ever landed in dashboard.ts's own
// computeDashboard reducer — forecastData.ts's three retirement_accounts
// queries that go around loadDashboard() (the cross-border forecast input,
// the retirement forecast input, and the cross-border variance actual) each
// re-implemented the raw `reduce((sum, r) => sum + r.current_balance, 0)`
// independently and never got the same exclusion. This is the same live
// phantom-balance double-count defect, unfixed on those three paths, now
// closed by reusing the canonical dashboard.ts predicate via
// sumRetirementBalanceExcludingContributions so the two can never drift
// apart again.
describe('sumRetirementBalanceExcludingContributions (Forecasting phantom-balance fix)', () => {
  it('does NOT double-count a Class-F contribution-type row as a real balance', () => {
    const rows = [
      { current_balance: 200000, master_item_key: 'industry_super' }, // the real account
      { current_balance: 12000, master_item_key: 'employer_contributions' }, // phantom balance, per dashboard.ts's worked example
    ];
    // Before this fix: 212000 (200000 + 12000) — the same phantom-balance
    // shape Chunk 3b found and fixed in dashboard.ts.
    expect(sumRetirementBalanceExcludingContributions(rows)).toBe(200000);
  });

  it('excludes all 6 Class-F contribution keys, not just one', () => {
    const contributionKeys = [
      'employer_contributions',
      'salary_sacrifice',
      'personal_concessional',
      'non_concessional',
      'government_co_contribution',
      'spouse_contribution',
    ];
    const rows = contributionKeys.map((key) => ({ current_balance: 5000, master_item_key: key }));
    expect(sumRetirementBalanceExcludingContributions(rows)).toBe(0);
  });

  it('a row with no master_item_key (custom row) is never excluded — only the 6 named catalogue keys are', () => {
    const rows = [{ current_balance: 50000, master_item_key: null }];
    expect(sumRetirementBalanceExcludingContributions(rows)).toBe(50000);
  });

  it('a legacy row saved before catalogue deprecation (migration 0073) is corrected immediately — keys off master_item_key, not is_active', () => {
    const rows = [
      { current_balance: 100000, master_item_key: 'smsf' },
      { current_balance: 6000, master_item_key: 'salary_sacrifice' },
    ];
    expect(sumRetirementBalanceExcludingContributions(rows)).toBe(100000);
  });

  it('applies the exclusion BEFORE the optional per-row value transform (e.g. the retirement forecast input\'s FX conversion)', () => {
    // Mirrors forecastData.ts's retirement-forecast-input call site, which
    // passes a currency-converting valueOf callback instead of reading
    // current_balance directly. A ~2x rate makes it obvious if the excluded
    // row's balance leaked through the conversion step.
    const rows = [
      { current_balance: 100000, currency_code: 'AUD', master_item_key: 'industry_super' },
      { current_balance: 50000, currency_code: 'INR', master_item_key: 'employer_contributions' }, // should never reach valueOf's conversion
    ];
    const toAud = (r: (typeof rows)[number]) => (r.currency_code === 'INR' ? r.current_balance / 56 : r.current_balance);
    expect(sumRetirementBalanceExcludingContributions(rows, toAud)).toBe(100000);
  });

  it('a mix of currencies converts and sums correctly once contribution rows are excluded', () => {
    const rows = [
      { current_balance: 216600, currency_code: 'AUD', master_item_key: 'industry_super' },
      { current_balance: 1_100_000, currency_code: 'INR', master_item_key: 'other_retirement_assets' },
      { current_balance: 12000, currency_code: 'AUD', master_item_key: 'salary_sacrifice' }, // excluded
    ];
    const fxRateAudInr = 56;
    const toAud = (r: (typeof rows)[number]) => (r.currency_code === 'INR' ? r.current_balance / fxRateAudInr : r.current_balance);
    // 216600 + (1,100,000 / 56) = 216600 + 19642.857... ≈ 236242.86, and never 248,242.86 (i.e. +12000 phantom).
    expect(sumRetirementBalanceExcludingContributions(rows, toAud)).toBeCloseTo(236242.857, 2);
  });

  it('an empty row set sums to zero, not NaN or a thrown error', () => {
    expect(sumRetirementBalanceExcludingContributions([])).toBe(0);
  });
});

// Confirms the fix is scoped to the BALANCE figure only — dashboard.ts's own
// retirementEmployerMonthlyContribution/retirementPersonalMonthlyContribution
// (lib/engines/dashboard.ts:715-729) deliberately still sum a Class-F row's
// contribution fields unfiltered, because the contribution itself is real;
// only its current_balance is the phantom double-count. forecastData.ts's
// three call sites replicate this same "flow" reduce unchanged (not
// filtered through sumRetirementBalanceExcludingContributions) — this test
// reproduces that exact reduce shape standalone to prove a Class-F row's
// contribution still counts even though its balance is now excluded.
describe('retirement contribution FLOW fields stay unfiltered (unchanged by this fix)', () => {
  const CONTRIBUTION_FREQUENCY_TO_MONTHLY: Record<string, number> = {
    weekly: 52 / 12,
    fortnightly: 26 / 12,
    monthly: 1,
    quarterly: 1 / 3,
    annually: 1 / 12,
  };

  it('a Class-F row\'s employer/personal contribution is still counted in the monthly-contribution total', () => {
    const rows = [
      { current_balance: 200000, employer_contribution: 500, personal_contribution: null, contribution_frequency: 'monthly', master_item_key: 'industry_super' },
      { current_balance: 12000, employer_contribution: 1000, personal_contribution: null, contribution_frequency: 'monthly', master_item_key: 'employer_contributions' },
    ];
    const balance = sumRetirementBalanceExcludingContributions(rows);
    const monthlyContribution = rows.reduce((sum, r) => {
      const factor = CONTRIBUTION_FREQUENCY_TO_MONTHLY[r.contribution_frequency ?? 'monthly'] ?? 1;
      return sum + ((r.employer_contribution ?? 0) + (r.personal_contribution ?? 0)) * factor;
    }, 0);
    expect(balance).toBe(200000); // the Class-F row's balance is excluded
    expect(monthlyContribution).toBe(1500); // but its contribution flow (500 + 1000) is not
  });
});
