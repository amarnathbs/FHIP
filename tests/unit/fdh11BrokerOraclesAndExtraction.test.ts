/**
 * WP-12 -- AU broker statements: the brief's economic oracles end to end, and
 * the extraction/persist integrity fixes (INV-G4, INV-G6, INV-G7, INV-G8,
 * INV-G2).
 *
 * DELIBERATELY BASE-COMPATIBLE: this file imports only functions that already
 * existed on the base branch (the CSV extractors, persistAuInvestmentEvidence,
 * matchAuStatementActivitiesToBank, the canonical read models), so running it
 * against the base code is a real negative control -- it fails there on the
 * assertions, not on a missing import.
 *
 * The pipeline under test is the real one: CSV bytes -> extractor -> persist
 * (fake service-role DB) -> bank matcher -> the canonical Expense / Income read
 * models over the SAME rows. Oracle numbers are the brief's:
 *   bank->broker $10,000 + BUY           -> household spending 0
 *   SELL $15,000 (bank proceeds $15,000) -> ordinary income 0
 *   dividend broker $400 + bank $400     -> income $400 (one event)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDb, type Row } from './helpers/fdh11FakeDb';
import { account, CAT, profile, statement, tables, taxonomy, txn, USER, WINDOW } from './readModels/helpers/fixtures';

const h = vi.hoisted(() => ({ db: null as unknown as { client: unknown } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { extractAuPositionsFromCsv, extractAuTransactionsFromCsv } from '@/lib/financial-data-hub/investment/csvExtraction';
import { matchAuStatementActivitiesToBank, persistAuInvestmentEvidence } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { selectExpenses } from '@/lib/read-models/expenses';
import { selectIncome } from '@/lib/read-models/income';

const csv = (s: string) => new TextEncoder().encode(s);
const TXN_MAP = { date: 'Date', type: 'Type', amount: 'Amount', ticker: 'Code', securityName: 'Security Name', quantity: 'Quantity', price: 'Price', brokerage: 'Brokerage', settlementDate: 'Settlement Date', frankingCredit: 'Franking Credit', withholdingTax: 'Withholding Tax' };
const POS_MAP = { securityName: 'Security Name', ticker: 'Code', quantity: 'Quantity', unitPrice: 'Price', marketValue: 'Market Value', valuationDate: 'Valuation Date' };

/** The FDH-2 institution master rows the matcher reads (0054 seeds). */
const institutions = (): Record<string, Row[]> => ({
  fdh_financial_institutions: [
    { id: 'inst-commsec', country_code: 'AU', institution_code: 'commsec', institution_name: 'CommSec', institution_type: 'broker' },
    { id: 'inst-selfwealth', country_code: 'AU', institution_code: 'selfwealth', institution_name: 'SelfWealth', institution_type: 'broker' },
    { id: 'inst-cba', country_code: 'AU', institution_code: 'cba', institution_name: 'Commonwealth Bank of Australia', institution_type: 'bank' },
  ],
  fdh_institution_aliases: [
    { institution_id: 'inst-commsec', alias_normalized: 'COMMSEC' },
    { institution_id: 'inst-commsec', alias_normalized: 'COMMONWEALTH SECURITIES' },
    { institution_id: 'inst-selfwealth', alias_normalized: 'SELFWEALTH' },
  ],
});

/** One household: a bank account with an APPROVED August statement, and the broker legs as the bank classifier typed them. */
function household(extraTxns: Row[] = []): Record<string, Row[]> {
  return tables(profile(), taxonomy(), institutions(), { fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31'), { id: 'doc-inv', user_id: USER, document_type: 'investment_statement', processing_status: 'queued' }] }, {
    fdh_transactions: [
      // The bank->broker funding debit, mis-typed 'expense' by the classifier.
      txn({ id: 'fund', account: 'bank', statement: 's-aug', date: '2026-08-03', amount: 10000, type: 'expense', category: CAT.investment, description: 'TRANSFER TO COMMSEC 123' }),
      // The sale proceeds credit, mis-typed 'income'.
      txn({ id: 'sell', account: 'bank', statement: 's-aug', date: '2026-08-22', amount: 15000, type: 'income', category: CAT.income, cd: 'credit', description: 'COMMONWEALTH SECURITIES SETTLEMENT' }),
      // The dividend credit, paid by the company's registry (it names BHP, not the broker).
      txn({ id: 'div', account: 'bank', statement: 's-aug', date: '2026-08-25', amount: 400, type: 'income', category: CAT.income, cd: 'credit', description: 'BHP GROUP LTD DIV AUG26' }),
      // Negative controls: same amount/date, but a DIFFERENT broker ...
      txn({ id: 'decoy-broker', account: 'bank', statement: 's-aug', date: '2026-08-03', amount: 10000, type: 'expense', category: CAT.investment, description: 'SELFWEALTH DEPOSIT' }),
      // ... the right broker but NOT approved ...
      txn({ id: 'decoy-pending', account: 'bank', statement: 's-aug', date: '2026-08-03', amount: 10000, type: 'expense', approval: 'pending', description: 'COMMSEC' }),
      // ... and the right broker but the WRONG direction (a credit cannot fund a buy).
      txn({ id: 'decoy-credit', account: 'bank', statement: 's-aug', date: '2026-08-03', amount: 10000, type: 'income', cd: 'credit', category: CAT.income, description: 'COMMSEC REFUND' }),
      ...extraTxns,
    ],
  });
}

