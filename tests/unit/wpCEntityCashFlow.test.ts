// DOCUMENT2 (4) review, WP-C, F22 / F23 / F23b: entity-level income and expenses. EVIDENCE LABEL: UNIT-TESTED (hand oracles, real route handlers over
// the in-memory PostgREST fake, the real ledger normaliser). The database side is PGLITE-VERIFIED in wpCEntityFinancePglite.test.ts. Not DEV-verified.
//
// HAND ORACLE (AUD): rent 600 weekly = 600 x 52 / 12 = 2,600 a month; interest 500 monthly; audit fee 600 annually = 50 a month;
// fund loan 370,000 at 6.2 percent = 370,000 x 0.062 / 12 = 1,911.67 interest a month; scheduled repayment 2,400, so principal 488.33.
//   income 3,100; expenses 50 (NOT 2,400: principal is cash flow); net operating = 3,100 - 50 - 1,911.67 = 1,138.33;
//   net cash flow = 3,100 - 50 - 2,400 = 650.
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { computeEntityCashFlow } from '@/lib/engines/entityCashFlow';
import { entityIncomeSchema, entityExpenseSchema, ENTITY_EXPENSE_TYPES } from '@/lib/validation/entityCashFlow';
import { emptyRawLedger, normaliseLedger } from '@/lib/read-models/core/ledger';
import { fxContext } from '@/lib/read-models/core/currency';
import { explicitWindow } from '@/lib/read-models/core/window';
import { computeSmsfBankActuals, isSmsfLedgerLine } from '@/lib/read-models/smsfBankActuals';

const LOAN = { balance: 370_000, interestRatePercent: 6.2, monthlyRepayment: 2_400, currency: 'AUD' };
const base = { currency: 'AUD' as const, fxRateAudInr: 56 };

describe('computeEntityCashFlow: principal is cash flow, never an expense', () => {
  const input = {
    ...base,
    income: [
      { type: 'rent', amount: 600, frequency: 'weekly' as const, currency: 'AUD' },
      { type: 'interest', amount: 500, frequency: 'monthly' as const, currency: 'AUD' },
    ],
    expenses: [{ type: 'accounting_audit', amount: 600, frequency: 'annually' as const, currency: 'AUD' }],
    loans: [LOAN],
  };

  it('PO oracle: income 3,100, expenses 50, interest 1,911.67, principal 488.33, net operating 1,138.33, net cash flow 650', () => {
    const r = computeEntityCashFlow(input);
    expect(r.incomeMonthly).toBe(3_100);
    expect(r.incomeByType).toEqual({ rent: 2_600, interest: 500 });
    expect(r.expensesMonthly).toBe(50);
    expect(r.estimatedInterestMonthly).toBe(1_911.67);
    expect(r.estimatedPrincipalMonthly).toBe(488.33);
    expect(r.debtServiceMonthly).toBe(2_400);
    expect(r.netOperatingResultMonthly).toBe(1_138.33);
    expect(r.netCashFlowMonthly).toBe(650);
  });

  it('raising the repayment moves the CASH flow by exactly the extra repayment and leaves the operating result alone (principal is not an expense)', () => {
    const a = computeEntityCashFlow(input);
    const b = computeEntityCashFlow({ ...input, loans: [{ ...LOAN, monthlyRepayment: 3_000 }] });
    expect(b.netOperatingResultMonthly).toBe(a.netOperatingResultMonthly);
    expect(b.expensesMonthly).toBe(a.expensesMonthly);
    expect(a.netCashFlowMonthly - b.netCashFlowMonthly).toBe(600);
  });

  it('contributions are an inflow of the cash flow and never operating income', () => {
    const r = computeEntityCashFlow({ ...input, contributionsMonthly: 1_000 });
    expect(r.incomeMonthly).toBe(3_100);
    expect(r.netOperatingResultMonthly).toBe(1_138.33);
    expect(r.netCashFlowMonthly).toBe(1_650);
  });

  it('MISSING != ZERO: an INR row is converted once at the household rate, an unsupported currency is left out and counted', () => {
    const r = computeEntityCashFlow({
      ...base,
      income: [{ type: 'interest', amount: 5_600, frequency: 'monthly', currency: 'INR' }, { type: 'other', amount: 50, frequency: 'monthly', currency: 'GBP' }],
      expenses: [],
      loans: [],
    });
    expect(r.incomeMonthly).toBe(100);
    expect(r.unconvertedCount).toBe(1);
  });

  it('a one-off amount is not turned into a monthly rate', () => {
    expect(computeEntityCashFlow({ ...base, income: [{ type: 'other', amount: 9_000, frequency: 'one_off', currency: 'AUD' }], expenses: [], loans: [] }).incomeMonthly).toBe(0);
  });

  it('NEGATIVE CONTROL: counting the whole repayment as an expense WOULD change the answer (so the oracle is not vacuous)', () => {
    const r = computeEntityCashFlow(input);
    const wrong = r.incomeMonthly - (r.expensesMonthly + r.debtServiceMonthly) - r.estimatedInterestMonthly;
    expect(wrong).not.toBe(r.netOperatingResultMonthly);
  });
});

