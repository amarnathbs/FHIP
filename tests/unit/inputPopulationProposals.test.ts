/**
 * WP-15 acceptance -- the Input Population Proposal (original FDH scope
 * p.428-457; PO D-02, D-04).
 *
 *  (a) "Update your planned expenses from your actual spending": trailing-3-
 *      complete-month averages of approved spending, per planned item, over
 *      COVERED months only, proposed as add / update / keep.
 *  (b) "Add your bank balance to Assets": latest approved closing balance per
 *      ordinary bank account, proposed as ONE cash asset per account.
 *
 * Oracles are hand-computed. Nothing is copied transaction-by-transaction,
 * and applying the proposal must not change the combined (downstream) figure:
 * planned and actual are compared per group, never added.
 *
 * NEGATIVE CONTROL: on the base branch (f79374f) none of
 * lib/import-bridge/populationProposals.ts, populationProposalService.ts or
 * migration 0214 exist -- there was no route from approved spending or a
 * statement balance into expense_items / assets at all -- so this file fails at
 * import. The RPC half (atomic / idempotent / stale-safe apply) is proven in
 * scripts/canonical_0214_pglite_verification.mjs against the real schema.
 */
import { describe, expect, it } from 'vitest';

import { computeExpenses, type ExpenseItemRow } from '@/lib/read-models/expenses';
import { computeAssets } from '@/lib/read-models/assets';
import { fxContext } from '@/lib/read-models/core/currency';
import { applyBankBalanceProposal, applyExpenseProposals, previewBankBalances, previewExpensePopulation, type PopulationClient } from '@/lib/import-bridge/populationProposalService';
import type { ExpensePopulationResult } from '@/lib/import-bridge/populationProposals';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { account, CAT, expenseItem, link, profile, statement, SUB, tables, taxonomy, txn, USER } from './readModels/helpers/fixtures';
import { loadApprovedLedger, normaliseLedger } from '@/lib/read-models/core/ledger';
import { explicitWindow } from '@/lib/read-models/core/window';

const NOW = new Date('2026-09-26T02:00:00Z'); // Sydney 26 Sep -> window Jun-Aug 2026
const EXTRA_SUB = { coffee: 'sub-coffee', alcohol: 'sub-alcohol' };
const extraTaxonomy = {
  fdh_subcategories: [
    { id: EXTRA_SUB.coffee, category_id: CAT.food, display_name: 'Cafes & Coffee', fhip_mapping_key: 'food.cafes_coffee', essential_discretionary: 'discretionary' },
    { id: EXTRA_SUB.alcohol, category_id: CAT.food, display_name: 'Alcohol / Liquor', fhip_mapping_key: 'food.alcohol_liquor', essential_discretionary: 'discretionary' },
  ],
};
const catalogue = {
  master_financial_items: [
    { category: 'expense', item_key: 'groceries', item_label: 'Groceries' },
    { category: 'expense', item_key: 'restaurants', item_label: 'Restaurants' },
    { category: 'expense', item_key: 'coffee', item_label: 'Coffee' },
  ],
};
/** Bank account 'bank' covered Jun, Jul and Aug by three approved statements. */
const bank3 = () => tables(
  { fdh_financial_accounts: [account('bank')] },
  { fdh_statement_uploads: [statement('s-jun', 'bank', '2026-06-01', '2026-06-30'), statement('s-jul', 'bank', '2026-07-01', '2026-07-31'), statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] },
);
const plan = (id: string, key: string, amount: number, frequency: string, extra: Row = {}) =>
  ({ ...expenseItem(id, key, amount, frequency, { master_item_key: key, ...extra }), updated_at: '2026-09-01T00:00:00Z' });

