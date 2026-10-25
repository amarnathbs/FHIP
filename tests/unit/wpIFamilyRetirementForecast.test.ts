/**
 * Document2 (4) WP-I, PO-D24-01 (21-10-2026): the Family Retirement Forecast.
 *
 * The personal retirement forecast stays personal-only. A SEPARATE family view (shown only when the person has an SMSF) adds the SMSF:
 *     Family retirement position = Personal retirement + SMSF retirement economic value.
 *
 * EVERY expected number below is written BY HAND from the household's inputs (arithmetic in the comments); none is read back from the code
 * under test. The household goes through the real chain: contributions recorded through the real contribution service -> the contribution
 * ledger and the account's derived rate -> the real SMSF balance sheet loader -> the real forecast calculator.
 * Evidence label: UNIT-TESTED (in-memory PostgREST double). NOT DEV-verified, NOT production-verified, NOT seen in a browser.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));

import { runFamilyRetirementView, runForecast } from '@/lib/services/forecastData';
import { buildFamilyRetirementView } from '@/lib/engines/forecast/familyRetirement';
import { recordManualContribution } from '@/lib/retirement-contributions/service';
import { contributionFakeDb } from '../support/contributionFakeDb';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { tables, USER } from './readModels/helpers/fixtures';
import { FamilyRetirementView } from '@/components/forecast/FamilyRetirementView';
import { RetirementForecastPanel } from '@/components/forecast/RetirementForecastPanel';

const OTHER = '00000000-0000-0000-0000-0000000000u2';
const PROFILE_ID = 'fp-1';
const SCENARIO_ID = 'sc-1';

const acct = (id: string, name: string, balance: number, extra: Record<string, unknown> = {}, user = USER): Row => ({
  id, user_id: user, account_name: name, account_type: 'super', current_balance: balance, currency_code: 'AUD', owner: 'self', retirement_member_id: 'm-self',
  master_item_key: 'industry_super', employer_contribution: null, personal_contribution: null, contribution_frequency: null, source_type: 'manual', is_active: true, ...extra,
});
const fundRow = (extra: Record<string, unknown> = {}, user = USER): Row => ({
  id: 'fund-1', user_id: user, fund_name: 'Bekal Super Fund', retirement_account_id: 'acc-smsf', is_active: true, mode: 'detailed', summary_balance: null, detailed_net_value: null, currency_code: 'AUD', ...extra,
});
const holding = (id: string, name: string, value: number, type = 'residential_property', fund = 'fund-1', user = USER): Row => ({
  id, user_id: user, smsf_fund_id: fund, holding_name: name, holding_type: type, value, currency_code: 'AUD', is_active: true,
});

interface World {
  personal: Row[];
  smsfAccountBalance?: number;
  fund?: Row | null;
  holdings?: Row[];
  liabilities?: Row[];
  /** Contributions recorded through the REAL service, in order. */
  contributions?: Array<{ account: string; type: 'employer' | 'personal'; amount: number; frequency: 'monthly' | 'one_off' | 'fortnightly' | null; date?: string | null }>;
  accountOverrides?: Record<string, Record<string, unknown>>;
  extraTables?: Record<string, Row[]>;
  failOn?: string[];
}