describe('validation: rent needs an amount AND a frequency, there is no loan repayment expense', () => {
  const ok = { income_type: 'rent', income_name: 'Rent Unit 1', amount: 600, frequency: 'weekly', currency_code: 'AUD' };
  it('rent with no amount is refused with the plain wording, with an amount and a frequency it passes', () => {
    const bad = entityIncomeSchema.safeParse({ ...ok, amount: 0 });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error!.issues)).toContain('Enter the rent amount and how often it is paid');
    expect(entityIncomeSchema.safeParse(ok).success).toBe(true);
    expect(entityIncomeSchema.safeParse({ ...ok, frequency: undefined }).success).toBe(false);
  });
  it('only rent can be tied to a property', () => {
    expect(entityIncomeSchema.safeParse({ ...ok, income_type: 'interest', smsf_holding_id: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(entityIncomeSchema.safeParse({ ...ok, smsf_holding_id: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
  });
  it('the expense types contain no loan repayment or principal, and one is refused', () => {
    expect(ENTITY_EXPENSE_TYPES.join(' ')).not.toMatch(/loan|principal|repayment|mortgage/);
    expect(entityExpenseSchema.safeParse({ expense_type: 'loan_principal', expense_name: 'x', amount: 1, frequency: 'monthly', currency_code: 'AUD' }).success).toBe(false);
  });
});

const { userMock } = vi.hoisted(() => ({ userMock: vi.fn(() => ({ user: { id: 'user-a' }, unauthenticated: null })) }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: () => userMock() };
});

async function world(tables: Record<string, Row[]>) {
  vi.resetModules();
  const db = createInMemoryDb();
  db.reset(tables);
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => db.client }));
  return db;
}
const post = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
const patchReq = (body: unknown) => new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) });
const ctx = (id: string, itemId?: string) => ({ params: Promise.resolve({ id, itemId }) });
const FUND_A = { id: 'fund-a', user_id: 'user-a' };
const FUND_B = { id: 'fund-b', user_id: 'user-b' };
const RENT = { income_type: 'rent', income_name: 'Rent Unit 1', amount: 600, frequency: 'weekly', currency_code: 'AUD' };

