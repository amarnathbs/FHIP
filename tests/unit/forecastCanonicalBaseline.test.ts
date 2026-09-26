/**
 * WP-05 (DC-13 / DC-14 / DC-18 / GAP-RET-02): the forecast reads its baseline
 * through the canonical register loaders and rules.
 *
 * Black-box: the REAL runForecast() / getForecastVariance() run against the
 * PostgREST-shaped fake (1000-row cap enforced). forecast_runs /
 * forecast_results writes are captured instead of stored, so the test reads
 * the exact period-1 baseline the calculators were given.
 *
 * NEGATIVE CONTROL (base branch feature/canonical-upload-foundation f79374f):
 * a NULL contribution frequency was projected as MONTHLY, a USD account was
 * summed as if it were the reporting currency, 1,001-row registers were cut
 * to 1,000, goal variance added INR to AUD, and a failed goals read became an
 * "actual" of 0 -- each `it` marked [NC] fails there.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));

import { getForecastVariance, runForecast } from '@/lib/services/forecastData';
import { makeFakeSupabase, type FakeSupabaseOptions, type Row } from './readModels/helpers/fakeSupabase';
import { liability, tables, USER } from './readModels/helpers/fixtures';

const PROFILE_ID = 'fp-1';
const SCENARIO_ID = 'sc-1';

function forecastTables(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return tables(
    {
      user_profiles: [{ user_id: USER, preferred_currency: 'AUD', country_of_residence: 'AU', date_of_birth: null }],
      forecast_profiles: [{
        id: PROFILE_ID, user_id: USER, status: 'active', name: 'My Forecast', base_currency: 'AUD', country_code: 'AU',
        forecast_start_date: '2026-09-01', retirement_age: null, retirement_date: null, retirement_timing_override_months: null, created_at: '2026-01-01T00:00:00Z',
      }],
      forecast_scenarios: [{ id: SCENARIO_ID, user_id: USER, forecast_profile_id: PROFILE_ID, scenario_name: 'Base scenario', scenario_type: 'base', is_default: true, is_active: true }],
      forecast_global_assumptions: [
        { country_code: null, assumption_category: 'fx', assumption_key: 'fx_rate_aud_inr', assumption_value: 56, value_type: 'number', unit: null, source_reference: null, is_active: true },
      ],
    },
    extra,
  );
}

/** The fake, plus capture of the forecast write path (runs / results / explanations). */
function forecastClient(t: Record<string, Row[]>, options: FakeSupabaseOptions = {}) {
  const fake = makeFakeSupabase(t, options);
  const results: Row[] = [];
  const runsBuilder = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b, eq: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: (row: Row) => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'run-1', ...row }, error: null }) }) }),
      update: (patch: Row) => ({
        eq: () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p: any = Promise.resolve({ error: null });
          p.select = () => ({ single: () => Promise.resolve({ data: { id: 'run-1', ...patch }, error: null }) });
          return p;
        },
      }),
    };
    return b;
  };
  const client = {
    from(table: string) {
      if (table === 'forecast_runs') return runsBuilder();
      if (table === 'forecast_results') return { insert: (rows: Row[]) => { results.push(...rows); return Promise.resolve({ error: null }); } };
      if (table === 'forecast_explanations') return { insert: () => Promise.resolve({ error: null }) };
      return fake.client.from(table);
    },
  };
  return { client, results };
}

async function period1(forecastType: 'retirement' | 'debt' | 'investment' | 'cross_border', t: Record<string, Row[]>) {
  const { client, results } = forecastClient(t);
  await runForecast(USER, { scenarioId: SCENARIO_ID, forecastType, months: 12 }, client as never);
  return results.filter((r) => r.period_number === 1);
}

const retirementRow = (id: string, extra: Row = {}): Row => ({
  id, user_id: USER, account_name: `Super ${id}`, account_type: 'super', current_balance: 100000, currency_code: 'AUD', owner: 'self',
  employer_contribution: 1500, personal_contribution: 0, contribution_frequency: 'monthly', source_type: 'manual', retirement_member_id: null, is_active: true, ...extra,
});

describe('WP-05 forecast baseline: Household M and Household I are equal', () => {
  it('retirement: manual monthly 1,500 (M) and an imported annual 18,000 applied with frequency (I) give the same baseline', async () => {
    const m = await period1('retirement', forecastTables({ retirement_accounts: [retirementRow('r-m')] }));
    const i = await period1('retirement', forecastTables({ retirement_accounts: [retirementRow('r-i', { employer_contribution: 18000, contribution_frequency: 'annually', source_type: 'retirement_statement_import' })] }));
    expect(m[0].opening_value).toBe(100000);
    expect(m[0].contributions).toBe(1500);
    expect(i[0].opening_value).toBe(m[0].opening_value);
    expect(i[0].contributions).toBe(m[0].contributions);
  });

  it('debt: a manual loan (M) and the same loan Applied from a statement (I) give the same baseline', async () => {
    const loan = { liability_name: 'Car loan', debt_type: 'car_loan', master_item_key: 'car_loan', balance: 20000, monthly_repayment: 600, interest_rate: 7 };
    const m = await period1('debt', forecastTables({ liabilities: [liability('l-m', loan)] }));
    const i = await period1('debt', forecastTables({ liabilities: [liability('l-m', { ...loan, source_type: 'liability_statement_import' })] }));
    expect(m).toHaveLength(1);
    expect(i[0].opening_value).toBe(m[0].opening_value);
    expect(i[0].closing_value).toBe(m[0].closing_value);
  });
});