async function build(w: World) {
  const accounts: Row[] = [...w.personal];
  if (w.fund !== null) accounts.push(acct('acc-smsf', 'Bekal Super Fund', w.smsfAccountBalance ?? 0, { master_item_key: 'smsf' }));
  for (const [id, over] of Object.entries(w.accountOverrides ?? {})) Object.assign(accounts.find((a) => a.id === id)!, over);
  const ledgerDb = contributionFakeDb({
    retirement_accounts: accounts,
    smsf_funds: w.fund === null ? [] : [w.fund ?? fundRow()],
    retirement_members: [{ id: 'm-self', user_id: USER, member_type: 'self', is_active: true }],
    retirement_contributions: [],
  });
  for (const c of w.contributions ?? []) {
    const r = await recordManualContribution(USER, { accountId: c.account, type: c.type, amount: c.amount, frequency: c.frequency, contributionDate: c.date ?? null }, ledgerDb.client);
    if (!r.ok) throw new Error(r.message);
  }
  const t = tables({
    user_profiles: [{ user_id: USER, preferred_currency: 'AUD', country_of_residence: 'AU', date_of_birth: '1975-09-01' }],
    forecast_profiles: [{ id: PROFILE_ID, user_id: USER, status: 'active', name: 'My Forecast', base_currency: 'AUD', country_code: 'AU', forecast_start_date: '2026-10-01', retirement_age: null, retirement_date: null, retirement_timing_override_months: null, created_at: '2026-01-01T00:00:00Z' }],
    forecast_scenarios: [{ id: SCENARIO_ID, user_id: USER, forecast_profile_id: PROFILE_ID, scenario_name: 'Base scenario', scenario_type: 'base', is_default: true, is_active: true }],
    forecast_global_assumptions: [{ country_code: null, assumption_category: 'fx', assumption_key: 'fx_rate_aud_inr', assumption_value: 56, value_type: 'number', unit: null, source_reference: null, is_active: true }],
    retirement_members: [{ id: 'm-self', user_id: USER, member_type: 'self', target_retirement_age: 67, is_active: true }],
    retirement_accounts: ledgerDb.tables.retirement_accounts,
    retirement_contributions: ledgerDb.tables.retirement_contributions,
    smsf_funds: ledgerDb.tables.smsf_funds,
    smsf_holdings: w.holdings ?? [],
    smsf_liabilities: w.liabilities ?? [],
    property_liability_links: [],
  }, w.extraTables ?? {});
  const fake = makeFakeSupabase(t, { failOn: new Set(w.failOn ?? []) });
  const explanations: Row[] = [];
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
      if (table === 'forecast_explanations') return { insert: (rows: Row[]) => { explanations.push(...(Array.isArray(rows) ? rows : [rows])); return Promise.resolve({ error: null }); } };
      return fake.client.from(table);
    },
  } as never;
  return { client, results, explanations, ledgerDb };
}

const family = (client: never, extra: Record<string, unknown> = {}) =>
  runFamilyRetirementView(USER, { scenarioId: SCENARIO_ID, retirementTargetMethod: 'target_corpus', retirementTargetCorpus: 2_000_000, ...extra } as never, client);

/** Future value of an opening balance and a monthly contribution over n months at 6.5 a year (the retirement assumption), contribution added before growth. */
function futureValue(opening: number, monthly: number, n: number): number {
  const g = Math.pow(1.065, 1 / 12);
  return opening * Math.pow(g, n) + (monthly * g * (Math.pow(g, n) - 1)) / (g - 1);
}

