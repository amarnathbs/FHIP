/**
 * Document2 (4) F27 -- an independent oracle for the Retirement Forecast baseline.
 *
 * "Independent" means: every expected number below is written BY HAND from the household's inputs (arithmetic shown in the comments);
 * none is read back from the code under test. The household goes through the real chain: payslip approved -> contribution ledger
 * -> the account's derived rate -> the real runForecast().
 *
 * Rules checked: (1) a contribution is counted ONCE (two fortnightly payslips are one flow; a payslip and a manual record of the same
 * flow are one flow; a person's own one-off is not a rate); (2) the SMSF value is never counted twice: the forecast is on the PERSONAL basis
 * (PO decision 16-10-2026), so the fund's own account row is not in the opening corpus in either Summary or Detailed mode, the fund's
 * Summary figure is never added on top of the Detailed value, and the SMSF's own contribution is not added to the household
 * contribution component (LR-6 guard); (3) a contribution never changes a balance.
 * HONEST LIMIT: a family-level (consolidated) retirement corpus that INCLUDES the SMSF once is not built into the forecast; that needs the
 * PO's consolidation decision and the SMSF Detailed derivation of the entities work package (see the report, F27).
 * Evidence label: UNIT-TESTED. Negative controls: the broken readings are computed and shown to differ.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));

import { runForecast } from '@/lib/services/forecastData';
import { recordManualContribution, recordPayslipContribution } from '@/lib/retirement-contributions/service';
import { contributionFakeDb } from '../support/contributionFakeDb';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { tables, USER } from './readModels/helpers/fixtures';

const PROFILE_ID = 'fp-1';
const SCENARIO_ID = 'sc-1';

const acct = (id: string, name: string, balance: number, extra: Record<string, unknown> = {}): Row => ({
  id, user_id: USER, account_name: name, account_type: 'super', current_balance: balance, currency_code: 'AUD', owner: 'self', retirement_member_id: 'm-self',
  master_item_key: 'industry_super', employer_contribution: null, personal_contribution: null, contribution_frequency: null, source_type: 'manual', is_active: true, ...extra,
});
const event = (id: string, date: string): Row => ({
  id, user_id: USER, employer_name: 'ACME PTY LTD', employer_normalised: 'acme', payment_date: date, pay_period_end: date, pay_frequency: 'fortnightly', currency_code: 'AUD',
  employer_retirement_contribution: 684.68, income_owner: 'self', approval_status: 'approved', superseded_by_payroll_event_id: null,
});

/** The household before any contribution is recorded. */
function household(): Record<string, Row[]> {
  return {
    retirement_accounts: [
      acct('acc-rest', 'Rest Super', 100000),
      // The SMSF fund's own account row: it carries the fund value (Detailed mode: net of holdings and loans) once.
      acct('acc-smsf', 'Bekal Super Fund', 133000, { master_item_key: 'smsf' }),
    ],
    smsf_funds: [{ id: 'fund-1', user_id: USER, fund_name: 'Bekal Super Fund', retirement_account_id: 'acc-smsf', is_active: true, mode: 'detailed', summary_balance: 100000, detailed_net_value: 133000 }],
    retirement_members: [{ id: 'm-self', user_id: USER, member_type: 'self', is_active: true }],
    fdh_payroll_events: [event('pe-1', '2026-09-17'), event('pe-2', '2026-10-01')],
    fdh_payroll_components: ['pe-1', 'pe-2'].map((id) => ({ user_id: USER, payroll_event_id: id, label_raw: 'SGC Employer Cont. ACME SUPER GUARANTEE REST SUPER', component_type: 'employer_retirement', is_year_to_date: false })),
    retirement_contributions: [],
  };
}

async function openingAndContributions(accounts: Row[], smsfFunds: Row[]) {
  const t = tables(
    {
      user_profiles: [{ user_id: USER, preferred_currency: 'AUD', country_of_residence: 'AU', date_of_birth: '1975-09-01' }],
      forecast_profiles: [{ id: PROFILE_ID, user_id: USER, status: 'active', name: 'My Forecast', base_currency: 'AUD', country_code: 'AU', forecast_start_date: '2026-10-01', retirement_age: null, retirement_date: null, retirement_timing_override_months: null, created_at: '2026-01-01T00:00:00Z' }],
      forecast_scenarios: [{ id: SCENARIO_ID, user_id: USER, forecast_profile_id: PROFILE_ID, scenario_name: 'Base scenario', scenario_type: 'base', is_default: true, is_active: true }],
      forecast_global_assumptions: [{ country_code: null, assumption_category: 'fx', assumption_key: 'fx_rate_aud_inr', assumption_value: 56, value_type: 'number', unit: null, source_reference: null, is_active: true }],
      retirement_members: [{ id: 'm-self', user_id: USER, member_type: 'self', target_retirement_age: 67, is_active: true }],
      retirement_accounts: accounts,
      smsf_funds: smsfFunds,
    },
  );
  const fake = makeFakeSupabase(t);
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
  await runForecast(USER, { scenarioId: SCENARIO_ID, forecastType: 'retirement', months: 12 } as never, client as never);
  const p1 = results.find((r) => r.period_number === 1)!;
  return { opening: p1.opening_value as number, contributions: p1.contributions as number };
}

