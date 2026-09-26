/**
 * selectIncome -- one financial fact, one economic effect (GAP-01, D-06, D-07,
 * GAP-09). Numbers from the brief: payslip 5,000 + bank 5,000 -> income 5,000.
 */
import { describe, expect, it } from 'vitest';

import { selectIncome, type IncomeReadModelData } from '@/lib/read-models/income';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, CAT, incomeSource, profile, statement, SUB, tables, taxonomy, txn, USER, WINDOW } from './helpers/fixtures';

async function run(t: Record<string, Row[]>): Promise<IncomeReadModelData> {
  const { client } = makeFakeSupabase(tables(profile(), taxonomy(), t));
  const res = await selectIncome(USER, { client, window: WINDOW });
  if (res.status !== 'ok') throw new Error(`unavailable: ${res.reason} ${res.source}`);
  return res;
}

const bankAug = () => tables({ fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] });
const salaryCredit = (amount = 5000, id = 'sal') => txn({ id, account: 'bank', statement: 's-aug', date: '2026-08-15', amount, type: 'income', category: CAT.income, subcategory: SUB.salary });
const payrollEvent = (extra: Row = {}): Row => ({
  id: 'pe1', user_id: USER, employer_name: 'Acme', currency_code: 'AUD', payment_date: '2026-08-15', pay_period_end: '2026-08-14',
  gross_pay: 6500, net_pay: 5000, bonus_pay: null, overtime_pay: null, commission_pay: null, other_earnings: null,
  approval_status: 'approved', superseded_by_payroll_event_id: null, bank_match_transaction_id: 'sal', bank_match_status: 'matched', ...extra,
});
const appliedSource = () => incomeSource('src-payslip', 'Acme salary', 6500, 'monthly', { net_amount: 5000, source_type: 'payslip_import', employer_name: 'Acme' });
const application = { fhip_import_applications: [{ user_id: USER, target_domain: 'income', source_payroll_event_id: 'pe1', target_entity_id: 'src-payslip' }] };

describe('payslip + matching bank salary credit = ONE income event', () => {
  it('Applied payslip (gross 6,500 / net 5,000) + bank 5,000 credit -> net 5,000, gross 6,500 (not 10,000 / 11,500)', async () => {
    const e = await run(tables(bankAug(), { income_sources: [appliedSource()], fdh_payroll_events: [payrollEvent()], fdh_transactions: [salaryCredit()] }, application));
    expect(e.combined.netMonthly).toBe(5000);
    expect(e.combined.grossMonthly).toBe(6500);
    expect(e.actual.representedCount).toBe(1);
    const line = e.actual.lines[0];
    expect(line.treatment).toBe('represented_by_planned_source');
    expect(line.representedBySourceId).toBe('src-payslip');
    expect(e.planned.lines[0].provenance.label).toBe('Imported from payslip');
  });

  it('approved but NOT Applied payslip + bank credit -> the bank credit is the single event (5,000 net, gross = net floor)', async () => {
    const e = await run(tables(bankAug(), { fdh_payroll_events: [payrollEvent()], fdh_transactions: [salaryCredit()] }));
    expect(e.combined.netMonthly).toBe(5000);
    expect(e.combined.grossMonthly).toBe(5000);
    expect(e.combined.grossIncludesNetFloor).toBe(true);
    expect(e.actual.lines[0].treatment).toBe('counted');
    expect(e.actual.lines[0].possibleDuplicateOf).toEqual([]);
  });

  it('negative control: a payslip match to a DIFFERENT amount/currency/direction is not accepted as corroboration', async () => {
    const e = await run(tables(bankAug(), { income_sources: [appliedSource()], fdh_payroll_events: [payrollEvent({ currency_code: 'INR' })], fdh_transactions: [salaryCredit()] }, application));
    // Currency mismatch -> not the same money -> counted, with a D-07 duplicate prompt.
    expect(e.actual.lines[0].treatment).toBe('counted');
    expect(e.actual.possibleDuplicateCount).toBe(1);
  });

  it('a superseded or unapproved payslip never corroborates', async () => {
    for (const extra of [{ superseded_by_payroll_event_id: 'pe2' }, { approval_status: 'pending' }]) {
      const e = await run(tables(bankAug(), { income_sources: [appliedSource()], fdh_payroll_events: [payrollEvent(extra)], fdh_transactions: [salaryCredit()] }, application));
      expect(e.actual.lines[0].treatment).toBe('counted');
    }
  });
});