describe('PO oracle: personal super 100,000 and SMSF Detailed 400,000', () => {
  // HAND ORACLE (AUD):
  //   Personal: Rest Super 100,000.  SMSF: property 350,000 + cash 50,000 = 400,000, no fund liability, derived net 400,000.
  //   The SMSF fund account row in the Retirement register mirrors 400,000 and a leftover typed Summary figure 150,000 exists on the fund.
  //   Personal opening 100,000.  Family opening = 100,000 + 400,000 = 500,000.
  //   NOT 900,000 (= 100,000 + the fund row 400,000 + the Detailed 400,000)  and NOT 650,000 (= 500,000 + the stale Summary 150,000).
  //   Contributions: personal 1,000 a month to Rest, SMSF 2,000 a month to the fund. Personal flow 1,000. SMSF flow 2,000. Family flow 3,000.
  const baseWorld = (): World => ({
    personal: [acct('acc-rest', 'Rest Super', 100_000)],
    smsfAccountBalance: 400_000,
    fund: fundRow({ mode: 'detailed', summary_balance: 150_000, detailed_net_value: 400_000 }),
    holdings: [holding('h1', '250 Example St', 350_000), holding('h2', 'Cash account', 50_000, 'cash_account')],
    contributions: [
      { account: 'acc-rest', type: 'personal', amount: 1_000, frequency: 'monthly' },
      { account: 'acc-smsf', type: 'employer', amount: 2_000, frequency: 'monthly' },
    ],
  });

  it('opening: personal 100,000, SMSF 400,000, family 500,000 (not 900,000, not 650,000)', async () => {
    const { client } = await build(baseWorld());
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.personal.opening).toBe(100_000);
    expect(v.smsf.opening).toBe(400_000);
    expect(v.family.opening).toBe(500_000);
    // NEGATIVE CONTROLS: each wrong reading is a different number, so this oracle can fail.
    expect(v.family.opening).not.toBe(100_000 + 400_000 + 400_000);
    expect(v.family.opening).not.toBe(100_000 + 400_000 + 150_000);
  });

  it('flow: personal 1,000, SMSF 2,000, family 3,000 a month, each contribution counted once', async () => {
    const { client, ledgerDb } = await build(baseWorld());
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.personal.monthlyFlow).toBe(1_000);
    expect(v.smsf.monthlyFlow).toBe(2_000);
    expect(v.family.monthlyFlow).toBe(3_000);
    expect(v.smsf.contributionSource).toBe('ledger_and_account');
    // The real service also derived the fund account's own figure (2,000). Reading BOTH the ledger and that column would give 4,000: it must not.
    const smsfAccount = ledgerDb.tables.retirement_accounts.find((a) => a.id === 'acc-smsf')!;
    expect(smsfAccount.employer_contribution).toBe(2_000);
    expect(v.family.monthlyFlow).not.toBe(1_000 + 2_000 + 2_000);
  });

  it('the projection is the existing calculator on the combined numbers: family at retirement = hand future value, and equals personal + SMSF parts', async () => {
    const { client } = await build(baseWorld());
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    const n = v.timing.monthsUntilRetirement!;
    expect(n).toBeGreaterThanOrEqual(190); // DOB 01-09-1975, target age 67, baseline 01-10-2026: 191 months (15 years 11 months)
    expect(n).toBeLessThanOrEqual(192);
    expect(v.timing.retirementAge).toBe(67);
    expect(v.timing.retirementAgeSource).toBe('saved');
    const tol = 5; // monthly cents rounding over ~190 months
    expect(Math.abs(v.personal.balanceAtRetirement! - futureValue(100_000, 1_000, n))).toBeLessThan(tol);
    expect(Math.abs(v.smsf.balanceAtRetirement! - futureValue(400_000, 2_000, n))).toBeLessThan(tol);
    expect(Math.abs(v.family.balanceAtRetirement! - futureValue(500_000, 3_000, n))).toBeLessThan(tol);
    expect(Math.abs(v.family.balanceAtRetirement! - (v.personal.balanceAtRetirement! + v.smsf.balanceAtRetirement!))).toBeLessThan(tol);
    // Same target, so the family funds it better than the person alone.
    expect(v.family.requiredCorpus).toBe(2_000_000);
    expect(v.family.readinessPct!).toBeGreaterThan(v.personal.readinessPct!);
  });

  it('the PERSONAL forecast is unchanged: the real personal run still opens at 100,000 and flows 1,000, and equals the personal figures in the family view', async () => {
    const { client, results, explanations } = await build(baseWorld());
    await runForecast(USER, { scenarioId: SCENARIO_ID, forecastType: 'retirement', months: 12, retirementTargetMethod: 'target_corpus', retirementTargetCorpus: 2_000_000 } as never, client);
    const p1 = results.find((r) => r.period_number === 1)!;
    expect(p1.opening_value).toBe(100_000); // the SMSF fund row is not a personal balance (PO 16-10-2026)
    expect(p1.contributions).toBe(1_000); // the SMSF's 2,000 is not in the household contribution (LR-6)
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    const personalRun = (explanations[0].calculation_inputs ?? explanations[0].calculationInputs) as Record<string, number>;
    expect(v.personal.balanceAtRetirement).toBe(personalRun.balanceAtRetirement);
    expect(v.personal.requiredCorpus).toBe(personalRun.requiredCorpus);
    expect(v.personal.readinessPct).toBe(personalRun.readinessPct);
  });

  it('requesting the family view writes nothing (no forecast run row, no result rows, no explanations)', async () => {
    const { client, results, explanations } = await build(baseWorld());
    await family(client);
    expect(results).toHaveLength(0);
    expect(explanations).toHaveLength(0);
  });
});