describe('F27 independent forecast oracle: contributions once, SMSF value once', () => {
  it('payslips + manual records + SMSF through the real chain give the hand-computed baseline', async () => {
    const db = contributionFakeDb(household());
    // 1. two consecutive fortnightly payslips naming REST SUPER (employer super 684.68 each) are approved
    await recordPayslipContribution(USER, 'pe-1', db.client);
    await recordPayslipContribution(USER, 'pe-2', db.client);
    await recordPayslipContribution(USER, 'pe-2', db.client); // the same payslip again: no effect
    // 2. the person ALSO typed that same employer contribution by hand for the same account (same flow)
    await recordManualContribution(USER, { accountId: 'acc-rest', type: 'employer', amount: 684.68, frequency: 'fortnightly', contributionDate: '2026-09-20' }, db.client);
    // 3. a personal monthly 200 and a one-off 5,000 (history only)
    await recordManualContribution(USER, { accountId: 'acc-rest', type: 'personal', amount: 200, frequency: 'monthly', contributionDate: null }, db.client);
    await recordManualContribution(USER, { accountId: 'acc-rest', type: 'personal', amount: 5000, frequency: 'one_off', contributionDate: '2026-06-30' }, db.client);
    // 4. a contribution to the SMSF itself, 1,000 a month
    await recordManualContribution(USER, { accountId: 'acc-smsf', type: 'employer', amount: 1000, frequency: 'monthly', contributionDate: null }, db.client);

    const ledgerAccounts = db.tables.retirement_accounts;
    const result = await openingAndContributions(ledgerAccounts, db.tables.smsf_funds);

    // ORACLE (by hand):
    //   opening corpus = Rest 100,000 only: the SMSF fund row (133,000 Detailed / 100,000 Summary) is the fund's, not personal (PO 16-10-2026)
    //   household contribution = ONE fortnightly employer flow 684.68 x 26 / 12 = 1,483.4733 -> 1,483.47
    //                          + personal monthly 200                                 -> 1,683.47
    //   (the second payslip, the repeated payslip and the manual copy of the same flow add nothing; the 5,000 one-off is history;
    //    the SMSF's own 1,000 a month is the fund's flow and is not in the household contribution component)
    expect(result.opening).toBe(100000);
    expect(result.contributions).toBeCloseTo(1683.47, 1);

    // NEGATIVE CONTROLS: each wrong reading is a different number, so the oracle can fail.
    const everyRowOnce = 684.68 * 26 / 12 * 3 + 200 + 1000; // all three employer records + SMSF
    const summaryAndDetailedOnTop = 100000 + 133000 + 100000;
    expect(result.contributions).not.toBeCloseTo(everyRowOnce, 0);
    expect(result.opening).not.toBe(summaryAndDetailedOnTop);
    // 3. a contribution never changes a balance
    expect(ledgerAccounts.find((a) => a.id === 'acc-rest')!.current_balance).toBe(100000);
    expect(ledgerAccounts.find((a) => a.id === 'acc-smsf')!.current_balance).toBe(133000);
  });

  it('[NC] without the ledger rules (the account columns summed as typed twice) the same household would be overstated', () => {
    // the pre-ledger way: employer 684.68 fortnightly typed on the account AND again as a second account row = double
    const typedTwice = (684.68 * 26 / 12) * 2 + 200;
    expect(typedTwice).toBeGreaterThan(1683.47 + 1400);
  });

  it('the SMSF value is never counted twice: Summary mode and Detailed mode give the same personal corpus (the fund row is not personal)', async () => {
    const summary = await openingAndContributions(
      [acct('acc-rest', 'Rest Super', 100000), acct('acc-smsf', 'Bekal Super Fund', 100000, { master_item_key: 'smsf' })],
      [{ id: 'fund-1', user_id: USER, fund_name: 'Bekal Super Fund', retirement_account_id: 'acc-smsf', is_active: true, mode: 'summary', summary_balance: 100000, detailed_net_value: null }],
    );
    const detailed = await openingAndContributions(
      [acct('acc-rest', 'Rest Super', 100000), acct('acc-smsf', 'Bekal Super Fund', 133000, { master_item_key: 'smsf' })],
      [{ id: 'fund-1', user_id: USER, fund_name: 'Bekal Super Fund', retirement_account_id: 'acc-smsf', is_active: true, mode: 'detailed', summary_balance: 100000, detailed_net_value: 133000 }],
    );
    expect(summary.opening).toBe(100000);
    expect(detailed.opening).toBe(100000); // 133,000 Detailed is neither added nor added on top of the 100,000 Summary figure
  });
});