const BROKER_CSV = [
  'Date,Type,Code,Security Name,Quantity,Price,Amount,Brokerage,Settlement Date,Franking Credit,Withholding Tax',
  '03/08/2026,CASH_DEPOSIT,,,,,"10,000.00",,,,',
  '04/08/2026,BUY,BHP,BHP Group Ltd,200,49.90,9980.00,$19.95,06/08/2026,,',
  '20/08/2026,SELL,CBA,Commonwealth Bank,100,150.00,"15,000.00",$29.95,22/08/2026,,',
  '25/08/2026,DIVIDEND,BHP,BHP Group Ltd,,,400.00,,,$171.43,$0.00',
].join('\n');

async function importBrokerStatement(institutionName: string | undefined) {
  const ex = extractAuTransactionsFromCsv({ bytes: csv(BROKER_CSV), columnMap: TXN_MAP, currencyCode: 'AUD', institutionName });
  if (!ex.ok) throw new Error(ex.error);
  const { statementId } = await persistAuInvestmentEvidence({ userId: USER, documentId: 'doc-inv', statementType: 'investment_transaction_csv', extraction: ex.extraction });
  return statementId;
}

function approve(db: FakeDb, statementId: string) {
  const s = db.rows('fdh_investment_statements').find((r) => r.id === statementId)!;
  s.approval_status = 'approved';
}

const activity = (db: FakeDb, type: string) => db.rows('fdh_investment_statement_activities').find((r) => r.activity_type === type)!;

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb(household(), { defaults: { fdh_investment_statement_positions: { apply_status: 'not_applicable' }, fdh_investment_statements: { approval_status: 'pending', reconciliation_status: 'insufficient_data' }, fdh_investment_statement_activities: { apply_status: 'pending', bank_match_status: 'not_attempted', security_match_status: 'not_attempted' } } });
  h.db = db;
});

describe('INV-G4 bank <-> broker matching is real (institution, direction, currency, approval, one-to-one)', () => {
  it('matches the funding debit, the sale proceeds and the dividend credit to the right broker lines -- and never a decoy', async () => {
    const sid = await importBrokerStatement('CommSec');
    const res = await matchAuStatementActivitiesToBank(USER, sid);
    expect(res.error).toBeNull();
    expect(activity(db, 'CASH_DEPOSIT').linked_transaction_id).toBe('fund');
    expect(activity(db, 'SELL').linked_transaction_id).toBe('sell');
    expect(activity(db, 'DIVIDEND').linked_transaction_id).toBe('div');
    // The BUY settled from broker cash: its $9,980 has no bank leg of its own.
    expect(activity(db, 'BUY').bank_match_status).not.toBe('matched');
    const linked = db.rows('fdh_investment_statement_activities').map((a) => a.linked_transaction_id).filter(Boolean);
    expect(linked).not.toContain('decoy-broker');
    expect(linked).not.toContain('decoy-pending');
    expect(linked).not.toContain('decoy-credit');
  });

  it('a statement with no institution name never matches on amount + date alone', async () => {
    const sid = await importBrokerStatement(undefined);
    await matchAuStatementActivitiesToBank(USER, sid);
    expect(activity(db, 'CASH_DEPOSIT').bank_match_status).not.toBe('matched');
    expect(activity(db, 'SELL').bank_match_status).not.toBe('matched');
  });

  it('one bank line corroborates ONE activity: a CASH_DEPOSIT claims the funding debit before a same-amount BUY', async () => {
    const one = [
      'Date,Type,Code,Security Name,Quantity,Price,Amount,Brokerage,Settlement Date,Franking Credit,Withholding Tax',
      '03/08/2026,BUY,VAS,Vanguard Australian Shares,100,100.00,"10,000.00",,,,',
      '03/08/2026,CASH_DEPOSIT,,,,,"10,000.00",,,,',
      '25/08/2026,SELL,VAS,Vanguard Australian Shares,1,1.00,5.00,,,,',
    ].join('\n');
    const ex = extractAuTransactionsFromCsv({ bytes: csv(one), columnMap: TXN_MAP, currencyCode: 'AUD', institutionName: 'CommSec' });
    if (!ex.ok) throw new Error(ex.error);
    const { statementId } = await persistAuInvestmentEvidence({ userId: USER, documentId: 'doc-inv', statementType: 'investment_transaction_csv', extraction: ex.extraction });
    await matchAuStatementActivitiesToBank(USER, statementId);
    expect(activity(db, 'CASH_DEPOSIT').linked_transaction_id).toBe('fund');
    expect(activity(db, 'BUY').linked_transaction_id ?? null).toBeNull();
  });
});

