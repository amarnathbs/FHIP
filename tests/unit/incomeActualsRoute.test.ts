/**
 * WP-09 (GAP-06 income section, GAP-07) -- the Income tab shows imported
 * income from the canonical Income read model, and the payslip behind an
 * imported row.
 *
 *  - GET /api/income/actuals: payslip Applied + matched bank credit -> the
 *    credit is listed ONCE as "Counted once with payslip" and the household
 *    total is 5,000 net / 6,500 gross, not 10,000; an unlinked credit next to a
 *    similar manual salary carries the D-07 "possible duplicate" prompt; a
 *    failed read is 'unavailable', never $0; another user's rows never appear.
 *  - the component renders exactly what the route sends (contract).
 *  - Payslip details: every figure grouped, labelled from the disposition
 *    registry (employer super "never added", YTD "not added").
 *  - waiting-imports?kind=payslip lists unapproved (review) and approved-but-
 *    never-applied (compare) payslips, not applied or superseded ones.
 *
 * NEGATIVE CONTROL: on the base branch app/api/income/actuals/route.ts,
 * lib/income/*, components/income/ImportedIncomeActuals.tsx and PayslipDetails
 * do not exist, and WaitingImportKind has no 'payslip' -- every test here fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { account, CAT, incomeSource, profile, statement, SUB, tables, taxonomy, txn, USER } from './readModels/helpers/fixtures';

const state: { tables: Record<string, Row[]>; failOn?: Set<string>; user: string } = { tables: {}, user: USER };

vi.mock('@/lib/services/appCapability', () => ({
  requireModuleCapability: async () => ({ user: { id: state.user }, blocked: null, decision: null }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeFakeSupabase(state.tables, { failOn: state.failOn }).client,
}));

import { GET } from '@/app/api/income/actuals/route';
import type { IncomeActualsDto, IncomeActualsOk } from '@/lib/income/importedIncomeActuals';

async function get(): Promise<IncomeActualsDto> {
  const res = await GET(new Request('http://localhost/api/income/actuals'));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: IncomeActualsDto }).data;
}
const okOf = (d: IncomeActualsDto): IncomeActualsOk => {
  if (d.status !== 'ok') throw new Error(`unavailable: ${d.reason}`);
  return d;
};

// "Today" = 26 Sep 2026 in Sydney -> the default window is Jun-Aug 2026.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T02:00:00Z'));
  state.failOn = undefined;
  state.user = USER;
});
afterEach(() => vi.useRealTimers());

const bank = () => tables({ fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] });
const salary = () => txn({ id: 'sal', account: 'bank', statement: 's-aug', date: '2026-08-15', amount: 5000, type: 'income', category: CAT.income, subcategory: SUB.salary, description: 'ACME PAYROLL' });
const payslipHousehold = (matched: boolean) => tables(profile(), taxonomy(), bank(), {
  income_sources: [incomeSource('src-payslip', 'Salary — Acme', 6500, 'monthly', { net_amount: 5000, source_type: 'payslip_import', employer_name: 'Acme' })],
  fdh_payroll_events: [{
    id: 'pe1', user_id: USER, employer_name: 'Acme', currency_code: 'AUD', payment_date: '2026-08-15', pay_period_end: '2026-08-14', gross_pay: 6500, net_pay: 5000,
    bonus_pay: 1200, overtime_pay: null, commission_pay: null, other_earnings: null, approval_status: 'approved', superseded_by_payroll_event_id: null,
    bank_match_status: matched ? 'matched' : 'no_match', bank_match_transaction_id: matched ? 'sal' : null,
  }],
  fdh_transactions: [salary()],
  fhip_import_applications: [{ user_id: USER, target_domain: 'income', source_payroll_event_id: 'pe1', target_entity_id: 'src-payslip' }],
});

describe('GET /api/income/actuals', () => {
  it('payslip + matched bank credit: the credit is shown ONCE, "Counted once with payslip", and the total is not doubled', async () => {
    state.tables = payslipHousehold(true);
    const d = okOf(await get());
    expect(d.actual.lines).toHaveLength(1);
    expect(d.actual.lines[0]).toMatchObject({
      transactionId: 'sal', amount: 5000, treatment: 'represented_by_planned_source', treatmentLabel: 'Counted once with payslip',
      representedByName: 'Salary — Acme', sourceLabel: 'Imported from bank statement',
    });
    expect(d.actual.lines[0].statementHref).toMatch(/review\?statement=s-aug&from=income$/);
    expect(d.actual.countedMonthly).toBe(0);
    expect(d.planned.lines[0]).toMatchObject({ sourceLabel: 'Imported from payslip', hasPayslipDetails: true, counted: true });
    // D-06: the 1,200 bonus is a dated one-off (1,200 / 3 months = 400 a month).
    expect(d.variablePay.lines[0]).toMatchObject({ grossNative: 1200, sourceName: 'Salary — Acme', date: '2026-08-15' });
    expect(d.combined.grossMonthly).toBe(6900);
  });

  it('negative control in-file: the SAME household without the payslip<->bank link counts the credit again', async () => {
    state.tables = payslipHousehold(false);
    const d = okOf(await get());
    expect(d.actual.lines[0].treatment).toBe('counted');
    expect(d.actual.countedMonthly).toBe(5000);
  });

  it('D-07: an unlinked credit next to a similar manual salary is counted with a "possible duplicate of" prompt', async () => {
    state.tables = tables(profile(), taxonomy(), bank(), { income_sources: [incomeSource('m1', 'My salary', 6500, 'monthly', { net_amount: 5000 })], fdh_transactions: [salary()] });
    const d = okOf(await get());
    expect(d.actual.lines[0].possibleDuplicateOf).toEqual([{ sourceId: 'm1', name: 'My salary' }]);
    expect(d.actual.possibleDuplicateCount).toBe(1);
  });

  it("another user's rows never appear", async () => {
    state.tables = payslipHousehold(true);
    state.user = '00000000-0000-0000-0000-0000000000u2';
    const d = okOf(await get());
    expect(d.actual.lines).toHaveLength(0);
    expect(d.planned.lines).toHaveLength(0);
  });

  it("a failed read is 'unavailable', never $0", async () => {
    state.tables = payslipHousehold(true);
    state.failOn = new Set(['income_sources']);
    expect((await get()).status).toBe('unavailable');
  });
});

describe('the Income tab renders what the route sends', () => {
  it('the counted-once line, its statement link, the one-off bonus and "View payslip" all render', async () => {
    state.tables = payslipHousehold(true);
    const d = okOf(await get());
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { IncomeActualsBody } = await import('@/components/income/ImportedIncomeActuals');
    const html = renderToStaticMarkup(createElement(IncomeActualsBody, { data: d }));
    expect(html).toContain('Counted once with payslip');
    expect(html).toContain('Same money as “Salary — Acme”');
    expect(html).toContain('ACME PAYROLL');
    expect(html).toContain('review?statement=s-aug&amp;from=income');
    expect(html).toContain('One-off pay from your payslips');
    expect(html).toContain('View payslip');
    expect(html).toContain('data-treatment="represented_by_planned_source"');
  });
});

describe('Payslip details are labelled from the disposition registry', () => {
  it('every group renders; employer super is "never added"; YTD is evidence; net pay is used in the income entry', async () => {
    const { buildPayslipDetails, dispositionOf } = await import('@/lib/income/payslipDetails');
    const d = buildPayslipDetails({ currency_code: 'AUD', gross_pay: '6500.0000', net_pay: 5000, tax_withheld: 1300, employer_retirement_contribution: 780, ytd_gross: 13000, base_pay: null, user_corrected_fields: ['net_pay'] },
      [{ component_side: 'earning', component_type: 'base', label_raw: 'Ordinary', amount: 6500, is_year_to_date: false }]);
    const row = (c: string) => d.groups.flatMap((g) => g.rows).find((r) => r.column === c)!;
    expect(d.groups.map((g) => g.id)).toEqual(['current', 'employer', 'ytd']);
    expect(row('gross_pay')).toMatchObject({ value: 6500, dispositionLabel: 'Used in your income entry' });
    expect(row('net_pay')).toMatchObject({ corrected: true, disposition: dispositionOf('net_pay') });
    expect(row('employer_retirement_contribution').dispositionLabel).toMatch(/never added/);
    expect(row('ytd_gross').dispositionLabel).toBe('Evidence only — not added to your income');
    expect(row('base_pay').value).toBeNull();
    expect(row('bonus_pay').dispositionLabel).toBe('Counted as one-off income on its pay date');
    expect(d.components).toEqual([{ side: 'earning', type: 'base', label: 'Ordinary', amount: 6500, isYearToDate: false }]);
    // Every money column the payslip table carries is shown somewhere.
    const shown = new Set(d.groups.flatMap((g) => g.rows.map((r) => r.column)));
    for (const c of ['gross_pay', 'base_pay', 'overtime_pay', 'bonus_pay', 'commission_pay', 'allowances_total', 'reimbursements_total', 'other_earnings', 'tax_withheld',
      'employee_deductions_total', 'salary_sacrifice', 'professional_tax', 'employer_retirement_contribution', 'employee_retirement_contribution',
      'employer_nps_contribution', 'employee_nps_contribution', 'net_pay', 'ytd_gross', 'ytd_tax', 'ytd_net', 'ytd_employer_retirement', 'ytd_employee_retirement']) {
      expect(shown.has(c), c).toBe(true);
      expect(dispositionOf(c), c).toBeTruthy();
    }
  });

  it('the component renders a figure the payslip does not show as "Not shown", never 0', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { PayslipDetails } = await import('@/components/income/PayslipDetails');
    const html = renderToStaticMarkup(createElement(PayslipDetails, { event: { currency_code: 'AUD', gross_pay: 6500, base_pay: null } }));
    expect(html).toContain('Not shown on payslip');
    expect(html).toContain('Year to date (never added to this period)');
  });
});

describe('waiting-imports?kind=payslip (GAP-11)', () => {
  it('lists an unapproved payslip as review and an approved, never-applied one as compare; applied and dismissed ones are done', async () => {
    const ev = (id: string, approval: string, extra: Row = {}): Row => ({
      id, user_id: USER, statement_upload_id: `doc-${id}`, approval_status: approval, employer_name: `Employer ${id}`, pay_period_end: '2026-08-31',
      currency_code: 'AUD', country_code: 'AU', created_at: `2026-09-0${id.length}T00:00:00Z`, superseded_by_payroll_event_id: null, ...extra,
    });
    state.tables = {
      fdh_payroll_events: [ev('a', 'pending'), ev('bb', 'approved'), ev('ccc', 'approved'), ev('dddd', 'approved'), ev('eeeee', 'pending', { superseded_by_payroll_event_id: 'a' })],
      fhip_import_applications: [{ user_id: USER, target_domain: 'income', source_payroll_event_id: 'ccc' }],
      fhip_import_proposals: [{ user_id: USER, source_payroll_event_id: 'dddd', status: 'dismissed' }],
      fdh_statement_uploads: ['a', 'bb', 'ccc', 'dddd'].map((id) => ({ id: `doc-${id}`, user_id: USER, document_type: 'payslip', country_code: 'AU', currency_code: 'AUD', processing_status: 'extracted', created_at: '2026-09-01' })),
      fdh_ai_fallback_drafts: [],
    };
    const { listWaitingImports } = await import('@/lib/financial-data-hub/services/waitingImports');
    const items = await listWaitingImports(USER, 'payslip');
    expect(items.map((i) => [i.document_id, i.stage]).sort()).toEqual([['doc-a', 'review'], ['doc-bb', 'compare']]);
  });
});