describe('SMSF income and expense routes: entity scoped, never personal', () => {
  it('POST rent with an amount and frequency creates a FUND record and writes nothing to personal income', async () => {
    const db = await world({ smsf_funds: [FUND_A, FUND_B], entity_income_items: [], income_sources: [] });
    const { POST } = await import('@/app/api/smsf/[id]/income/route');
    const res = await POST(post(RENT), ctx('fund-a'));
    expect(res.status).toBe(200);
    const row = db.tables.entity_income_items[0];
    expect(row).toMatchObject({ user_id: 'user-a', entity_kind: 'smsf', smsf_fund_id: 'fund-a', income_type: 'rent', amount: 600, frequency: 'weekly' });
    expect(db.tables.income_sources).toHaveLength(0);
    expect(db.writes.every((w) => w.table === 'entity_income_items')).toBe(true);
  });

  it('POST rent with no amount is refused 422 and writes nothing', async () => {
    const db = await world({ smsf_funds: [FUND_A], entity_income_items: [] });
    const { POST } = await import('@/app/api/smsf/[id]/income/route');
    const res = await POST(post({ ...RENT, amount: 0 }), ctx('fund-a'));
    expect(res.status).toBe(422);
    expect(db.writes).toHaveLength(0);
  });

  it('TWO-USER: another household\'s fund answers 404 on list, create, edit and remove, and nothing is written or leaked', async () => {
    const db = await world({ smsf_funds: [FUND_A, FUND_B], entity_income_items: [{ id: 'i-b', user_id: 'user-b', smsf_fund_id: 'fund-b', entity_kind: 'smsf', is_active: true, income_name: 'Theirs', amount: 1, frequency: 'monthly', income_type: 'other', currency_code: 'AUD' }] });
    const list = await import('@/app/api/smsf/[id]/income/route');
    const item = await import('@/app/api/smsf/[id]/income/[itemId]/route');
    expect((await list.GET(new Request('http://x'), ctx('fund-b'))).status).toBe(404);
    expect((await list.POST(post(RENT), ctx('fund-b'))).status).toBe(404);
    expect((await item.PATCH(patchReq({ amount: 9 }), ctx('fund-b', 'i-b'))).status).toBe(404);
    expect((await item.DELETE(new Request('http://x', { method: 'DELETE' }), ctx('fund-b', 'i-b'))).status).toBe(404);
    expect(db.writes).toHaveLength(0);
    expect(db.tables.entity_income_items[0].is_active).toBe(true);
  });

  it('DELETE retires the record (kept, not deleted) and the list stops showing it', async () => {
    const db = await world({ smsf_funds: [FUND_A], entity_income_items: [{ id: 'i1', user_id: 'user-a', smsf_fund_id: 'fund-a', entity_kind: 'smsf', is_active: true, ...RENT }] });
    const item = await import('@/app/api/smsf/[id]/income/[itemId]/route');
    const res = await item.DELETE(new Request('http://x', { method: 'DELETE' }), ctx('fund-a', 'i1'));
    expect(res.status).toBe(200);
    expect(db.tables.entity_income_items).toHaveLength(1);
    expect(db.tables.entity_income_items[0].is_active).toBe(false);
    const list = await import('@/app/api/smsf/[id]/income/route');
    expect((await (await list.GET(new Request('http://x'), ctx('fund-a'))).json()).data).toHaveLength(0);
  });

  it('expenses: a fee is stored on the fund, a loan repayment type is refused', async () => {
    const db = await world({ smsf_funds: [FUND_A], entity_expense_items: [] });
    const { POST } = await import('@/app/api/smsf/[id]/expenses/route');
    expect((await POST(post({ expense_type: 'accounting_audit', expense_name: 'Audit fee', amount: 550, frequency: 'annually', currency_code: 'AUD' }), ctx('fund-a'))).status).toBe(200);
    expect(db.tables.entity_expense_items[0]).toMatchObject({ entity_kind: 'smsf', smsf_fund_id: 'fund-a' });
    expect((await POST(post({ expense_type: 'loan_principal', expense_name: 'x', amount: 1, frequency: 'monthly', currency_code: 'AUD' }), ctx('fund-a'))).status).toBe(422);
  });
});

describe('Company, Family Trust and HUF income and expenses: the same routes, scoped to the entity kind', () => {
  it.each(['company', 'family_trust', 'huf'] as const)('%s: income and expenses are stored with the entity id and kind, never in personal tables', async (kind) => {
    const db = await world({ business_entities: [{ id: 'e1', user_id: 'user-a', entity_type: kind }, { id: 'e2', user_id: 'user-b', entity_type: kind }], entity_income_items: [], entity_expense_items: [], income_sources: [], expense_items: [] });
    const inc = await import('@/app/api/business-entities/[id]/income/route');
    const exp = await import('@/app/api/business-entities/[id]/expenses/route');
    expect((await inc.POST(post({ ...RENT, income_type: 'distributions', income_name: 'Distribution' }), ctx('e1'))).status).toBe(200);
    expect((await exp.POST(post({ expense_type: 'admin_fees', expense_name: 'Fees', amount: 100, frequency: 'monthly', currency_code: 'AUD' }), ctx('e1'))).status).toBe(200);
    expect(db.tables.entity_income_items[0]).toMatchObject({ entity_kind: kind, business_entity_id: 'e1', user_id: 'user-a' });
    expect(db.tables.entity_expense_items[0]).toMatchObject({ entity_kind: kind, business_entity_id: 'e1' });
    expect(db.tables.income_sources).toHaveLength(0);
    expect(db.tables.expense_items).toHaveLength(0);
    // another household's entity: 404, no write
    const before = db.writes.length;
    expect((await inc.POST(post(RENT), ctx('e2'))).status).toBe(404);
    expect(db.writes.length).toBe(before);
  });
});