describe('Summary and Detailed: one valuation source, never both', () => {
  it('Detailed mode: derived value from holdings less the fund liability (400,000 + 25,000 less 80,000 = 345,000), the fund row and the typed figure are ignored', async () => {
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      smsfAccountBalance: 345_000,
      fund: fundRow({ mode: 'detailed', summary_balance: 999_999, detailed_net_value: 345_000 }),
      holdings: [holding('h1', 'Property', 400_000), holding('h2', 'Cash', 25_000, 'cash_account')],
      liabilities: [{ id: 'l1', user_id: USER, smsf_fund_id: 'fund-1', liability_name: 'LRBA', liability_type: 'property_loan', lender: 'Bank', balance: 80_000, currency_code: 'AUD', is_active: true }],
    });
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.smsf.opening).toBe(345_000);
    expect(v.family.opening).toBe(445_000);
    expect(v.smsf.funds[0].recording).toBe('itemised');
  });

  it('Summary mode: the typed net (250,000) is the whole SMSF value, and stray itemised holdings are not added', async () => {
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      smsfAccountBalance: 250_000,
      fund: fundRow({ mode: 'summary', summary_balance: 250_000, detailed_net_value: null }),
      holdings: [holding('h1', 'Stray line from earlier', 400_000)],
    });
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.smsf.opening).toBe(250_000);
    expect(v.family.opening).toBe(350_000);
    expect(v.family.opening).not.toBe(100_000 + 250_000 + 400_000);
    expect(v.smsf.funds[0].recording).toBe('net_only');
  });

  it('a fund that owes more than it owns reduces the family position and says so (not clamped to zero)', async () => {
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      smsfAccountBalance: 0,
      fund: fundRow({ mode: 'detailed' }),
      holdings: [holding('h1', 'Cash', 20_000, 'cash_account')],
      liabilities: [{ id: 'l1', user_id: USER, smsf_fund_id: 'fund-1', liability_name: 'Loan', liability_type: 'property_loan', lender: 'Bank', balance: 50_000, currency_code: 'AUD', is_active: true }],
    });
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.smsf.opening).toBe(-30_000);
    expect(v.family.opening).toBe(70_000);
    expect(v.notes.join(' ')).toMatch(/owes more than it holds/);
  });
});