async function preview(t: Record<string, Row[]>, currency: 'AUD' | 'INR' = 'AUD'): Promise<ExpensePopulationResult> {
  const { client } = makeFakeSupabase(tables(profile(currency, currency === 'INR' ? 'IN' : 'AU'), taxonomy(), extraTaxonomy, catalogue, t));
  const r = await previewExpensePopulation(USER, client, { now: NOW });
  if (r.status !== 'ok') throw new Error(`unavailable ${r.reason} ${r.source}`);
  return r;
}
const item = (r: ExpensePopulationResult, key: string) => r.items.find((i) => i.masterItemKey === key);
const fieldMap = (r: ExpensePopulationResult, key: string) => Object.fromEntries(item(r, key)!.draft.fields.map((f) => [f.fieldName, [f.proposedValue, f.existingValue]]));

const woolies = () => [
  txn({ id: 'g-jun', account: 'bank', statement: 's-jun', date: '2026-06-10', amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'Woolworths' }),
  txn({ id: 'g-jul', account: 'bank', statement: 's-jul', date: '2026-07-10', amount: 220, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'Woolworths' }),
  txn({ id: 'g-aug', account: 'bank', statement: 's-aug', date: '2026-08-10', amount: 180, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'Woolworths' }),
];

describe('(a) planned expenses from actual averages', () => {
  it('Groceries: 200 + 220 + 180 over 3 covered months = 200/month; plan 800 -> UPDATE proposal 800 -> 200 monthly', async () => {
    const r = await preview(tables(bank3(), { fdh_transactions: woolies() }, { expense_items: [plan('p-groc', 'groceries', 800, 'monthly')] }));
    expect(r.window.coveredMonths).toEqual(['2026-06', '2026-07', '2026-08']);
    const g = item(r, 'groceries')!;
    expect(g).toMatchObject({ actualMonthly: 200, recommended: 'update_existing', group: 'food', coveredLineCount: 3 });
    expect(g.draft).toMatchObject({ targetDomain: 'expense', sourceKind: 'bank_statement', targetEntityId: 'p-groc', recommendedApplyMode: 'update_existing', currencyCode: 'AUD' });
    expect(fieldMap(r, 'groceries')).toEqual({ amount: ['200.00', '800.00'], frequency: ['monthly', 'monthly'], currency_code: ['AUD', 'AUD'] });
  });

  it('Restaurants with no plan: ADD proposal (name, item, category, amount, monthly, currency, not essential); average is over ALL covered months (120 in Jul -> 40/month)', async () => {
    const r = await preview(tables(bank3(), { fdh_transactions: [txn({ account: 'bank', statement: 's-jul', date: '2026-07-05', amount: 120, type: 'expense', category: CAT.food, subcategory: SUB.restaurants })] }));
    expect(item(r, 'restaurants')).toMatchObject({ actualMonthly: 40, recommended: 'add_new', existing: null });
    expect(fieldMap(r, 'restaurants')).toEqual({
      expense_name: ['Restaurants', null], master_item_key: ['restaurants', null], expense_category: ['food', null], amount: ['40.00', null],
      frequency: ['monthly', null], currency_code: ['AUD', null], is_essential: ['false', null],
    });
  });

  it('KEEP when the plan already matches in monthly terms (150 quarterly = 50/month = actual 50)', async () => {
    const r = await preview(tables(bank3(),
      { fdh_transactions: [50, 50, 50].map((a, i) => txn({ account: 'bank', statement: ['s-jun', 's-jul', 's-aug'][i], date: `2026-0${6 + i}-03`, amount: a, type: 'expense', category: CAT.food, subcategory: EXTRA_SUB.coffee })) },
      { expense_items: [plan('p-coffee', 'coffee', 150, 'quarterly')] }));
    expect(item(r, 'coffee')).toMatchObject({ actualMonthly: 50, recommended: 'keep_existing' });
  });

  it('an INACTIVE planned row for the item is reactivated by update (the (user, master_item_key) unique key covers it), never duplicated', async () => {
    const r = await preview(tables(bank3(), { fdh_transactions: woolies() }, { expense_items: [plan('p-old', 'groceries', 300, 'monthly', { is_active: false })] }));
    expect(item(r, 'groceries')).toMatchObject({ recommended: 'update_existing' });
    expect(fieldMap(r, 'groceries').is_active).toEqual(['true', 'false']);
  });

  it('spending with no single planned item (alcohol) is listed with its average and reason, never guessed', async () => {
    const r = await preview(tables(bank3(), { fdh_transactions: [txn({ account: 'bank', statement: 's-aug', date: '2026-08-02', amount: 90, type: 'expense', category: CAT.food, subcategory: EXTRA_SUB.alcohol })] }));
    expect(r.items).toEqual([]);
    expect(r.unmatched).toEqual([{ key: 'food.alcohol_liquor', label: 'Alcohol / Liquor', group: 'food', groupLabel: 'Food & dining', actualMonthly: 30, reason: 'no_single_planned_item' }]);
  });

  it('a line in a month no approved statement fully covers is shown as partial-only, never averaged or proposed', async () => {
    const r = await preview(tables({ fdh_financial_accounts: [account('bank')] }, { fdh_transactions: [txn({ account: 'bank', date: '2026-08-02', amount: 75, type: 'expense', category: CAT.food, subcategory: SUB.restaurants })] }));
    expect(r.items).toEqual([]);
    expect(r.partialOnly).toEqual([{ masterItemKey: 'restaurants', label: 'Restaurants', lineCount: 1 }]);
  });

  it('credit card: purchases 200 + 20 and the linked 220 repayment -> groceries 200 + restaurants 20 (spending 220, never 440)', async () => {
    const r = await preview(tables(
      { fdh_financial_accounts: [account('bank'), account('card', 'credit_card', { liability_id: 'L-card' })] },
      { fdh_statement_uploads: [statement('s-bank', 'bank', '2026-08-01', '2026-08-31'), statement('s-card', 'card', '2026-08-01', '2026-08-31', { document_type: 'credit_card_statement' })] },
      { fdh_transactions: [
        txn({ id: 'p1', account: 'card', statement: 's-card', date: '2026-08-03', amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
        txn({ id: 'p2', account: 'card', statement: 's-card', date: '2026-08-09', amount: 20, type: 'expense', category: CAT.food, subcategory: SUB.restaurants }),
        txn({ id: 'pay-card', account: 'card', statement: 's-card', date: '2026-08-28', amount: 220, type: 'transfer', cd: 'credit', category: CAT.ccPayment }),
        txn({ id: 'pay-bank', account: 'bank', statement: 's-bank', date: '2026-08-28', amount: 220, type: 'expense', category: CAT.ccPayment }),
      ] },
      { fdh_transaction_links: [link('lnk', 'pay-bank', 'pay-card', 'credit_card_settlement')] },
    ));
    const total = r.items.reduce((s, i) => s + i.actualMonthly, 0) + r.unmatched.reduce((s, u) => s + u.actualMonthly, 0);
    expect(item(r, 'groceries')?.actualMonthly).toBe(200);
    expect(item(r, 'restaurants')?.actualMonthly).toBe(20);
    expect(total).toBe(220);
  });

  it('cash withdrawals, transfers, loan interest on a facility and SMSF accounts never become a planned item', async () => {
    const r = await preview(tables(
      { fdh_financial_accounts: [account('bank'), account('loan', 'personal_loan', { liability_id: 'L-loan' }), account('smsf', 'transaction', { owner_role: 'smsf' })] },
      { fdh_statement_uploads: [statement('s-b', 'bank', '2026-08-01', '2026-08-31'), statement('s-l', 'loan', '2026-08-01', '2026-08-31'), statement('s-s', 'smsf', '2026-08-01', '2026-08-31')] },
      { fdh_transactions: [
        txn({ account: 'bank', statement: 's-b', date: '2026-08-02', amount: 300, type: 'cash_withdrawal', category: CAT.cash }),
        txn({ account: 'bank', statement: 's-b', date: '2026-08-03', amount: 500, type: 'transfer', category: CAT.transfer }),
        txn({ account: 'loan', statement: 's-l', date: '2026-08-04', amount: 430, type: 'debt_interest', category: CAT.loanInterest }),
        txn({ account: 'smsf', statement: 's-s', date: '2026-08-05', amount: 1000, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
      ] },
    ));
    expect(r.items).toEqual([]);
    expect(r.unmatched).toEqual([]);
  });

  it('a confirmed refund nets against the planned item of its ORIGINAL purchase (200 - 50 = 150)', async () => {
    const r = await preview(tables(
      { fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] },
      { fdh_transactions: [
        txn({ id: 'buy', account: 'bank', statement: 's-aug', date: '2026-08-03', amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
        txn({ id: 'ref', account: 'bank', statement: 's-aug', date: '2026-08-06', amount: 50, type: 'refund', category: CAT.refund }),
      ] },
      { fdh_transaction_links: [link('r1', 'ref', 'buy', 'refund_original')] },
    ));
    expect(item(r, 'groceries')?.actualMonthly).toBe(150);
  });

  it('an SMSF-owned planned row is never updated with household spending (listed instead)', async () => {
    const r = await preview(tables(bank3(), { fdh_transactions: woolies() }, { expense_items: [plan('p-smsf', 'groceries', 800, 'monthly', { owner: 'smsf' })] }));
    expect(item(r, 'groceries')).toBeUndefined();
    expect(r.unmatched[0]).toMatchObject({ reason: 'planned_item_smsf_owned', actualMonthly: 200 });
  });

  it('INR household: AUD spending converted once at the shared rate (200 AUD x 56 = 11,200 INR/month)', async () => {
    const r = await preview(tables(bank3(), { fdh_transactions: woolies() }), 'INR');
    expect(item(r, 'groceries')?.actualMonthly).toBe(11200);
    expect(item(r, 'groceries')?.draft.currencyCode).toBe('INR');
  });

  it('a failed read is unavailable (never an empty proposal that would read as "nothing to update")', async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), catalogue, bank3(), { fdh_transactions: woolies() }), { failOn: new Set(['fdh_transactions']) });
    const r = await previewExpensePopulation(USER, client, { now: NOW });
    expect(r.status).toBe('unavailable');
  });

  it('DOWNSTREAM DOES NOT DOUBLE COUNT: applying every proposal leaves the combined figure unchanged and makes planned = actual', async () => {
    const t = tables(profile(), taxonomy(), extraTaxonomy, catalogue, bank3(),
      { fdh_transactions: [...woolies(), txn({ account: 'bank', statement: 's-jul', date: '2026-07-05', amount: 120, type: 'expense', category: CAT.food, subcategory: SUB.restaurants })] },
      { expense_items: [plan('p-groc', 'groceries', 800, 'monthly')] });
    const { client } = makeFakeSupabase(t);
    const fx = fxContext('AUD', 56, 'AU');
    const window = explicitWindow('2026-06-01', '2026-08-31', '2026-09-26');
    const ledger = normaliseLedger(await loadApprovedLedger(USER, client, window), fx, window);
    const r = await previewExpensePopulation(USER, client, { now: NOW });
    if (r.status !== 'ok') throw new Error('unavailable');

    const before = computeExpenses({ plannedRows: t.expense_items as unknown as ExpenseItemRow[], liabilities: [], ledger, fx });
    // Simulate the RPC: add / update exactly the proposed fields.
    const after: ExpenseItemRow[] = (t.expense_items as unknown as ExpenseItemRow[]).map((p) => ({ ...p }));
    for (const i of r.items) {
      const f = Object.fromEntries(i.draft.fields.map((x) => [x.fieldName, x.proposedValue]));
      if (i.recommended === 'add_new') after.push({ id: `new-${i.masterItemKey}`, expense_name: f.expense_name!, expense_category: f.expense_category!, amount: Number(f.amount), frequency: f.frequency!, currency_code: f.currency_code!, is_essential: f.is_essential === 'true', master_item_key: i.masterItemKey, owner: 'self', superseded_by_bank_import: false });
      else if (i.recommended === 'update_existing') Object.assign(after.find((p) => p.id === i.draft.targetEntityId)!, { amount: Number(f.amount), frequency: f.frequency, currency_code: f.currency_code });
    }
    const applied = computeExpenses({ plannedRows: after, liabilities: [], ledger, fx });

    expect(before.planned.monthly).toBe(800);
    expect(before.actual.monthly).toBe(240); // 200 groceries + 40 restaurants
    expect(before.combined.monthly).toBe(240);
    expect(applied.combined.monthly).toBe(240); // unchanged: never planned + actual
    expect(applied.planned.monthly).toBe(240); // the plan now matches actual
    expect(after.filter((p) => p.master_item_key === 'groceries')).toHaveLength(1); // updated, not duplicated
  });
});

// ---------------------------------------------------------------------------

describe('(b) bank balance -> cash asset (PO D-04)', () => {
  const stmt = (id: string, acc: string, end: string) => statement(id, acc, `${end.slice(0, 8)}01`, end);
  const recon = (sid: string, bal: number, currency = 'AUD') => ({ user_id: USER, statement_upload_id: sid, reported_closing_balance: bal, currency_code: currency, created_at: '2026-09-01T00:00:00Z' });
  const asset = (id: string, extra: Row = {}): Row => ({
    id, user_id: USER, asset_name: `Asset ${id}`, asset_class: 'cash', master_item_key: null, current_value: 100, currency_code: 'AUD', valuation_date: null, owner: 'self',
    is_active: true, source_type: 'manual', source_financial_account_id: null, linked_liability_id: null, updated_at: '2026-09-01T00:00:00Z', ...extra,
  });
  async function balances(t: Record<string, Row[]>, targets?: Map<string, string>) {
    const { client } = makeFakeSupabase(tables(profile(), t));
    const r = await previewBankBalances(USER, client, { targetAssetIdByAccount: targets });
    if (r.status !== 'ok') throw new Error(`unavailable ${r.reason} ${r.source}`);
    return r.items;
  }

  it('no asset yet: ADD one cash asset at the LATEST statement\'s closing balance (6000, not the older 5000), owner from the account (joint)', async () => {
    const items = await balances(tables(
      { fdh_financial_accounts: [account('bank', 'transaction', { owner_role: 'joint', display_name: 'Everyday' })] },
      { fdh_statement_uploads: [stmt('s-jul', 'bank', '2026-07-31'), stmt('s-aug', 'bank', '2026-08-31')] },
      { fdh_reconciliation_results: [recon('s-jul', 5000), recon('s-aug', 6000)] },
    ));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: 'proposed', recommended: 'add_new', closingBalance: 6000, statementUploadId: 's-aug', asOf: '2026-08-31' });
    expect(Object.fromEntries(items[0].draft!.fields.map((f) => [f.fieldName, f.proposedValue]))).toEqual({
      asset_name: 'Everyday', asset_class: 'cash', current_value: '6000.00', currency_code: 'AUD', valuation_date: '2026-08-31', owner: 'joint',
    });
  });

  it('the account already feeds an asset: UPDATE that asset; identical value + date: up to date (no proposal)', async () => {
    const base = () => tables({ fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [stmt('s-aug', 'bank', '2026-08-31')] }, { fdh_reconciliation_results: [recon('s-aug', 6000)] });
    const upd = await balances(tables(base(), { assets: [asset('a1', { source_financial_account_id: 'bank', current_value: 5000, source_type: 'bank_statement_import', valuation_date: '2026-07-31' })] }));
    expect(upd[0]).toMatchObject({ state: 'proposed', recommended: 'update_existing', linkedAsset: { id: 'a1', value: 5000 } });
    expect(upd[0].draft!.targetEntityId).toBe('a1');
    expect(upd[0].draft!.fields.map((f) => [f.fieldName, f.proposedValue, f.existingValue])).toEqual([
      ['current_value', '6000.00', '5000.00'], ['currency_code', 'AUD', 'AUD'], ['valuation_date', '2026-08-31', '2026-07-31'],
    ]);
    const same = await balances(tables(base(), { assets: [asset('a1', { source_financial_account_id: 'bank', current_value: 6000, valuation_date: '2026-08-31' })] }));
    expect(same[0]).toMatchObject({ state: 'up_to_date', draft: null });
  });

  it('a manual cash asset that may be this account is offered for update (so the money is not counted twice)', async () => {
    const t = tables({ fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [stmt('s-aug', 'bank', '2026-08-31')] }, { fdh_reconciliation_results: [recon('s-aug', 6000)] },
      { assets: [asset('manual-sav', { master_item_key: 'savings_account', asset_class: 'other', current_value: 5500 }), asset('house', { asset_class: 'property', current_value: 900000 })] });
    const add = await balances(t);
    expect(add[0].recommended).toBe('add_new');
    expect(add[0].possibleDuplicates.map((d) => d.id)).toEqual(['manual-sav']);
    expect(add[0].draft!.summary.reviewReasons[0]).toMatch(/not counted twice/);
    const chosen = await balances(t, new Map([['bank', 'manual-sav']]));
    expect(chosen[0]).toMatchObject({ recommended: 'update_existing' });
    expect(chosen[0].draft!.targetEntityId).toBe('manual-sav');
  });

  it('SMSF accounts, overdrawn balances, unsupported currencies and kept statements are shown, never proposed', async () => {
    const items = await balances(tables(
      { fdh_financial_accounts: [account('smsf', 'transaction', { owner_role: 'smsf' }), account('od'), account('usd', 'transaction', { currency_code: 'USD' }), account('kept')] },
      { fdh_statement_uploads: [stmt('s1', 'smsf', '2026-08-31'), stmt('s2', 'od', '2026-08-31'), stmt('s3', 'usd', '2026-08-31'), stmt('s4', 'kept', '2026-08-31')] },
      { fdh_reconciliation_results: [recon('s1', 50000), recon('s2', -40), recon('s3', 700, 'USD'), recon('s4', 10)] },
      { fhip_import_proposals: [{ user_id: USER, target_domain: 'asset', source_kind: 'bank_statement', source_statement_upload_id: 's4', status: 'dismissed', id: 'x' }] },
    ));
    const by = Object.fromEntries(items.map((i) => [i.accountId, i]));
    expect(by.smsf).toMatchObject({ state: 'smsf_account', draft: null });
    expect(by.od).toMatchObject({ state: 'overdrawn', draft: null });
    expect(by.usd).toMatchObject({ state: 'unsupported_currency', draft: null });
    expect(by.kept).toMatchObject({ state: 'kept_by_you', draft: null });
  });

  it('a card / loan facility statement is never offered as a cash asset', async () => {
    const items = await balances(tables({ fdh_financial_accounts: [account('card', 'credit_card')] }, { fdh_statement_uploads: [stmt('s-c', 'card', '2026-08-31')] }, { fdh_reconciliation_results: [recon('s-c', 300)] }));
    expect(items).toEqual([]);
  });

  it('NEVER DOUBLE COUNTED: the evidence bucket is outside every total; once applied, the balance counts once, through its asset', () => {
    const fx = fxContext('AUD', 56, 'AU');
    const common = { bankAccounts: [{ id: 'bank', account_type: 'transaction', display_name: 'Everyday', currency_code: 'AUD' }], statements: [{ id: 's-aug', financial_account_id: 'bank', statement_period_end: '2026-08-31', approved_at: null }], reconciliations: [{ statement_upload_id: 's-aug', reported_closing_balance: 6000, currency_code: 'AUD', created_at: null }], fx };
    const before = computeAssets({ ...common, assets: [] });
    expect(before.total).toBe(0);
    expect(before.bankBalanceEvidence.total).toBe(6000);
    expect(before.bankBalanceEvidence.accounts[0].inNetWorthAs).toBeNull();
    const after = computeAssets({ ...common, assets: [{ id: 'a1', asset_name: 'Everyday', asset_class: 'cash', current_value: 6000, currency_code: 'AUD', owner: 'joint', master_item_key: null, source_type: 'bank_statement_import', linked_liability_id: null, source_financial_account_id: 'bank' }] });
    expect(after.total).toBe(6000); // once
    expect(after.bankBalanceEvidence.accounts[0].inNetWorthAs).toEqual({ assetId: 'a1', assetName: 'Everyday' });
    expect(after.lines[0].provenance).toMatchObject({ kind: 'bank_statement', label: 'Imported from bank statement', accountId: 'bank' });
  });

  it('a database without 0214 still reads assets (every asset unlinked), never "unavailable"', async () => {
    const { client } = makeFakeSupabase(tables(profile(), { fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [stmt('s-aug', 'bank', '2026-08-31')] }, { fdh_reconciliation_results: [recon('s-aug', 6000)] }, { assets: [asset('a1')] }),
      { missingColumns: { assets: ['source_financial_account_id'] } });
    const { selectAssets } = await import('@/lib/read-models/assets');
    const r = await selectAssets(USER, { client });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.lines.map((l) => l.id)).toEqual(['a1']);
  });
});