describe('PO D-06: variable pay is a dated one-off actual', () => {
  it('bonus 3,000 on an Applied payslip dated in the window -> +1,000/month gross (3,000 over 3 months); net unknown', async () => {
    const e = await run(tables(bankAug(), {
      income_sources: [appliedSource()],
      fdh_payroll_events: [payrollEvent({ bonus_pay: 3000, gross_pay: 9500, net_pay: 7100 })],
      fdh_transactions: [salaryCredit(7100)],
    }, application));
    expect(e.actual.variablePay.lines).toHaveLength(1);
    expect(e.actual.variablePay.grossMonthly).toBe(1000);
    expect(e.combined.grossMonthly).toBe(7500);
    expect(e.combined.netMonthly).toBeNull();
    expect(e.combined.netKnownMonthly).toBe(5000);
    expect(e.actual.representedCount).toBe(1); // the 7,100 credit is not added again
  });
});

describe('PO D-07 and GAP-09', () => {
  it('an unlinked bank credit next to a similar manual salary counts, with a "possible duplicate of" prompt', async () => {
    const e = await run(tables(bankAug(), { income_sources: [incomeSource('m1', 'My salary', 6500, 'monthly', { net_amount: 5000 })], fdh_transactions: [salaryCredit()] }));
    expect(e.combined.netMonthly).toBe(10000);
    expect(e.actual.lines[0].possibleDuplicateOf).toEqual([{ sourceId: 'm1', name: 'My salary' }]);
  });

  it('a null net_amount is UNKNOWN, never the gross', async () => {
    const e = await run({ income_sources: [incomeSource('m1', 'Salary', 8000, 'monthly')] });
    expect(e.planned.lines[0].netMonthly).toBeNull();
    expect(e.combined.netMonthly).toBeNull();
    expect(e.combined.netKnownMonthly).toBe(0);
    expect(e.combined.grossMonthly).toBe(8000);
  });

  it('superseded and SMSF-owned planned rows are excluded and say why; INR is converted', async () => {
    const e = await run({ income_sources: [
      incomeSource('a', 'Old', 1000, 'monthly', { superseded_by_bank_import: true, net_amount: 900 }),
      incomeSource('b', 'Fund rent', 2000, 'monthly', { owner: 'smsf', net_amount: 2000 }),
      incomeSource('c', 'India rent', 56000, 'monthly', { currency_code: 'INR', net_amount: 56000 }),
    ] });
    expect(e.planned.lines.map((l) => l.excludedReason)).toEqual(['superseded_by_bank_import', 'smsf_owned', null]);
    expect(e.combined.grossMonthly).toBe(1000);
  });

  it('a broker dividend: the bank credit is the single income leg ($400 bank + $400 broker = $400)', async () => {
    const e = await run(tables(bankAug(), {
      fdh_transactions: [txn({ id: 'div', account: 'bank', statement: 's-aug', date: '2026-08-20', amount: 400, type: 'income', category: CAT.income })],
      fdh_investment_statements: [{ id: 'inv-s', user_id: USER, approval_status: 'approved' }],
      fdh_investment_statement_activities: [{ id: 'd1', user_id: USER, statement_id: 'inv-s', activity_type: 'DIVIDEND', amount: 400, currency_code: 'AUD', linked_transaction_id: 'div', bank_match_status: 'matched' }],
      ii_transactions: [{ id: 'ii-div', user_id: USER, transaction_type: 'dividend', gross_amount: 400 }],
    }));
    expect(e.actual.countedMonthly).toBe(400);
    expect(e.actual.lines[0].corroboratedBy.map((c) => c.activityType)).toEqual(['DIVIDEND']);
  });

  it('SELL proceeds are ordinary income 0 (typed asset_sale, or mis-typed income but corroborated by an approved SELL)', async () => {
    const e = await run(tables(bankAug(), {
      fdh_transactions: [
        txn({ id: 'sell1', account: 'bank', statement: 's-aug', date: '2026-08-21', amount: 15000, type: 'asset_sale' }),
        txn({ id: 'sell2', account: 'bank', statement: 's-aug', date: '2026-08-22', amount: 15000, type: 'income', category: CAT.income }),
      ],
      fdh_investment_statements: [{ id: 'inv-s', user_id: USER, approval_status: 'approved' }],
      fdh_investment_statement_activities: [{ id: 's1', user_id: USER, statement_id: 'inv-s', activity_type: 'SELL', amount: 15000, currency_code: 'AUD', linked_transaction_id: 'sell2', bank_match_status: 'matched' }],
    }));
    expect(e.actual.countedMonthly).toBe(0);
    expect(e.flags.hasActual).toBe(false);
  });

  it("a failed read is 'unavailable', never 0", async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), { income_sources: [incomeSource('m', 's', 1, 'monthly')] }), { failOn: new Set(['fdh_payroll_events']) });
    expect((await selectIncome(USER, { client, window: WINDOW })).status).toBe('unavailable');
  });
});