describe('the brief oracles, through the canonical read models', () => {
  async function readModels() {
    const e = await selectExpenses(USER, { client: db.client as never, window: WINDOW, basis: 'actual' });
    const i = await selectIncome(USER, { client: db.client as never, window: WINDOW });
    if (e.status !== 'ok' || i.status !== 'ok') throw new Error('read model unavailable');
    return { e, i };
  }

  it('$10,000 bank->broker funding + BUY -> household spending 0 (decoys excluded, the other broker legs corroborated)', async () => {
    const sid = await importBrokerStatement('CommSec');
    await matchAuStatementActivitiesToBank(USER, sid);
    approve(db, sid);
    // Remove the unrelated decoy spending legs so the oracle isolates the funding leg.
    db.tables.fdh_transactions = db.rows('fdh_transactions').filter((t) => !String(t.id).startsWith('decoy'));
    const { e } = await readModels();
    expect(e.actual.monthly).toBe(0);
  });

  it('$15,000 SELL proceeds -> ordinary income 0; $400 dividend (broker + bank) -> income $400 exactly once', async () => {
    const sid = await importBrokerStatement('CommSec');
    await matchAuStatementActivitiesToBank(USER, sid);
    approve(db, sid);
    db.tables.fdh_transactions = db.rows('fdh_transactions').filter((t) => !String(t.id).startsWith('decoy'));
    const { i } = await readModels();
    // Window Jun-Aug (3 complete months), covered months = 1 (Aug): the counted
    // August income is the dividend alone.
    expect(i.actual.lines.filter((l) => l.treatment === 'counted').map((l) => l.transactionId)).toEqual(['div']);
    expect(i.actual.countedMonthly).toBe(400);
  });

  it('negative control: before the statement is approved, nothing is corroborated (effect 0 before approval)', async () => {
    const sid = await importBrokerStatement('CommSec');
    await matchAuStatementActivitiesToBank(USER, sid);
    db.tables.fdh_transactions = db.rows('fdh_transactions').filter((t) => !String(t.id).startsWith('decoy'));
    const { e, i } = await readModels();
    expect(e.actual.monthly).toBe(10000);
    expect(i.actual.countedMonthly).toBe(15400);
  });
});