describe('apply wrappers: one RPC call each, refusals passed through verbatim', () => {
  const stub = (data: unknown, error: { message: string } | null = null) => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const client = { from: () => { throw new Error('no table access expected'); }, rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return Promise.resolve({ data, error }); } } as unknown as PopulationClient;
    return { client, calls };
  };

  it('expense batch: sends every decision to fdh15_apply_expense_proposals in one call', async () => {
    const { client, calls } = stub({ ok: true, results: [{ ok: true, outcome: 'applied', proposal_id: 'p1', target_entity_id: 't1' }] });
    const r = await applyExpenseProposals(client, [{ proposalId: 'p1', decision: 'update_existing' }, { proposalId: 'p2', decision: 'add_new', selectedFields: ['amount'] }]);
    expect(calls).toEqual([{ fn: 'fdh15_apply_expense_proposals', args: { p_decisions: [{ proposal_id: 'p1', decision: 'update_existing' }, { proposal_id: 'p2', decision: 'add_new', selected_fields: ['amount'] }] } }]);
    expect(r).toEqual({ ok: true, results: [{ proposalId: 'p1', outcome: 'applied', targetEntityId: 't1' }] });
  });

  it('a stale batch comes back as STALE_PROPOSAL with rolledBack', async () => {
    const { client } = stub({ ok: false, code: 'STALE_PROPOSAL', error: 'changed', proposal_id: 'p2', field: 'amount', rolled_back: true });
    expect(await applyExpenseProposals(client, [{ proposalId: 'p2', decision: 'update_existing' }])).toEqual({ ok: false, code: 'STALE_PROPOSAL', error: 'changed', proposalId: 'p2', field: 'amount', rolledBack: true });
  });

  it('asset: fdh15_apply_asset_proposal; transport error is WRITE_FAILED (never reported as applied)', async () => {
    const { client, calls } = stub(null, { message: 'network' });
    const r = await applyBankBalanceProposal(client, { proposalId: 'p9', decision: 'add_new' });
    expect(calls[0]).toEqual({ fn: 'fdh15_apply_asset_proposal', args: { p_proposal_id: 'p9', p_decision: 'add_new', p_selected_fields: null } });
    expect(r).toEqual({ ok: false, code: 'WRITE_FAILED', error: 'network' });
  });
});
