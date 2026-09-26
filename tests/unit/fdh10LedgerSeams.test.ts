/**
 * WP-11 seams around the ledger Apply:
 *  - Statement history loader (G7): which statements belong to a liability,
 *    what each line became, paged past PostgREST's 1000-row cap, fail closed;
 *  - the post-bank-approval back-match plan (G4): the certified "never amount
 *    alone" rule, one bank debit per repayment;
 *  - the R8 classifier (0209 rows): a source-typed ledger row keeps its
 *    economic type, and a confirmed settlement bank leg stays a transfer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadLiabilityStatementHistory } from '@/lib/import-bridge/liabilityStatementHistory';
import { planLiabilityBackMatches, type ApprovedBankDebit, type OpenRepayment } from '@/lib/import-bridge/liabilityBankBackMatch';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';

const U = 'user-1';
const OTHER = 'user-2';

describe('Statement history loader (G7)', () => {
  function tables(activityCount = 2): Record<string, Row[]> {
    const acts: Row[] = Array.from({ length: activityCount }, (_, i) => ({
      id: `a-${String(i).padStart(5, '0')}`, user_id: U, statement_id: 's-new', activity_type: i === 0 ? 'PAYMENT' : 'PURCHASE', activity_date: '2026-08-10', amount: i === 0 ? 2000 : 1,
      currency_code: 'AUD', description_raw: `line ${i}`, gst_amount_raw: null, bank_match_status: i === 0 ? 'matched' : 'not_attempted',
      ledger_disposition: 'ledger_row', ledger_transaction_id: `t-${i}`, ledger_duplicate_of_transaction_id: null, source_row_number: i + 1,
    }));
    return {
      liabilities: [{ id: 'L1', user_id: U, liability_name: 'Loan', currency_code: 'AUD', source_type: 'liability_statement_import', last_imported_at: null }],
      fdh_liability_statements: [
        { id: 's-new', user_id: U, liability_id: 'L1', statement_type: 'loan', currency_code: 'AUD', statement_period_end: '2026-08-31', ledger_status: 'applied', approval_status: 'approved', reconciliation_status: 'reconciled', drawdowns_total: 5000, extraction_warnings: [] },
        { id: 's-old', user_id: U, liability_id: null, statement_type: 'loan', currency_code: 'AUD', statement_period_end: '2026-07-31', ledger_status: 'not_applied', approval_status: 'approved', reconciliation_status: 'reconciled', extraction_warnings: [{ code: 'zero_amount', row: 2 }] },
        { id: 's-foreign', user_id: OTHER, liability_id: 'L1', statement_type: 'loan', currency_code: 'AUD', ledger_status: 'applied', approval_status: 'approved' },
      ],
      fhip_import_applications: [{ id: 'app-1', user_id: U, target_domain: 'liability', target_entity_id: 'L1', source_liability_statement_id: 's-old' }],
      fhip_import_proposals: [],
      fdh_liability_statement_activities: acts,
      fdh_transactions: [
        { id: 't-0', user_id: U, credit_debit: 'credit', economic_transaction_type: 'debt_principal', amount_original: 2000 },
        ...acts.slice(1).map((a, i) => ({ id: `t-${i + 1}`, user_id: U, credit_debit: 'debit', economic_transaction_type: 'expense', amount_original: a.amount })),
      ],
      fdh_transaction_allocations: [
        { transaction_id: 't-0', user_id: U, allocation_sequence: 2, economic_transaction_type: 'debt_interest', amount: 430 },
        { transaction_id: 't-0', user_id: U, allocation_sequence: 1, economic_transaction_type: 'debt_principal', amount: 1550 },
        { transaction_id: 't-0', user_id: U, allocation_sequence: 3, economic_transaction_type: 'fee', amount: 20 },
      ],
      fdh_transaction_links: [{ id: 'l1', user_id: U, transaction_id_to: 't-0', status: 'confirmed', link_type: 'loan_payment' }],
    };
  }

  it('lists the linked statement AND the one applied before 0209 (recordable), never another user\'s', async () => {
    const { client } = makeFakeSupabase(tables());
    const h = await loadLiabilityStatementHistory(client, U, 'L1');
    expect(h!.statements.map((s) => [s.id, s.can_record])).toEqual([['s-new', false], ['s-old', true]]);
    expect(h!.statements[1].extraction_warnings).toEqual([{ code: 'zero_amount', row: 2 }]);
    expect(h!.statements[0].totals.drawdowns).toBe(5000);
  });

  it('each line carries what it became: the repayment split in order, and its confirmed bank settlement', async () => {
    const { client } = makeFakeSupabase(tables());
    const h = await loadLiabilityStatementHistory(client, U, 'L1');
    const repayment = h!.statements[0].activities[0];
    expect(repayment.ledger).toMatchObject({ economic_transaction_type: 'debt_principal', amount: 2000, settlement_link_status: 'confirmed' });
    expect(repayment.ledger!.allocations).toEqual([
      { economic_transaction_type: 'debt_principal', amount: 1550 },
      { economic_transaction_type: 'debt_interest', amount: 430 },
      { economic_transaction_type: 'fee', amount: 20 },
    ]);
  });

  it('pages past the 1000-row cap: a statement with 1,001 lines shows 1,001 lines', async () => {
    const { client, requests } = makeFakeSupabase(tables(1001));
    const h = await loadLiabilityStatementHistory(client, U, 'L1');
    expect(h!.statements[0].activities).toHaveLength(1001);
    expect(requests.filter((r) => r.table === 'fdh_liability_statement_activities').length).toBeGreaterThanOrEqual(2);
  });

  it("another user's liability id -> null (the route answers 404); a failed read fails CLOSED, never 'no history'", async () => {
    const { client } = makeFakeSupabase(tables());
    expect(await loadLiabilityStatementHistory(client, OTHER, 'L1')).toBeNull();
    const failing = makeFakeSupabase(tables(), { failOn: new Set(['fdh_transaction_allocations']) });
    await expect(loadLiabilityStatementHistory(failing.client, U, 'L1')).rejects.toThrow();
  });
});

describe('post-bank-approval back-match plan (G4)', () => {
  const rep = (id: string, extra: Partial<OpenRepayment> = {}): OpenRepayment => ({ id, statement_id: 's1', activity_type: 'PAYMENT', activity_date: '2026-08-12', amount: 300, currency_code: 'AUD', ...extra });
  const debit = (id: string, extra: Partial<ApprovedBankDebit> = {}): ApprovedBankDebit => ({ id, transaction_date: '2026-08-13', amount_original: 300, currency_original: 'AUD', description_clean: 'TEST BANK CARD PAYMENT', description_raw: null, merchant_raw: null, ...extra });
  const inst = new Map([['s1', 'Test Bank']]);

  it('matches amount + date + the lender named in the narrative', () => {
    expect(planLiabilityBackMatches([rep('r1')], [debit('d1')], inst)).toEqual([{ activityId: 'r1', bankTransactionId: 'd1' }]);
  });

  it('NEVER on amount alone: a same-amount debit that does not name the lender is not matched', () => {
    expect(planLiabilityBackMatches([rep('r1')], [debit('d1', { description_clean: 'TRANSFER TO SAVINGS' })], inst)).toEqual([]);
    expect(planLiabilityBackMatches([rep('r1')], [debit('d1')], new Map([['s1', null]]))).toEqual([]);
  });

  it('never across currencies, never outside the date tolerance', () => {
    expect(planLiabilityBackMatches([rep('r1')], [debit('d1', { currency_original: 'INR' })], inst)).toEqual([]);
    expect(planLiabilityBackMatches([rep('r1')], [debit('d1', { transaction_date: '2026-08-30' })], inst)).toEqual([]);
  });

  it('two plausible debits for one repayment -> no auto-pick; one debit claimed by two repayments -> neither', () => {
    expect(planLiabilityBackMatches([rep('r1')], [debit('d1'), debit('d2', { transaction_date: '2026-08-11' })], inst)).toEqual([]);
    expect(planLiabilityBackMatches([rep('r1'), rep('r2', { activity_date: '2026-08-14' })], [debit('d1')], inst)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R8 classifier: a source-typed ledger row keeps its economic type.
// ---------------------------------------------------------------------------
const adminUpdates: { table: string; patch: Record<string, unknown>; id?: unknown }[] = [];
const adminInserts: { table: string; row: Record<string, unknown> }[] = [];
let transferInput: { id: string }[] = [];
let userTxns: Record<string, unknown>[] = [];
let userLinks: Record<string, unknown>[] = [];

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, { select: () => q, eq: () => q, order: () => q, range: async () => ({ data: userTxns, error: null }) });
      return q;
    },
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const entry: { table: string; patch: Record<string, unknown>; id?: unknown } = { table, patch };
        adminUpdates.push(entry);
        const chain = { eq: (col: string, v: unknown) => { if (col === 'id') entry.id = v; return chain; }, in: () => chain, then: (r: (v: unknown) => void) => r({ error: null }) };
        return chain;
      },
      insert: (row: Record<string, unknown>) => { adminInserts.push({ table, row }); return { select: () => ({ single: async () => ({ data: null, error: { message: 'x' } }) }), then: (r: (v: unknown) => void) => r({ error: null }) }; },
    }),
  }),
}));
vi.mock('@/lib/financial-data-hub/repositories', () => {
  const empty = async () => ({ data: [], error: null });
  return {
    categoriesRepository: { listActiveAll: empty }, subcategoriesRepository: { listActiveAll: empty }, merchantsRepository: { listActiveAll: empty },
    merchantAliasesRepository: { listActiveAll: empty }, globalClassificationRulesRepository: { listActiveAll: empty },
    userClassificationRulesRepository: { listForUserAll: empty },
    financialAccountsRepository: { listForUserAll: async () => ({ data: [{ id: 'card', institution_id: null, account_type: 'credit_card' }, { id: 'bank', institution_id: null, account_type: 'transaction' }], error: null }) },
    transactionLinksRepository: { listForUserAll: async () => ({ data: userLinks, error: null }) },
  };
});
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/financial-data-hub/classification/economicTypeEngine', () => ({
  // The engine "resolves" every row as income with a merchant category -- exactly what must NOT overwrite a source row's type.
  classifyTransaction: () => ({
    economicTransactionType: 'income', categoryId: 'cat-food', subcategoryId: 'sub-groceries', merchantId: 'm-1', transferFlag: false, subscriptionFlag: false,
    confidence: 'HIGH', classificationMethod: 'merchant_master', source: { kind: 'merchant', ruleId: null }, flaggedCandidate: 'transfer_candidate',
  }),
}));
vi.mock('@/lib/financial-data-hub/classification/transferMatching', () => ({
  matchInternalTransfers: (c: { id: string }[]) => { transferInput = c; return []; },
  openCandidateLink: (id: string) => ({ transactionId: id, linkType: 'internal_transfer', confidence: 0.5, evidence: {} }),
}));

const txn = (id: string, extra: Record<string, unknown>) => ({
  id, user_id: U, financial_account_id: 'bank', transaction_date: '2026-08-10', description_clean: 'x', merchant_raw: null, amount_original: 10, currency_original: 'AUD',
  credit_debit: 'debit', transaction_type_hint: 'unknown', user_override: false, economic_transaction_type: 'expense', category_id: null, subcategory_id: null, merchant_id: null,
  classification_method: 'global_rule', review_status: 'not_required', recurring_transaction_id: null, source_reference: null, ...extra,
});

describe('R8 classifier respects the ledger Apply (0209)', () => {
  beforeEach(() => { adminUpdates.length = 0; adminInserts.length = 0; transferInput = []; });

  it('a source-typed card row gets its CATEGORY only; its economic type, method and flags are untouched; it is not a transfer candidate', async () => {
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    userTxns = [
      txn('card-purchase', { financial_account_id: 'card', classification_method: 'source', economic_transaction_type: 'expense' }),
      txn('card-payment', { financial_account_id: 'card', classification_method: 'source', economic_transaction_type: 'transfer', credit_debit: 'credit' }),
      txn('ordinary', {}),
    ];
    userLinks = [];
    await classifyUserTransactions(U);
    const byId = (id: string) => adminUpdates.filter((u) => u.table === 'fdh_transactions' && u.id === id).map((u) => u.patch);
    expect(byId('card-purchase')).toEqual([{ category_id: 'cat-food', subcategory_id: 'sub-groceries', merchant_id: 'm-1' }]);
    expect(byId('card-payment')).toEqual([{ category_id: 'cat-food', subcategory_id: 'sub-groceries', merchant_id: 'm-1' }]);
    // NEGATIVE CONTROL in the same run: an ordinary row IS retyped by the engine.
    expect(byId('ordinary')[0]).toMatchObject({ economic_transaction_type: 'income', classification_method: 'merchant_master' });
    expect(transferInput.map((t) => t.id)).toEqual(['ordinary']);
    const history = adminInserts.filter((i) => i.table === 'fdh_classification_history' && i.row.transaction_id === 'card-payment');
    expect(history[0].row).toMatchObject({ previous_economic_transaction_type: 'transfer', new_economic_transaction_type: 'transfer' });
    // No open candidate link is proposed for a source row.
    expect(adminInserts.filter((i) => i.table === 'fdh_transaction_links').map((i) => i.row.transaction_id_from)).toEqual(['ordinary']);
  });

  it('a bank debit CONFIRMED as a card/loan settlement stays a transfer when the engine re-runs', async () => {
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    userTxns = [txn('bank-leg', { economic_transaction_type: 'transfer' })];
    userLinks = [{ id: 'l', transaction_id_from: 'bank-leg', transaction_id_to: 'card-payment', link_type: 'credit_card_settlement', status: 'confirmed' }];
    await classifyUserTransactions(U);
    const patches = adminUpdates.filter((u) => u.table === 'fdh_transactions' && u.id === 'bank-leg').map((u) => u.patch);
    expect(patches).toEqual([{ category_id: 'cat-food', subcategory_id: 'sub-groceries', merchant_id: 'm-1' }]);
  });
});