describe('INV-G6 / INV-G7 / INV-G8: extraction parses every numeric and date, and keeps summary lines out of holdings', () => {
  it("a DD/MM valuation date and '$' / thousands-separated amounts parse to ISO / plain decimals", () => {
    const r = extractAuPositionsFromCsv({
      bytes: csv(['Security Name,Code,Quantity,Price,Market Value,Valuation Date', 'BHP Group Ltd,BHP,200,$49.90,"$9,980.00",31/08/2026', 'Vanguard Australian Shares,VAS,"1,000",$100.25,"100,250.00",31/08/2026'].join('\n')),
      columnMap: POS_MAP,
      currencyCode: 'AUD',
      defaultValuationDate: '2026-09-01',
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.extraction.positions.map((p) => [p.valuationDate, p.unitPrice, p.marketValue, p.quantity])).toEqual([
      ['2026-08-31', '49.90', '9980', '200'],
      ['2026-08-31', '100.25', '100250', '1000'],
    ]);
    expect(r.extraction.warnings).toEqual([]);
  });

  it("'$' brokerage, franking and withholding are parsed (the raw '$19.95' used to fail the whole numeric insert)", () => {
    const r = extractAuTransactionsFromCsv({ bytes: csv(BROKER_CSV), columnMap: TXN_MAP, currencyCode: 'AUD', institutionName: 'CommSec' });
    if (!r.ok) throw new Error(r.error);
    const buy = r.extraction.transactions.find((t) => t.transactionType === 'BUY')!;
    const div = r.extraction.transactions.find((t) => t.transactionType === 'DIVIDEND')!;
    expect(buy.brokerageRaw).toBe('19.95');
    expect(buy.settlementDate).toBe('2026-08-06');
    expect(div.frankingCreditRaw).toBe('171.43');
    expect(div.withholdingTaxRaw).toBe('0');
  });

  it('cash and total lines become the statement cash balance / closing value, never a holding (D-11: shown, not counted)', () => {
    const r = extractAuPositionsFromCsv({
      bytes: csv(['Security Name,Code,Quantity,Price,Market Value,Valuation Date', 'BHP Group Ltd,BHP,200,49.90,9980.00,31/08/2026', 'Cash,,,,"1,020.00",31/08/2026', 'Total,,,,"11,000.00",31/08/2026'].join('\n')),
      columnMap: POS_MAP,
      currencyCode: 'AUD',
      defaultValuationDate: '2026-09-01',
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.extraction.positions.map((p) => p.securityNameRaw)).toEqual(['BHP Group Ltd']);
    expect(r.extraction.cashBalance).toBe('1020');
    expect(r.extraction.closingPortfolioValue).toBe('11000');
  });

  it('1,001 activity rows are all extracted (no truncation)', () => {
    const lines = ['Date,Type,Code,Security Name,Quantity,Price,Amount'];
    for (let i = 0; i < 1001; i += 1) lines.push(`${String((i % 28) + 1).padStart(2, '0')}/08/2026,BUY,BHP,BHP Group Ltd,1,${(40 + (i % 50) / 100).toFixed(2)},${(40 + (i % 50) / 100).toFixed(2)}`);
    const r = extractAuTransactionsFromCsv({ bytes: csv(lines.join('\n')), columnMap: TXN_MAP, currencyCode: 'AUD' });
    if (!r.ok) throw new Error(r.error);
    expect(r.extraction.transactions).toHaveLength(1001);
  });
});

describe('INV-G2 / INV-G6: persist', () => {
  const extraction = () => {
    const r = extractAuPositionsFromCsv({
      bytes: csv(['Security Name,Code,Quantity,Price,Market Value,Valuation Date', 'BHP Group Ltd,BHP,200,49.90,9980.00,31/08/2026', 'Bad Row,XXX,not-a-number,1,1,31/08/2026', 'Total,,,,9980.00,31/08/2026'].join('\n')),
      columnMap: POS_MAP,
      currencyCode: 'AUD',
      defaultValuationDate: '2026-09-01',
    });
    if (!r.ok) throw new Error(r.error);
    return r.extraction;
  };

  it("positions are created 'pending' (Apply claims 'pending'; the column default 'not_applicable' made them unreachable)", async () => {
    await persistAuInvestmentEvidence({ userId: USER, documentId: 'doc-inv', statementType: 'portfolio_csv', extraction: extraction() });
    expect(db.rows('fdh_investment_statement_positions').map((p) => p.apply_status)).toEqual(['pending']);
  });

  it('the unreadable row is persisted as a visible warning, and the statement total is reconciled', async () => {
    await persistAuInvestmentEvidence({ userId: USER, documentId: 'doc-inv', statementType: 'portfolio_csv', extraction: extraction() });
    const s = db.rows('fdh_investment_statements')[0];
    expect(s.extraction_warnings).toEqual([{ code: 'unparseable_quantity', count: 1, rowsDropped: true, rows: [2] }]);
    expect(s.reconciliation_status).toBe('reconciled');
    expect(s.closing_portfolio_value).toBe('9980');
  });

  it('a failed evidence insert throws and leaves NO statement behind (it used to leave a silent "0 holdings" statement)', async () => {
    db = new FakeDb(household(), { beforeInsert: (table) => (table === 'fdh_investment_statement_positions' ? 'invalid input syntax for type numeric' : null) });
    h.db = db;
    await expect(persistAuInvestmentEvidence({ userId: USER, documentId: 'doc-inv', statementType: 'portfolio_csv', extraction: extraction() })).rejects.toThrow(/could not be saved/);
    expect(db.rows('fdh_investment_statements')).toHaveLength(0);
  });

  it('1,001 activities are persisted in full (chunked inserts, no truncation)', async () => {
    const lines = ['Date,Type,Code,Security Name,Quantity,Price,Amount'];
    for (let i = 0; i < 1001; i += 1) lines.push(`${String((i % 28) + 1).padStart(2, '0')}/08/2026,BUY,BHP,BHP Group Ltd,1,40.00,40.00`);
    const r = extractAuTransactionsFromCsv({ bytes: csv(lines.join('\n')), columnMap: TXN_MAP, currencyCode: 'AUD' });
    if (!r.ok) throw new Error(r.error);
    const out = await persistAuInvestmentEvidence({ userId: USER, documentId: 'doc-inv', statementType: 'investment_transaction_csv', extraction: r.extraction });
    expect(out.activitiesExtracted).toBe(1001);
    expect(db.rows('fdh_investment_statement_activities')).toHaveLength(1001);
    expect(db.inserts.filter((i) => i.table === 'fdh_investment_statement_activities').every((i) => i.rows.length <= 500)).toBe(true);
  });
});
