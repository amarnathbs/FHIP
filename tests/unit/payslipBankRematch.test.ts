/**
 * WP-09 (GAP-10 -> GAP-01) -- a bank statement approved AFTER the payslip:
 * the post-approval matcher links the salary credit to the payslip, and the
 * canonical Income read model then counts ONE income event.
 *
 * Oracle (brief): payslip net 5,000 (gross 6,500) Applied to Income + bank
 * salary credit 5,000 -> household net income 5,000, not 10,000.
 *
 * NEGATIVE CONTROL: on the base branch (f79374f) POST_BANK_APPROVAL_MATCHERS is
 * empty and lib/import-bridge/payslipBankRematch.ts does not exist, so nothing
 * links the late credit and selectIncome reports 10,000 -- the first test's
 * "before" assertion documents exactly that state, and every other test fails
 * at import.
 */
import { describe, expect, it } from 'vitest';

import { selectIncome } from '@/lib/read-models/income';
import { POST_BANK_APPROVAL_MATCHERS } from '@/lib/import-bridge/postBankApprovalMatchers';
import { runPayslipBankRematch } from '@/lib/import-bridge/payslipBankRematch';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { account, CAT, incomeSource, profile, statement, SUB, tables, taxonomy, txn, USER, WINDOW } from './readModels/helpers/fixtures';

/** The fake PostgREST client plus the 0210 restamp RPC, applied to the same rows. */
function household(t: Record<string, Row[]>) {
  const all = tables(profile(), taxonomy(), t);
  const fake = makeFakeSupabase(all);
  const rpcCalls: Record<string, unknown>[] = [];
  const client = {
    from: fake.client.from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, ...args });
      if (name !== 'fdh9_restamp_payroll_bank_match') return { data: null, error: { code: 'PGRST202', message: 'no such function' } };
      const e = (all.fdh_payroll_events ?? []).find((r) => r.id === args.p_payroll_event_id)!;
      const claimed = (all.fdh_payroll_events ?? []).some((r) => r.bank_match_transaction_id === args.p_transaction_id);
      if (e.bank_match_status === 'matched' || claimed) return { data: { ok: false, code: 'ALREADY_MATCHED' }, error: null };
      Object.assign(e, { bank_match_status: 'matched', bank_match_transaction_id: args.p_transaction_id, bank_match_confidence: args.p_confidence });
      return { data: { ok: true, outcome: 'matched' }, error: null };
    },
  };
  return { all, client, rpcCalls };
}

const payslip = (extra: Row = {}): Row => ({
  id: 'pe1', user_id: USER, employer_name: 'Acme Pty Ltd', currency_code: 'AUD', payment_date: '2026-08-15', pay_period_end: '2026-08-14',
  gross_pay: 6500, net_pay: 5000, bonus_pay: null, overtime_pay: null, commission_pay: null, other_earnings: null,
  approval_status: 'approved', superseded_by_payroll_event_id: null, bank_match_status: 'no_match', bank_match_transaction_id: null, ...extra,
});
const appliedRow = () => incomeSource('src-payslip', 'Salary — Acme', 6500, 'monthly', { net_amount: 5000, source_type: 'payslip_import', employer_name: 'Acme Pty Ltd' });
const application = { fhip_import_applications: [{ user_id: USER, target_domain: 'income', source_payroll_event_id: 'pe1', target_entity_id: 'src-payslip' }] };
const bank = () => tables({ fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] });
const salary = (extra: Partial<Parameters<typeof txn>[0]> = {}) => txn({
  id: 'sal', account: 'bank', statement: 's-aug', date: '2026-08-15', amount: 5000, type: 'income', category: CAT.income, subcategory: SUB.salary,
  description: 'ACME PAYROLL', ...extra,
});

async function income(client: unknown) {
  const r = await selectIncome(USER, { client: client as never, window: WINDOW });
  if (r.status !== 'ok') throw new Error(`unavailable: ${r.reason}`);
  return r;
}

describe('the WP-09 matcher is registered on the post-bank-approval seam', () => {
  it('POST_BANK_APPROVAL_MATCHERS holds wp09_payroll_bank_rematch, owned by WP-09', () => {
    const m = POST_BANK_APPROVAL_MATCHERS.find((x) => x.id === 'wp09_payroll_bank_rematch');
    expect(m?.ownerWp).toBe('WP-09');
  });
});

