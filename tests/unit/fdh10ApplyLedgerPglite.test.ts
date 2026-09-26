/**
 * WP-11 (MANDATORY GATE) -- the REAL `fdh10_apply_liability_proposal` on a
 * real Postgres engine (PGlite, this repository's full migration chain), and
 * the canonical read models run over the rows it writes.
 *
 * NEGATIVE CONTROL FIRST. The database is built up to (not including) 0209, and
 * the pre-fix 0096 RPC is run on a card statement: it writes the liability and
 * NOTHING in the ledger, and an unticked "update existing" writes the card's
 * minimum payment into monthly_repayment. Then 0209 is applied to the SAME
 * database and every oracle below must hold. The pre-0209 statement is later
 * recorded through the backfill RPC, so the control and the fix are the same
 * rows.
 *
 * Oracles (the brief): card purchases 200 + 20 with a matched 220 repayment ->
 * household expense 220, never 440 and never 0; loan payment 2,000 = principal
 * 1,550 + interest 430 + fee 20 -> liability -1,550, cost of debt 450, debt
 * service / cash out 2,000; drawdown -> income 0; cash advance -> spending 0.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { explicitWindow } from '@/lib/read-models/core/window';
import { selectExpenses } from '@/lib/read-models/expenses';
import { selectIncome } from '@/lib/read-models/income';
import { selectLiabilities } from '@/lib/read-models/liabilities';
import { makeFakeSupabase } from './readModels/helpers/fakeSupabase';
import { buildDb, Fdh10Harness, migrationSql, type Json } from './support/fdh10LedgerPgliteHarness';

const WINDOW = explicitWindow('2026-06-01', '2026-08-31', '2026-09-26', 'Australia/Sydney');
const M0209 = '0209_fdh10_liability_apply_ledger.sql';

let h: Fdh10Harness;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// The negative-control statement, recorded under 0096 and backfilled after 0209.
const CONTROL_USER = uid(1);
let control: { statementId: string; proposalId: string; liabilityId: string };
const controlBefore: { ledgerRows: number; monthlyRepaymentAfterUnticked: string | null; appliedOk: boolean } = { ledgerRows: -1, monthlyRepaymentAfterUnticked: null, appliedOk: false };

async function readModels(user: string) {
  const { client } = makeFakeSupabase(await h.readModelTables(user) as never);
  const [expenses, liabilities, income] = await Promise.all([
    selectExpenses(user, { client, window: WINDOW, basis: 'actual' }),
    selectLiabilities(user, { client, window: WINDOW }),
    selectIncome(user, { client, window: WINDOW }),
  ]);
  if (expenses.status !== 'ok' || liabilities.status !== 'ok' || income.status !== 'ok') {
    throw new Error(`read model unavailable: ${JSON.stringify([expenses, liabilities, income].map((x) => x.status === 'ok' ? 'ok' : x))}`);
  }
  return { expenses, liabilities, income };
}

const spendingTotal = (e: Awaited<ReturnType<typeof readModels>>['expenses']) => e.status === 'ok' ? e.actual.totalInWindow : NaN;

beforeAll(async () => {
  h = new Fdh10Harness(await buildDb(M0209));

  // ---- NEGATIVE CONTROL on the pre-0209 schema (0096's RPC) --------------
  await h.user(CONTROL_USER);
  const existing = await h.liability(CONTROL_USER, { liability_name: 'Old Card', debt_type: 'credit_card', balance: 500, monthly_repayment: 0 });
  const s = await h.statementWithProposal(CONTROL_USER, {
    activities: [{ activity_type: 'PURCHASE', amount: 200, activity_date: '2026-08-03' }, { activity_type: 'PURCHASE', amount: 20, activity_date: '2026-08-05' }],
    targetLiabilityId: existing,
    fields: [
      { field_name: 'balance', value_kind: 'money', proposed_value: '1000', existing_value: '500.00' },
      { field_name: 'monthly_repayment', value_kind: 'money', proposed_value: '35', existing_value: '0.00', requires_confirmation: true },
    ],
  });
  const r = await h.applyLegacy(CONTROL_USER, s.proposalId, 'update_existing', null);
  controlBefore.appliedOk = r.ok === true;
  controlBefore.ledgerRows = await h.count(`select count(*) n from fdh_transactions where user_id = $1`, [CONTROL_USER]);
  controlBefore.monthlyRepaymentAfterUnticked = (await h.one<{ m: string }>(`select monthly_repayment::text m from liabilities where id = $1`, [existing])).m;
  control = { statementId: s.statementId, proposalId: s.proposalId, liabilityId: existing };

  // ---- THE FIX ----------------------------------------------------------
  await h.db.exec(migrationSql(M0209));
}, 240_000);

afterAll(async () => { await h?.db.close(); });

describe('negative control: the pre-0209 Apply (0096) on the same database', () => {
  it('applied the liability but wrote NO ledger row (G1), and an unticked update wrote the minimum payment (X-01)', () => {
    expect(controlBefore.appliedOk).toBe(true);
    expect(controlBefore.ledgerRows).toBe(0);
    expect(controlBefore.monthlyRepaymentAfterUnticked).toBe('35.00');
  });

  it('after 0209 the SAME statement can be recorded once (backfill), giving its 2 purchases', async () => {
    const r = await h.asTenant(CONTROL_USER, async () => (await h.one<{ r: Json }>(`select fdh10_record_liability_statement_ledger($1::uuid) r`, [control.statementId])).r);
    expect(r).toMatchObject({ ok: true, outcome: 'recorded', target_entity_id: control.liabilityId });
    expect((r.ledger as Json).transactions_created).toBe(2);
    const again = await h.asTenant(CONTROL_USER, async () => (await h.one<{ r: Json }>(`select fdh10_record_liability_statement_ledger($1::uuid) r`, [control.statementId])).r);
    expect(again).toMatchObject({ ok: false, code: 'ALREADY_APPLIED' });
    expect(await h.count(`select count(*) n from fdh_transactions where user_id = $1`, [CONTROL_USER])).toBe(2);
  });
});

describe('ORACLE card: purchases 200 + 20, matched repayment 220 -> expense 220 (never 440, never 0)', () => {
  const U = uid(10);
  let s: Awaited<ReturnType<Fdh10Harness['statementWithProposal']>>;
  let bankDebit: string;
  let result: Json;

  beforeAll(async () => {
    await h.user(U);
    const bank = await h.bankAccount(U);
    bankDebit = await h.bankDebit(U, bank, 220, '2026-08-20', { type: 'expense', openLink: true });
    s = await h.statementWithProposal(U, {
      activities: [
        { activity_type: 'PURCHASE', amount: 200, activity_date: '2026-08-03', description_raw: 'WOOLWORTHS 123' },
        { activity_type: 'PURCHASE', amount: 20, activity_date: '2026-08-05', description_raw: 'CAFE' },
        { activity_type: 'PAYMENT', amount: 220, activity_date: '2026-08-20', bank_match_status: 'matched', linked_transaction_id: bankDebit },
      ],
    });
    result = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code', 'country_code'], owner: 'self' });
  });

  it('Apply succeeds and reports its ledger effects', () => {
    expect(result).toMatchObject({ ok: true, outcome: 'applied', apply_mode: 'add_new' });
    expect(result.ledger).toMatchObject({ transactions_created: 3, duplicates_skipped: 0, allocations_created: 0, links_completed: 1, bank_legs_reclassified: 1 });
  });

  it('one approved facility row per activity, mapped exactly (expense, expense, transfer)', async () => {
    const rows = await h.all<{ credit_debit: string; economic_transaction_type: string; amount_original: string; approval_status: string; classification_method: string }>(
      `select t.credit_debit, t.economic_transaction_type, t.amount_original::text, t.approval_status, t.classification_method
         from fdh_transactions t join fdh_financial_accounts a on a.id = t.financial_account_id
        where t.user_id = $1 and a.account_type = 'credit_card' order by t.source_row`, [U]);
    expect(rows).toEqual([
      { credit_debit: 'debit', economic_transaction_type: 'expense', amount_original: '200.0000', approval_status: 'approved', classification_method: 'source' },
      { credit_debit: 'debit', economic_transaction_type: 'expense', amount_original: '20.0000', approval_status: 'approved', classification_method: 'source' },
      { credit_debit: 'credit', economic_transaction_type: 'transfer', amount_original: '220.0000', approval_status: 'approved', classification_method: 'source' },
    ]);
  });

  it('the bank debit is a transfer, and its open settlement link is COMPLETED (not duplicated) and confirmed', async () => {
    expect((await h.one<{ t: string }>(`select economic_transaction_type t from fdh_transactions where id = $1`, [bankDebit])).t).toBe('transfer');
    const links = await h.all<{ link_type: string; status: string; to_facility: boolean }>(
      `select l.link_type, l.status, (t.id is not null) to_facility from fdh_transaction_links l
         left join fdh_transactions t on t.id = l.transaction_id_to and t.source_row_hash like 'fdh10:act:%'
        where l.transaction_id_from = $1`, [bankDebit]);
    expect(links).toEqual([{ link_type: 'credit_card_settlement', status: 'confirmed', to_facility: true }]);
    expect(await h.count(`select count(*) n from fdh_transaction_corrections where transaction_id = $1 and field_name = 'economic_transaction_type'`, [bankDebit])).toBe(1);
  });

  it('SQL oracle: sum of every expense-typed amount (transactions + allocations) = 220', async () => {
    const n = await h.one<{ s: string }>(
      `select coalesce(sum(amount_original), 0)::text s from fdh_transactions t
        where t.user_id = $1 and t.approval_status = 'approved' and t.economic_transaction_type = 'expense'
          and not exists (select 1 from fdh_transaction_allocations a where a.transaction_id = t.id)`, [U]);
    expect(Number(n.s)).toBe(220);
  });

  it('READ MODEL (WP-02) over these real rows: actual spending 220, never 440 or 0; card debt service = its cost of debt only (D-08)', async () => {
    const { expenses, liabilities } = await readModels(U);
    expect(spendingTotal(expenses)).toBe(220);
    const card = liabilities.status === 'ok' ? liabilities.lines[0] : null;
    expect(card?.serviceClass).toBe('revolving');
    expect(card?.debtServiceMonthly).toBe(0);
    expect(card?.provenance.label).toBe('Imported from credit card statement');
  });

  it('write-back: activities carry their ledger row, the statement its liability, facility account and ledger status', async () => {
    const acts = await h.all<{ ledger_disposition: string; has_row: boolean }>(
      `select ledger_disposition, ledger_transaction_id is not null has_row from fdh_liability_statement_activities where statement_id = $1`, [s.statementId]);
    expect(acts.every((a) => a.ledger_disposition === 'ledger_row' && a.has_row)).toBe(true);
    const st = await h.one<Json>(`select ledger_status, liability_id is not null has_liability, financial_account_id is not null has_account from fdh_liability_statements where id = $1`, [s.statementId]);
    expect(st).toEqual({ ledger_status: 'applied', has_liability: true, has_account: true });
    const acc = await h.one<Json>(`select account_type, owner_role, account_fingerprint like 'fdh10:liability:%' fp from fdh_financial_accounts a join fdh_liability_statements s on s.financial_account_id = a.id where s.id = $1`, [s.statementId]);
    expect(acc).toEqual({ account_type: 'credit_card', owner_role: 'self', fp: true });
  });

  it('provenance: application.ledger_effects and the audit events are written INSIDE the RPC, tied to the document (G12)', async () => {
    const app = await h.one<{ e: Json }>(`select ledger_effects e from fhip_import_applications where proposal_id = $1`, [s.proposalId]);
    expect(app.e.transactions_created).toBe(3);
    const events = await h.all<{ event_type: string }>(`select event_type from fdh_document_audit_events where document_id = $1 order by event_type`, [s.uploadId]);
    expect(events.map((e) => e.event_type)).toEqual(['liability_ledger_applied', 'liability_proposal_applied']);
  });

  it('REPEAT Apply creates nothing (ALREADY_APPLIED), and the backfill RPC refuses too', async () => {
    const before = await h.count(`select count(*) n from fdh_transactions where user_id = $1`, [U]);
    const again = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] });
    expect(again).toMatchObject({ ok: false, code: 'ALREADY_APPLIED' });
    const rec = await h.asTenant(U, async () => (await h.one<{ r: Json }>(`select fdh10_record_liability_statement_ledger($1::uuid) r`, [s.statementId])).r);
    expect(rec).toMatchObject({ ok: false, code: 'ALREADY_APPLIED' });
    expect(await h.count(`select count(*) n from fdh_transactions where user_id = $1`, [U])).toBe(before);
    expect(await h.count(`select count(*) n from fdh_transaction_links where user_id = $1`, [U])).toBe(1);
  });

  it('a SECOND live proposal for the same statement is refused by the database (G11), so two Applies can never both write', async () => {
    const dup = await h.asService(async () => h.db.query(
      `insert into fhip_import_proposals (user_id, target_domain, source_kind, source_liability_statement_id, currency_code, recommended_apply_mode, status)
       values ($1, 'liability', 'credit_card_statement', $2, 'AUD', 'add_new', 'ready')`, [U, s.statementId]).then(() => 'inserted', (e: Error) => e.message));
    expect(dup).toMatch(/uq_fhip_import_proposals_live_liability_statement_0209/);
  });
});

describe('ORACLE loan: payment 2,000 = principal 1,550 + interest 430 + fee 20', () => {
  const U = uid(20);
  let s: Awaited<ReturnType<Fdh10Harness['statementWithProposal']>>;
  let bankDebit: string;
  let result: Json;

  beforeAll(async () => {
    await h.user(U);
    const bank = await h.bankAccount(U);
    bankDebit = await h.bankDebit(U, bank, 2000, '2026-08-15', { type: 'expense', description: 'LOAN REPAYMENT' });
    s = await h.statementWithProposal(U, {
      statementType: 'loan',
      activities: [{ activity_type: 'PAYMENT', amount: 2000, activity_date: '2026-08-15', principal_component: 1550, interest_component: 430, fee_component: 20, bank_match_status: 'matched', linked_transaction_id: bankDebit }],
    });
    result = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code', 'country_code'] });
  });

  it('header debt_principal 2,000 (credit) + allocations 1,550 / 430 / 20 summing exactly to it', async () => {
    expect(result).toMatchObject({ ok: true, ledger: { transactions_created: 1, allocations_created: 3, links_created: 1 } });
    const header = await h.one<Json>(`select t.id, t.credit_debit, t.economic_transaction_type, t.amount_original::text amount from fdh_transactions t join fdh_liability_statement_activities a on a.ledger_transaction_id = t.id where a.statement_id = $1`, [s.statementId]);
    expect(header).toMatchObject({ credit_debit: 'credit', economic_transaction_type: 'debt_principal', amount: '2000.0000' });
    const allocs = await h.all<Json>(`select allocation_sequence seq, economic_transaction_type type, amount::text amount from fdh_transaction_allocations where transaction_id = $1 order by 1`, [header.id]);
    expect(allocs).toEqual([
      { seq: 1, type: 'debt_principal', amount: '1550.0000' },
      { seq: 2, type: 'debt_interest', amount: '430.0000' },
      { seq: 3, type: 'fee', amount: '20.0000' },
    ]);
  });

  it('the bank debit (cash out 2,000) is a transfer linked by a confirmed loan_payment link', async () => {
    expect((await h.one<{ t: string }>(`select economic_transaction_type t from fdh_transactions where id = $1`, [bankDebit])).t).toBe('transfer');
    expect(await h.all(`select link_type, status from fdh_transaction_links where transaction_id_from = $1`, [bankDebit])).toEqual([{ link_type: 'loan_payment', status: 'confirmed' }]);
  });

  it('READ MODEL: principal 1,550 (not expense), cost of debt 450, debt service 2,000; household spending 0', async () => {
    const { expenses, liabilities } = await readModels(U);
    expect(spendingTotal(expenses)).toBe(0);
    if (liabilities.status !== 'ok') throw new Error('unavailable');
    expect(liabilities.lines[0].actual).toMatchObject({ principalMonthly: 1550, interestMonthly: 430, feeMonthly: 20, costOfDebtMonthly: 450, totalMonthly: 2000 });
    expect(liabilities.householdDebtServiceMonthly).toBe(2000);
    expect(liabilities.householdCostOfDebtMonthly).toBe(450);
  });
});

describe('drawdown is never income; a cash advance is never spending', () => {
  const U = uid(30);

  it('loan drawdown 5,000 -> debit transfer on the loan, income 0', async () => {
    await h.user(U);
    const s = await h.statementWithProposal(U, { statementType: 'loan', activities: [{ activity_type: 'LOAN_ADVANCE', amount: 5000, activity_date: '2026-08-02' }] });
    expect(await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] })).toMatchObject({ ok: true });
    const t = await h.one<Json>(`select credit_debit, economic_transaction_type from fdh_transactions where user_id = $1`, [U]);
    expect(t).toEqual({ credit_debit: 'debit', economic_transaction_type: 'transfer' });
    const { income } = await readModels(U);
    expect(income.status === 'ok' ? income.actual.countedMonthly : NaN).toBe(0);
    expect(income.status === 'ok' ? income.actual.lines.length : NaN).toBe(0);
  });

  it('card cash advance 300 -> cash_withdrawal, spending 0 ("Cash -- spending unknown", D-03)', async () => {
    const V = uid(31);
    await h.user(V);
    const s = await h.statementWithProposal(V, { activities: [{ activity_type: 'CASH_ADVANCE', amount: 300, activity_date: '2026-08-02' }] });
    expect(await h.apply(V, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] })).toMatchObject({ ok: true });
    expect((await h.one<{ t: string }>(`select economic_transaction_type t from fdh_transactions where user_id = $1`, [V])).t).toBe('cash_withdrawal');
    const { expenses } = await readModels(V);
    expect(spendingTotal(expenses)).toBe(0);
    const cash = expenses.status === 'ok' ? expenses.actual.nonSpending.find((b) => b.bucket === 'cash_withdrawal') : null;
    expect(cash?.totalInWindow).toBe(300);
  });
});

describe('overlapping statements of one facility: 0 duplicate ledger rows', () => {
  const U = uid(40);

  it('the shared lines are recorded as duplicates of the existing rows; only the new line is inserted', async () => {
    await h.user(U);
    const a = await h.statementWithProposal(U, {
      activities: [
        { activity_type: 'PURCHASE', amount: 5, activity_date: '2026-08-10', description_raw: 'COFFEE' },
        { activity_type: 'PURCHASE', amount: 5, activity_date: '2026-08-10', description_raw: 'COFFEE' },
        { activity_type: 'PURCHASE', amount: 40, activity_date: '2026-08-11', description_raw: 'BOOKS' },
      ],
    });
    const ra = await h.apply(U, a.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] });
    expect(ra).toMatchObject({ ok: true, ledger: { transactions_created: 3 } });
    const liabilityId = ra.target_entity_id as string;
    const b = await h.statementWithProposal(U, {
      targetLiabilityId: liabilityId,
      fields: [{ field_name: 'balance', value_kind: 'money', proposed_value: '1100', existing_value: '1000.00' }],
      activities: [
        { activity_type: 'PURCHASE', amount: 5, activity_date: '2026-08-10', description_raw: 'COFFEE' },
        { activity_type: 'PURCHASE', amount: 5, activity_date: '2026-08-10', description_raw: 'coffee ' },
        { activity_type: 'PURCHASE', amount: 60, activity_date: '2026-08-25', description_raw: 'SHOES' },
      ],
    });
    const rb = await h.apply(U, b.proposalId, 'update_existing', { fields: ['balance'] });
    expect(rb).toMatchObject({ ok: true, ledger: { transactions_created: 1, duplicates_skipped: 2 } });
    expect(await h.count(`select count(*) n from fdh_transactions where user_id = $1`, [U])).toBe(4);
    expect(await h.all(`select ledger_disposition d from fdh_liability_statement_activities where statement_id = $1 order by source_row_number`, [b.statementId]))
      .toEqual([{ d: 'duplicate_of_existing' }, { d: 'duplicate_of_existing' }, { d: 'ledger_row' }]);
    const { expenses } = await readModels(U);
    expect(spendingTotal(expenses)).toBe(110);
  });
});

describe('scale: 1,001 activities -> 1,001 ledger rows, none truncated', () => {
  it('writes every row in one Apply and the read model counts every one of them', async () => {
    const U = uid(50);
    await h.user(U);
    const activities = Array.from({ length: 1001 }, (_, i) => ({ activity_type: 'PURCHASE', amount: 1, activity_date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, description_raw: `ITEM ${i}` }));
    const s = await h.statementWithProposal(U, { activities });
    const r = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] });
    expect(r).toMatchObject({ ok: true, ledger: { transactions_created: 1001 } });
    expect(await h.count(`select count(*) n from fdh_transactions where user_id = $1`, [U])).toBe(1001);
    const { expenses } = await readModels(U);
    expect(spendingTotal(expenses)).toBe(1001);
  }, 120_000);
});

describe('guards', () => {
  it('an authenticated direct INSERT into fdh_transactions / fdh_transaction_links is still refused', async () => {
    const U = uid(60);
    await h.user(U);
    const bank = await h.bankAccount(U);
    const t = await h.bankDebit(U, bank, 10, '2026-08-01');
    const txn = await h.asTenant(U, () => h.db.query(
      `insert into fdh_transactions (user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit)
       values ($1, $2, '2026-08-01', 1, 'AUD', 'debit')`, [U, bank.accountId]).then(() => 'inserted', (e: Error) => e.message));
    expect(txn).toMatch(/engine-authoritative/);
    const link = await h.asTenant(U, () => h.db.query(
      `insert into fdh_transaction_links (user_id, transaction_id_from, link_type, created_by_method) values ($1, $2, 'credit_card_settlement', 'user_manual')`, [U, t])
      .then(() => 'inserted', (e: Error) => e.message));
    expect(link).toMatch(/engine-authoritative/);
    const updLink = await h.asService(async () => h.db.query(`insert into fdh_transaction_links (user_id, transaction_id_from, link_type, created_by_method, status) values ($1, $2, 'credit_card_settlement', 'algorithm', 'pending') returning id`, [U, t]));
    const forged = await h.asTenant(U, () => h.db.query(`update fdh_transaction_links set transaction_id_to = $2 where id = $1`, [(updLink.rows[0] as Json).id, t])
      .then(() => 'updated', (e: Error) => e.message));
    expect(forged).toMatch(/authoritative match fields/);
  });

  it('the internal helpers are not executable by an authenticated user', async () => {
    for (const fn of ['fdh10_internal_write_statement_ledger(uuid,uuid,uuid,text,boolean)', 'fdh10_internal_link_payment_leg(uuid,uuid,uuid,uuid,text)', 'fdh10_internal_ledger_blockers(uuid,uuid,boolean)']) {
      expect((await h.one<{ p: boolean }>(`select has_function_privilege('authenticated', $1, 'execute') p`, [fn])).p, fn).toBe(false);
    }
    expect((await h.one<{ p: boolean }>(`select has_function_privilege('authenticated', 'fdh10_apply_liability_proposal(uuid,text,text[],text,boolean)', 'execute') p`)).p).toBe(true);
    expect((await h.one<{ n: number }>(`select count(*)::int n from pg_proc where proname = 'fdh10_apply_liability_proposal'`)).n).toBe(1);
  });

  it("a matched bank transaction id that is not the user's -> FOREIGN_TRANSACTION, nothing written", async () => {
    const U = uid(70);
    const OTHER = uid(71);
    await h.user(U);
    await h.user(OTHER);
    const otherBank = await h.bankAccount(OTHER);
    const foreign = await h.bankDebit(OTHER, otherBank, 220, '2026-08-20');
    const s = await h.statementWithProposal(U, { activities: [{ activity_type: 'PURCHASE', amount: 220 }] });
    // Forge the match the way only a compromised writer could (0096's owner trigger blocks it otherwise).
    await h.asService(async () => {
      await h.db.exec('alter table fdh_liability_statement_activities disable trigger trg_fdh_liability_activities_owner;');
      await h.db.query(`insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code, linked_transaction_id, bank_match_status)
                        values ($1, $2, 'PAYMENT', '2026-08-20', 220, 'AUD', $3, 'matched')`, [U, s.statementId, foreign]);
      await h.db.exec('alter table fdh_liability_statement_activities enable trigger trg_fdh_liability_activities_owner;');
    });
    const r = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] });
    expect(r).toMatchObject({ ok: false, code: 'FOREIGN_TRANSACTION' });
    expect(await h.count(`select count(*) n from fdh_transactions where user_id = $1`, [U])).toBe(0);
    expect(await h.count(`select count(*) n from liabilities where user_id = $1`, [U])).toBe(0);
    expect((await h.one<{ s: string }>(`select status s from fhip_import_proposals where id = $1`, [s.proposalId])).s).toBe('ready');
  });

  it('X-01: "update existing" with nothing ticked leaves the card monthly_repayment unchanged (minimum payment needs confirmation)', async () => {
    const U = uid(80);
    await h.user(U);
    const existing = await h.liability(U, { debt_type: 'credit_card', balance: 500, monthly_repayment: 0 });
    const s = await h.statementWithProposal(U, {
      targetLiabilityId: existing,
      activities: [{ activity_type: 'PURCHASE', amount: 10 }],
      fields: [
        { field_name: 'balance', value_kind: 'money', proposed_value: '1000', existing_value: '500.00' },
        { field_name: 'monthly_repayment', value_kind: 'money', proposed_value: '35', existing_value: '0.00', requires_confirmation: true },
      ],
    });
    const r = await h.apply(U, s.proposalId, 'update_existing', { fields: null });
    expect(r).toMatchObject({ ok: true, applied_fields: ['balance'] });
    expect(await h.one(`select balance::text b, monthly_repayment::text m from liabilities where id = $1`, [existing])).toEqual({ b: '1000.00', m: '0.00' });
  });

  it('USD is refused (G13) with a visible reason, and nothing is written', async () => {
    const U = uid(90);
    await h.user(U);
    const s = await h.statementWithProposal(U, { currency: 'USD', activities: [{ activity_type: 'PURCHASE', amount: 10 }] });
    const r = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] });
    expect(r).toMatchObject({ ok: false, code: 'UNSUPPORTED_CURRENCY' });
    expect(String(r.error)).toMatch(/Only AUD and INR/);
    expect(await h.count(`select count(*) n from liabilities where user_id = $1`, [U])).toBe(0);
    expect(await h.count(`select count(*) n from fdh_transactions where user_id = $1`, [U])).toBe(0);
  });

  it('an invalid owner is refused; a spouse card becomes a spouse liability and a spouse-owned facility (G8)', async () => {
    const U = uid(95);
    await h.user(U);
    const s = await h.statementWithProposal(U, { activities: [{ activity_type: 'PURCHASE', amount: 10 }] });
    expect(await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'], owner: 'neighbour' })).toMatchObject({ ok: false, code: 'INVALID_OWNER' });
    const r = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'], owner: 'spouse' });
    expect(r).toMatchObject({ ok: true });
    expect((await h.one<{ o: string }>(`select owner o from liabilities where id = $1`, [r.target_entity_id])).o).toBe('spouse');
    expect((await h.one<{ o: string }>(`select owner_role o from fdh_financial_accounts where liability_id = $1`, [r.target_entity_id])).o).toBe('spouse');
  });
});

describe('review decisions', () => {
  it('BLOCKING_REVIEW for an unresolved ADJUSTMENT writes nothing; acknowledged, it is recorded as NOT counted (E)', async () => {
    const U = uid(100);
    await h.user(U);
    const s = await h.statementWithProposal(U, { activities: [{ activity_type: 'PURCHASE', amount: 10 }, { activity_type: 'ADJUSTMENT', amount: 3 }] });
    const blocked = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] });
    expect(blocked).toMatchObject({ ok: false, code: 'BLOCKING_REVIEW' });
    expect((blocked.blockers as Json[]).map((b) => b.reason)).toEqual(['unclassified_line']);
    expect(await h.count(`select count(*) n from liabilities where user_id = $1`, [U])).toBe(0);
    const ok = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'], ack: true });
    expect(ok).toMatchObject({ ok: true, ledger: { transactions_created: 1, excluded_unclassified: 1 } });
    expect(await h.all(`select activity_type, ledger_disposition from fdh_liability_statement_activities where statement_id = $1 order by source_row_number`, [s.statementId]))
      .toEqual([{ activity_type: 'PURCHASE', ledger_disposition: 'ledger_row' }, { activity_type: 'ADJUSTMENT', ledger_disposition: 'excluded_unclassified' }]);
  });

  it('a loan PAYMENT whose components do not add up blocks (component_mismatch)', async () => {
    const U = uid(101);
    await h.user(U);
    const s = await h.statementWithProposal(U, { statementType: 'loan', activities: [{ activity_type: 'PAYMENT', amount: 2000, principal_component: 1500, interest_component: 430 }] });
    const r = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] });
    expect(r).toMatchObject({ ok: false, code: 'BLOCKING_REVIEW' });
    expect((r.blockers as Json[])[0].reason).toBe('component_mismatch');
  });

  it('multiple bank candidates block until the user picks one; the pick is verified; Apply then links it (G4)', async () => {
    const U = uid(102);
    await h.user(U);
    const bank = await h.bankAccount(U);
    const d1 = await h.bankDebit(U, bank, 220, '2026-08-19');
    const d2 = await h.bankDebit(U, bank, 220, '2026-08-21');
    const stranger = await h.bankDebit(U, bank, 220, '2026-08-22');
    const s = await h.statementWithProposal(U, {
      activities: [{ activity_type: 'PAYMENT', amount: 220, activity_date: '2026-08-20', bank_match_status: 'multiple_candidates', bank_match_candidate_ids: [d1, d2] }],
    });
    expect(await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] })).toMatchObject({ ok: false, code: 'BLOCKING_REVIEW' });
    const pick = (txn: string | null) => h.asTenant(U, async () => (await h.one<{ r: Json }>(`select fdh10_match_liability_payment($1::uuid, $2::uuid, 'user_pick') r`, [s.activityIds[0], txn])).r);
    expect(await pick(stranger)).toMatchObject({ ok: false, code: 'NOT_A_CANDIDATE' });
    expect(await pick(d2)).toMatchObject({ ok: true, outcome: 'matched' });
    const r = await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] });
    expect(r).toMatchObject({ ok: true, ledger: { links_created: 1 } });
    expect(await h.count(`select count(*) n from fdh_transaction_links where transaction_id_from = $1 and status = 'confirmed'`, [d2])).toBe(1);
    expect(await h.count(`select count(*) n from fdh_transaction_links where transaction_id_from = $1`, [d1])).toBe(0);
  });

  it('keep_existing still records the activities against the kept liability, without changing its figures (G10)', async () => {
    const U = uid(103);
    await h.user(U);
    const existing = await h.liability(U, { debt_type: 'credit_card', balance: 500 });
    const s = await h.statementWithProposal(U, {
      targetLiabilityId: existing,
      fields: [{ field_name: 'balance', value_kind: 'money', proposed_value: '999', existing_value: '500.00' }],
      activities: [{ activity_type: 'PURCHASE', amount: 77 }],
    });
    const r = await h.apply(U, s.proposalId, 'keep_existing');
    expect(r).toMatchObject({ ok: true, outcome: 'kept_existing', target_entity_id: existing, ledger: { transactions_created: 1 } });
    expect((await h.one<{ b: string }>(`select balance::text b from liabilities where id = $1`, [existing])).b).toBe('500.00');
    expect((await h.one<{ s: string }>(`select status s from fhip_import_proposals where id = $1`, [s.proposalId])).s).toBe('dismissed');
  });

  it('keep_existing with no liability to keep is refused (it would strand the activities)', async () => {
    const U = uid(104);
    await h.user(U);
    const s = await h.statementWithProposal(U, { activities: [{ activity_type: 'PURCHASE', amount: 1 }] });
    expect(await h.apply(U, s.proposalId, 'keep_existing')).toMatchObject({ ok: false, code: 'INVALID_APPLY_MODE' });
  });

  it('reject_statement records every activity as rejected (E), writes no ledger row, audits the document', async () => {
    const U = uid(105);
    await h.user(U);
    const s = await h.statementWithProposal(U, { activities: [{ activity_type: 'PURCHASE', amount: 1 }, { activity_type: 'FEE', amount: 2 }] });
    const r = await h.apply(U, s.proposalId, 'reject_statement');
    expect(r).toMatchObject({ ok: true, outcome: 'rejected_statement', activities_rejected: 2 });
    expect(await h.count(`select count(*) n from fdh_transactions where user_id = $1`, [U])).toBe(0);
    expect(await h.one(`select ledger_status, ledger_rejected_reason from fdh_liability_statements where id = $1`, [s.statementId])).toEqual({ ledger_status: 'rejected', ledger_rejected_reason: 'rejected_by_user' });
    expect(await h.count(`select count(*) n from fdh_document_audit_events where document_id = $1 and event_type = 'liability_statement_rejected'`, [s.uploadId])).toBe(1);
  });

  it('back-match: a repayment with no bank evidence at Apply is linked once the bank debit is approved', async () => {
    const U = uid(106);
    await h.user(U);
    const s = await h.statementWithProposal(U, { activities: [{ activity_type: 'PAYMENT', amount: 300, activity_date: '2026-08-12', bank_match_status: 'bank_evidence_not_available' }] });
    expect(await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] })).toMatchObject({ ok: true });
    const bank = await h.bankAccount(U);
    const debit = await h.bankDebit(U, bank, 300, '2026-08-13', { type: 'unknown' });
    const r = await h.asTenant(U, async () => (await h.one<{ r: Json }>(`select fdh10_match_liability_payment($1::uuid, $2::uuid, 'bank_back_match') r`, [s.activityIds[0], debit])).r);
    expect(r).toMatchObject({ ok: true, outcome: 'matched', link: 'linked+reclassified' });
    expect((await h.one<{ t: string }>(`select economic_transaction_type t from fdh_transactions where id = $1`, [debit])).t).toBe('transfer');
    const again = await h.asTenant(U, async () => (await h.one<{ r: Json }>(`select fdh10_match_liability_payment($1::uuid, $2::uuid, 'bank_back_match') r`, [s.activityIds[0], debit])).r);
    expect(again).toMatchObject({ ok: false, code: 'NOT_ACTIONABLE' });
  });

  it('back-match refuses a debit outside the 7-day window, a pending debit, and a debit already paying another line', async () => {
    const U = uid(107);
    await h.user(U);
    const s = await h.statementWithProposal(U, {
      activities: [
        { activity_type: 'PAYMENT', amount: 300, activity_date: '2026-08-12', bank_match_status: 'bank_evidence_not_available' },
        { activity_type: 'PAYMENT', amount: 300, activity_date: '2026-08-13', bank_match_status: 'bank_evidence_not_available' },
      ],
    });
    expect(await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] })).toMatchObject({ ok: true });
    const bank = await h.bankAccount(U);
    const far = await h.bankDebit(U, bank, 300, '2026-08-25');
    const pending = await h.bankDebit(U, bank, 300, '2026-08-12', { approved: false });
    const good = await h.bankDebit(U, bank, 300, '2026-08-12');
    const match = (activity: string, txn: string) => h.asTenant(U, async () => (await h.one<{ r: Json }>(`select fdh10_match_liability_payment($1::uuid, $2::uuid, 'bank_back_match') r`, [activity, txn])).r);
    expect(await match(s.activityIds[0], far)).toMatchObject({ ok: false, code: 'BANK_MATCH_INVALID' });
    expect(await match(s.activityIds[0], pending)).toMatchObject({ ok: false, code: 'BANK_MATCH_INVALID' });
    expect(await match(s.activityIds[0], good)).toMatchObject({ ok: true });
    expect(await match(s.activityIds[1], good)).toMatchObject({ ok: false, code: 'ALREADY_MATCHED' });
  });
});

describe('loan layouts: the Apply and the read model agree for split AND unsplit repayments', () => {
  it('an UNSPLIT repayment 2,000 + a separate interest line 430 -> debt service 2,000 (not 430), cost of debt 430, spending 0', async () => {
    const U = uid(110);
    await h.user(U);
    const bank = await h.bankAccount(U);
    const debit = await h.bankDebit(U, bank, 2000, '2026-08-15', { type: 'expense', description: 'TEST BANK LOAN' });
    const s = await h.statementWithProposal(U, {
      statementType: 'loan',
      activities: [
        { activity_type: 'INTEREST', amount: 430, activity_date: '2026-08-01' },
        { activity_type: 'PAYMENT', amount: 2000, activity_date: '2026-08-15', bank_match_status: 'matched', linked_transaction_id: debit },
      ],
    });
    expect(await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] })).toMatchObject({ ok: true, ledger: { transactions_created: 2, links_created: 1 } });
    const { expenses, liabilities } = await readModels(U);
    expect(spendingTotal(expenses)).toBe(0);
    if (liabilities.status !== 'ok') throw new Error('unavailable');
    const a = liabilities.lines[0].actual!;
    // The pre-WP-11 read-model formula (principal + interest + fee) says 430 here.
    expect(a.principalMonthly + a.interestMonthly + a.feeMonthly).toBe(430);
    expect(a).toMatchObject({ paymentsMonthly: 2000, costOfDebtMonthly: 430, totalMonthly: 2000 });
    expect(liabilities.householdDebtServiceMonthly).toBe(2000);
  });

  it.each([
    [1000, 1000, null, null],
    [500, 0, 480, 20],
    [300, null, 300, null],
  ])('DB allocations for payment %s = %s / %s / %s equal decomposeLoanPayment', async (amount, p, i, f) => {
    const { decomposeLoanPayment } = await import('@/lib/financial-data-hub/liability/repaymentDecomposition');
    const U = uid(1000 + amount);
    await h.user(U);
    const s = await h.statementWithProposal(U, { statementType: 'loan', activities: [{ activity_type: 'PAYMENT', amount, principal_component: p, interest_component: i, fee_component: f }] });
    expect(await h.apply(U, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code'] })).toMatchObject({ ok: true });
    const rows = await h.all<{ type: string; amount: string }>(
      `select al.economic_transaction_type type, al.amount::text amount from fdh_transaction_allocations al
         join fdh_liability_statement_activities a on a.ledger_transaction_id = al.transaction_id
        where a.statement_id = $1 order by al.allocation_sequence`, [s.statementId]);
    const certified = decomposeLoanPayment({ totalPayment: amount, principalComponent: p ?? undefined, interestComponent: i ?? undefined, feeComponent: f ?? undefined, currencyCode: 'AUD' });
    expect(rows.map((r) => ({ economicType: r.type, amount: Number(r.amount) }))).toEqual(certified.allocations);
  });
});