describe('WP-05 forecast inputs follow the canonical rules', () => {
  it('[NC] retirement: a NULL contribution frequency is UNKNOWN -- not projected as a monthly rate (GAP-RET-02)', async () => {
    const p = await period1('retirement', forecastTables({ retirement_accounts: [retirementRow('r-1', { employer_contribution: 12000, contribution_frequency: null })] }));
    expect(p[0].opening_value).toBe(100000);
    expect(p[0].contributions).toBe(0);
  });

  it('[NC] retirement: a USD account is left out, never added as if it were AUD', async () => {
    const p = await period1('retirement', forecastTables({ retirement_accounts: [retirementRow('r-aud'), retirementRow('r-usd', { currency_code: 'USD', current_balance: 900000, employer_contribution: 0 })] }));
    expect(p[0].opening_value).toBe(100000);
  });

  it('retirement: an INR account is converted at the scenario FX assumption before summing', async () => {
    const p = await period1('retirement', forecastTables({ retirement_accounts: [retirementRow('r-aud', { employer_contribution: 0 }), retirementRow('r-inr', { currency_code: 'INR', current_balance: 5600000, employer_contribution: 0 })] }));
    expect(p[0].opening_value).toBe(200000);
  });

  it('[NC] retirement: 1,001 accounts are all counted (no 1000-row truncation)', async () => {
    const rows = Array.from({ length: 1001 }, (_, n) => retirementRow(`r-${String(n).padStart(5, '0')}`, { current_balance: 1, employer_contribution: 0 }));
    const p = await period1('retirement', forecastTables({ retirement_accounts: rows }));
    expect(p[0].opening_value).toBe(1001);
  });

  it('[NC] debt: 1,001 liabilities are all projected', async () => {
    const rows = Array.from({ length: 1001 }, (_, n) => liability(`l-${String(n).padStart(5, '0')}`, { balance: 100, monthly_repayment: 10, interest_rate: 5 }));
    const p = await period1('debt', forecastTables({ liabilities: rows }));
    expect(new Set(p.map((r) => r.entity_id)).size).toBe(1001);
  });

  it('[NC] investment: 1,001 holdings are all projected', async () => {
    const rows = Array.from({ length: 1001 }, (_, n) => ({
      id: `inv-${String(n).padStart(5, '0')}`, user_id: USER, investment_name: `H${n}`, investment_type: 'etf', current_value: 10, currency_code: 'AUD', owner: 'self',
      master_item_key: 'etf', source_type: 'manual', ii_canonical_account_id: null, ii_canonical_instrument_id: null, country_code: 'AU', annual_contribution: 0, is_active: true,
    }));
    const p = await period1('investment', forecastTables({ investments: rows }));
    expect(new Set(p.map((r) => r.entity_id)).size).toBe(1001);
  });

  it('[NC] cross-border: 1,001 foreign (INR) assets are all in the foreign leg', async () => {
    const rows = Array.from({ length: 1001 }, (_, n) => ({
      id: `a-${String(n).padStart(5, '0')}`, user_id: USER, asset_name: `A${n}`, asset_class: 'cash', current_value: 56, currency_code: 'INR', owner: 'self',
      master_item_key: 'savings_account', source_type: 'manual', linked_liability_id: null, country_code: 'IN', is_active: true,
    }));
    const { client } = forecastClient(forecastTables({ assets: rows }));
    const v = await getForecastVariance(USER, PROFILE_ID, SCENARIO_ID, 'cross_border', '2026-09-27', client as never);
    // 1,001 x INR 56 = INR 56,056 = AUD 1,001 at 56.
    expect(v.actualTillDate).toBe(1001);
  });
});

describe('WP-05 forecast variance', () => {
  const goals = (): Row[] => [
    { id: 'g-aud', user_id: USER, status: 'active', goal_name: 'House deposit', current_amount: 10000, target_amount: 50000, currency_code: 'AUD' },
    { id: 'g-inr', user_id: USER, status: 'active', goal_name: 'India education', current_amount: 560000, target_amount: 2800000, currency_code: 'INR' },
  ];

  it('[NC] goal variance converts each goal to the reporting currency BEFORE summing (DC-13)', async () => {
    const { client } = forecastClient(forecastTables({ user_goals: goals() }));
    const v = await getForecastVariance(USER, PROFILE_ID, SCENARIO_ID, 'goal', '2026-09-27', client as never);
    // AUD 10,000 + INR 560,000 (= AUD 10,000) = AUD 20,000; targets 50,000 + 50,000.
    expect(v.actualTillDate).toBe(20000);
    expect(v.finalTarget).toBe(100000);
  });

  it('[NC] a failed goals read is "unavailable" -- never an actual of 0 (DC-14)', async () => {
    const { client } = forecastClient(forecastTables({ user_goals: goals() }), { failOn: new Set(['user_goals']) });
    const v = await getForecastVariance(USER, PROFILE_ID, SCENARIO_ID, 'goal', '2026-09-27', client as never);
    expect(v.status).toBe('unavailable');
    expect(v.actualTillDate).toBeNull();
    expect(v.varianceAmount).toBeNull();
  });

  it('[NC] a failed cross-border register read is "unavailable" -- never a net foreign wealth of 0', async () => {
    const { client } = forecastClient(forecastTables(), { failOn: new Set(['liabilities']) });
    const v = await getForecastVariance(USER, PROFILE_ID, SCENARIO_ID, 'cross_border', '2026-09-27', client as never);
    expect(v.status).toBe('unavailable');
    expect(v.actualTillDate).toBeNull();
  });
});