describe('SMSF bank actuals: the fund\'s own lines only, in exactly one world', () => {
  const raw = () => {
    const r = emptyRawLedger();
    r.accounts = [
      { id: 'smsf-bank', account_type: 'transaction', display_name: 'SMSF cash hub', currency_code: 'AUD', owner_role: 'smsf', liability_id: null },
      { id: 'my-bank', account_type: 'transaction', display_name: 'My bank', currency_code: 'AUD', owner_role: 'self', liability_id: null },
    ];
    r.statements = [
      { id: 's1', financial_account_id: 'smsf-bank', statement_period_start: '2026-09-01', statement_period_end: '2026-09-30', document_type: 'bank_statement' },
      { id: 's2', financial_account_id: 'my-bank', statement_period_start: '2026-09-01', statement_period_end: '2026-09-30', document_type: 'bank_statement' },
    ];
    const txn = (id: string, account: string, stmt: string, type: string, amount: number, dir: 'credit' | 'debit') => ({
      id, financial_account_id: account, statement_upload_id: stmt, transaction_date: '2026-09-10', amount_original: amount, currency_original: 'AUD', credit_debit: dir,
      economic_transaction_type: type, category_id: null, subcategory_id: null, description_clean: id, dedup_status: 'unique', approval_status: 'approved', user_override: false,
    });
    r.transactions = [
      txn('smsf-rent', 'smsf-bank', 's1', 'income', 2_600, 'credit'),
      txn('smsf-fee', 'smsf-bank', 's1', 'expense', 500, 'debit'),
      txn('smsf-xfer', 'smsf-bank', 's1', 'transfer', 1_000, 'debit'),
      txn('my-salary', 'my-bank', 's2', 'income', 9_999, 'credit'),
      txn('my-coffee', 'my-bank', 's2', 'expense', 40, 'debit'),
    ] as never;
    return r;
  };
  const window = explicitWindow('2026-09-01', '2026-09-30');
  const ledger = normaliseLedger(raw(), fxContext('AUD', 56, 'AU'), window);

  it('only the fund\'s own lines become actuals: money in 2,600, spending 500, the transfer is counted aside, the household lines are not here', () => {
    const a = computeSmsfBankActuals(ledger, 'AUD');
    expect(a.totals).toEqual({ incomeReporting: 2_600, spendingReporting: 500, costOfDebtReporting: 0, netReporting: 2_100 });
    expect(a.lineCount).toBe(2);
    expect(a.otherLineCount).toBe(1);
    expect(a.months.map((m) => m.month)).toEqual(['2026-09']);
  });

  it('NEVER in both worlds: every fund line is not a household line, every household line is not a fund line, and together they are the whole ledger', () => {
    const fund = ledger.lines.filter(isSmsfLedgerLine);
    const household = ledger.lines.filter((l) => l.household);
    expect(fund.map((l) => l.transactionId).sort()).toEqual(['smsf-fee', 'smsf-rent', 'smsf-xfer']);
    expect(household.map((l) => l.transactionId).sort()).toEqual(['my-coffee', 'my-salary']);
    expect(fund.some((l) => l.household)).toBe(false);
    expect(fund.length + household.length).toBe(ledger.lines.length);
  });

  it('NEGATIVE CONTROL: an account NOT owned by the SMSF contributes nothing to the actuals', () => {
    const r = raw();
    r.accounts[0] = { ...r.accounts[0], owner_role: 'self' };
    const l = normaliseLedger(r, fxContext('AUD', 56, 'AU'), window);
    expect(computeSmsfBankActuals(l, 'AUD').lineCount).toBe(0);
  });
});