describe('contributions: SMSF to the SMSF part, personal to the personal part, once', () => {
  it('a payslip-like repeated SMSF record and a one-off do not inflate the flow (series rule); a one-off is history, not a rate', async () => {
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      smsfAccountBalance: 400_000,
      fund: fundRow({ mode: 'detailed' }),
      holdings: [holding('h1', 'Property', 400_000)],
      contributions: [
        { account: 'acc-smsf', type: 'employer', amount: 2_000, frequency: 'monthly', date: '2026-08-01' },
        { account: 'acc-smsf', type: 'employer', amount: 2_000, frequency: 'monthly', date: '2026-09-01' }, // same series, later record: still one 2,000
        { account: 'acc-smsf', type: 'personal', amount: 10_000, frequency: 'one_off', date: '2026-06-30' }, // history, not a rate
      ],
    });
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.smsf.monthlyFlow).toBe(2_000); // not 4,000 (two records) and not 2,833.33 (one-off spread)
    expect(v.family.monthlyFlow).toBe(2_000);
  });

  it('a figure the SMSF account already held (no ledger record for that kind) is counted once, beside a ledger kind', async () => {
    // The account holds a personal figure of 500 a month. The ledger holds an employer contribution of 2,000 a month and nothing for the personal
    // kind, so the ledger governs the employer kind only: 2,000 (ledger) + 500 (account, personal kind) = 2,500. Reading the account's employer
    // column as well would double the employer part; reading the personal kind from the ledger would lose the 500.
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      smsfAccountBalance: 400_000,
      fund: fundRow({ mode: 'detailed' }),
      holdings: [holding('h1', 'Property', 400_000)],
      accountOverrides: { 'acc-smsf': { personal_contribution: 500, employer_contribution: 2_000, contribution_frequency: 'monthly' } },
      extraTables: {
        retirement_contributions: [
          { id: 'c1', user_id: USER, retirement_account_id: 'acc-smsf', destination_kind: 'smsf', contribution_type: 'employer', amount: 2_000, currency_code: 'AUD', frequency: 'monthly', source_type: 'manual', status: 'active', created_at: '2026-10-01T00:00:00Z', metadata: {} },
        ],
      },
    });
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.smsf.monthlyFlow).toBe(2_500);
    expect(v.smsf.monthlyFlow).not.toBe(2_000 + 2_000 + 500);
  });

  it('the contribution ledger not being available yet falls back to the fund account figures, says so, and still counts once', async () => {
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      smsfAccountBalance: 400_000,
      fund: fundRow({ mode: 'detailed' }),
      holdings: [holding('h1', 'Property', 400_000)],
      accountOverrides: { 'acc-smsf': { employer_contribution: 2_000, contribution_frequency: 'monthly' } },
      failOn: ['retirement_contributions'],
    });
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.smsf.monthlyFlow).toBe(2_000);
    expect(v.smsf.contributionSource).toBe('account_only');
    expect(v.notes.join(' ')).toMatch(/contribution history is not available yet/);
  });

  it('an SMSF contribution with no frequency is left out and counted, never read as monthly', async () => {
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      smsfAccountBalance: 400_000,
      fund: fundRow({ mode: 'detailed' }),
      holdings: [holding('h1', 'Property', 400_000)],
      accountOverrides: { 'acc-smsf': { employer_contribution: 7_000, contribution_frequency: null } },
    });
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.smsf.monthlyFlow).toBe(0);
    expect(v.smsf.unknownFrequencyCount).toBe(1);
    expect(v.notes.join(' ')).toMatch(/no frequency/);
  });
});

describe('who sees the family view', () => {
  it('a person with no SMSF gets no family view at all', async () => {
    const { client } = await build({ personal: [acct('acc-rest', 'Rest Super', 100_000)], fund: null });
    expect(await family(client)).toEqual({ available: false, reason: 'no_smsf' });
  });

  it('an archived (inactive) SMSF is not part of the family position', async () => {
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      smsfAccountBalance: 400_000,
      fund: fundRow({ is_active: false }),
      holdings: [holding('h1', 'Property', 400_000)],
    });
    expect(await family(client)).toEqual({ available: false, reason: 'no_smsf' });
  });

  it('TWO-USER ISOLATION: another person\'s SMSF, holdings and contributions never reach this person', async () => {
    // user OTHER owns a rich SMSF; USER has none.
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      fund: null,
      holdings: [holding('hx', 'Other person property', 9_000_000, 'residential_property', 'fund-x', OTHER)],
      extraTables: {
        smsf_funds: [fundRow({ id: 'fund-x', retirement_account_id: 'acc-x' }, OTHER)],
        retirement_accounts: [acct('acc-x', 'Other SMSF', 9_000_000, { master_item_key: 'smsf' }, OTHER)],
        retirement_contributions: [{ id: 'cx', user_id: OTHER, retirement_account_id: 'acc-x', destination_kind: 'smsf', contribution_type: 'employer', amount: 99_999, currency_code: 'AUD', frequency: 'monthly', source_type: 'manual', status: 'active', created_at: '2026-10-01T00:00:00Z', metadata: {} }],
      },
    });
    expect(await family(client)).toEqual({ available: false, reason: 'no_smsf' });
  });

  it('TWO-USER ISOLATION (positive side): with its own SMSF, this person sees only their own value even when another SMSF exists', async () => {
    const { client } = await build({
      personal: [acct('acc-rest', 'Rest Super', 100_000)],
      smsfAccountBalance: 400_000,
      fund: fundRow({ mode: 'detailed' }),
      holdings: [holding('h1', 'Property', 400_000), holding('hx', 'Other person property', 9_000_000, 'residential_property', 'fund-x', OTHER)],
      extraTables: {
        smsf_funds: [fundRow({ id: 'fund-x', retirement_account_id: 'acc-x' }, OTHER)],
        retirement_accounts: [acct('acc-x', 'Other SMSF', 9_000_000, { master_item_key: 'smsf' }, OTHER)],
      },
    });
    const v = await family(client);
    if (!v.available) throw new Error('expected a family view');
    expect(v.smsf.opening).toBe(400_000);
    expect(v.smsf.funds).toHaveLength(1);
  });
});