describe('bank imported AFTER the payslip: one income event', () => {
  it('before the re-match the household shows 10,000 net; after it, 5,000 net / 6,500 gross with the credit "counted once"', async () => {
    const { client, all } = household(tables(bank(), { income_sources: [appliedRow()], fdh_payroll_events: [payslip()], fdh_transactions: [salary()] }, application));

    const before = await income(client);
    expect(before.combined.netMonthly).toBe(10000); // the defect: two effects for one pay run
    expect(before.actual.representedCount).toBe(0);

    const outcome = await runPayslipBankRematch({ userId: USER, statementUploadId: 's-aug' }, { client: client as never });
    expect(outcome).toEqual({ linked: 1 });
    expect(all.fdh_payroll_events[0]).toMatchObject({ bank_match_status: 'matched', bank_match_transaction_id: 'sal' });

    const after = await income(client);
    expect(after.combined.netMonthly).toBe(5000);
    expect(after.combined.grossMonthly).toBe(6500);
    expect(after.actual.representedCount).toBe(1);
    expect(after.actual.lines[0]).toMatchObject({ treatment: 'represented_by_planned_source', representedBySourceId: 'src-payslip' });
  });

  it('is idempotent: a second approval of the same statement links nothing and calls no RPC', async () => {
    const { client, rpcCalls } = household(tables(bank(), { income_sources: [appliedRow()], fdh_payroll_events: [payslip()], fdh_transactions: [salary()] }, application));
    await runPayslipBankRematch({ userId: USER, statementUploadId: 's-aug' }, { client: client as never });
    const again = await runPayslipBankRematch({ userId: USER, statementUploadId: 's-aug' }, { client: client as never });
    expect(again).toEqual({ linked: 0 });
    expect(rpcCalls).toHaveLength(1);
  });

  it('still links when the salary credit is line 1,001 of the statement (paged, never truncated)', async () => {
    const filler = Array.from({ length: 1000 }, (_, i) => txn({ id: `a-${String(i).padStart(4, '0')}`, account: 'bank', statement: 's-aug', date: '2026-08-02', amount: 10 + i, type: 'income', category: CAT.income }));
    const { client } = household(tables(bank(), { income_sources: [appliedRow()], fdh_payroll_events: [payslip()], fdh_transactions: [...filler, salary({ id: 'z-sal' })] }, application));
    const outcome = await runPayslipBankRematch({ userId: USER, statementUploadId: 's-aug' }, { client: client as never });
    expect(outcome).toEqual({ linked: 1 });
  });
});

describe('only a real, approved, unclaimed, unambiguous salary credit is linked', () => {
  it.each([
    ['an unapproved credit', { approval: 'pending' }],
    ['a credit classified as a transfer', { type: 'transfer' }],
    ['a different amount', { amount: 4999 }],
    ['a different currency', { currency: 'USD' }],
  ])('%s is not linked', async (_label, extra) => {
    const { client, rpcCalls } = household(tables(bank(), { income_sources: [appliedRow()], fdh_payroll_events: [payslip()], fdh_transactions: [salary(extra as never)] }, application));
    expect(await runPayslipBankRematch({ userId: USER, statementUploadId: 's-aug' }, { client: client as never })).toEqual({ linked: 0 });
    expect(rpcCalls).toHaveLength(0);
  });

  it('a credit another payslip already corroborates is not a candidate', async () => {
    const { client, rpcCalls } = household(tables(bank(), {
      fdh_payroll_events: [payslip(), payslip({ id: 'pe0', bank_match_status: 'matched', bank_match_transaction_id: 'sal' })],
      fdh_transactions: [salary()],
    }));
    expect(await runPayslipBankRematch({ userId: USER, statementUploadId: 's-aug' }, { client: client as never })).toEqual({ linked: 0 });
    expect(rpcCalls).toHaveLength(0);
  });

  it('two equally good deposits: never pick one (multiple candidates -> no link)', async () => {
    const { client, rpcCalls } = household(tables(bank(), { fdh_payroll_events: [payslip()], fdh_transactions: [salary(), salary({ id: 'sal2' })] }));
    expect(await runPayslipBankRematch({ userId: USER, statementUploadId: 's-aug' }, { client: client as never })).toEqual({ linked: 0 });
    expect(rpcCalls).toHaveLength(0);
  });

  it('a superseded payslip is never re-matched', async () => {
    const { client, rpcCalls } = household(tables(bank(), { fdh_payroll_events: [payslip({ superseded_by_payroll_event_id: 'pe2' })], fdh_transactions: [salary()] }));
    expect(await runPayslipBankRematch({ userId: USER, statementUploadId: 's-aug' }, { client: client as never })).toEqual({ linked: 0 });
    expect(rpcCalls).toHaveLength(0);
  });

  it('a failed read throws (the seam audits it by name) -- never a silent "nothing to link"', async () => {
    const all = tables(profile(), taxonomy(), bank(), { fdh_payroll_events: [payslip()], fdh_transactions: [salary()] });
    const fake = makeFakeSupabase(all, { failOn: new Set(['fdh_payroll_events']) });
    await expect(runPayslipBankRematch({ userId: USER, statementUploadId: 's-aug' }, { client: { from: fake.client.from, rpc: async () => ({ data: null, error: null }) } as never }))
      .rejects.toMatchObject({ name: 'PayslipRematchReadError' });
  });
});