describe('pure engine', () => {
  const personalInput = {
    baselineDate: '2026-10-01', months: 60, assumptions: {} as never, currency: 'AUD', currentBalance: 100_000, monthlyContribution: 1_000,
    currentAge: 51, retirementAge: 67, targetMethod: 'target_corpus' as const, targetCorpus: 1_000_000,
  };
  it('is unavailable without an SMSF and never modifies the personal input', () => {
    const frozen = Object.freeze({ ...personalInput });
    expect(buildFamilyRetirementView(frozen as never, null)).toEqual({ available: false, reason: 'no_smsf' });
    expect(buildFamilyRetirementView(frozen as never, { funds: [], unconvertedCount: 0, unknownFrequencyCount: 0, contributionSource: 'none' })).toEqual({ available: false, reason: 'no_smsf' });
  });
  it('adds exactly the two SMSF numbers: opening and flow', () => {
    const v = buildFamilyRetirementView(personalInput as never, {
      funds: [
        { id: 'a', name: 'A', recording: 'itemised', netReporting: 300_000, monthlyContribution: 1_500 },
        { id: 'b', name: 'B', recording: 'net_only', netReporting: 100_000, monthlyContribution: 500 },
      ],
      unconvertedCount: 0, unknownFrequencyCount: 0, contributionSource: 'ledger_and_account',
    });
    if (!v.available) throw new Error('expected a view');
    expect(v.family.opening).toBe(500_000); // 100,000 + 300,000 + 100,000
    expect(v.family.monthlyFlow).toBe(3_000); // 1,000 + 1,500 + 500
  });
});

describe('screens', () => {
  it('the family card shows Personal, SMSF and Family rows, the basis and the notes (and only that)', () => {
    const view = buildFamilyRetirementView(
      { baselineDate: '2026-10-01', months: 60, assumptions: {} as never, currency: 'AUD', currentBalance: 100_000, monthlyContribution: 1_000, currentAge: 51, retirementAge: 67, targetMethod: 'target_corpus', targetCorpus: 2_000_000 } as never,
      { funds: [{ id: 'a', name: 'Bekal Super Fund', recording: 'itemised', netReporting: 400_000, monthlyContribution: 2_000 }], unconvertedCount: 0, unknownFrequencyCount: 0, contributionSource: 'ledger_and_account' },
    );
    if (!view.available) throw new Error('expected a view');
    const html = renderToStaticMarkup(React.createElement(FamilyRetirementView, { view, currency: 'AUD' }));
    expect(html).toContain('Family retirement position (Personal + SMSF)');
    expect(html).toContain('Personal retirement');
    expect(html).toContain('SMSF (Bekal Super Fund)');
    expect(html).toContain('$500,000');
    expect(html).toContain('$3,000 a month');
    expect(html).toContain('stays as it is');
  });

  it('the retirement forecast panel announces the family view only to a person with an SMSF', () => {
    const noSmsf = renderToStaticMarkup(React.createElement(RetirementForecastPanel, { currency: 'AUD', currentBalance: 100_000 }));
    expect(noSmsf).not.toContain('family-hint');
    expect(noSmsf).not.toContain('Family retirement position');
    const withSmsf = renderToStaticMarkup(React.createElement(RetirementForecastPanel, { currency: 'AUD', currentBalance: 100_000, hasSmsf: true }));
    expect(withSmsf).toContain('family-hint');
    expect(withSmsf).toContain('Family retirement position (Personal + SMSF)');
  });
});
