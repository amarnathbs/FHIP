/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * ORACLE (credit card): purchases 200 + 20 on the card, repaid 220 from the bank
 *   -> household spending 220 (never 440); the repayment is a liability settlement linked to the bank debit;
 *   liability balance = statement closing. Cash advance -> cash bucket, not consumption. Interest -> cost of debt.
 * Two households-in-one (two bank accounts + two cards) for the SAME user:
 *   pair 1: the user files the bank repayment as "Credit-Card Payment"  (the obvious choice)
 *   pair 2: the user files the bank repayment as "Shopping" BEFORE the card statement is applied
 *           (a plausible mis-filing; the card Apply then CONFIRMS the settlement link to that debit)
 * APPLY SAFETY: two simultaneous Apply calls -> one effect; repeat -> ALREADY_APPLIED; cross-tenant refused.
 *
 *   npx tsx scripts/canonical_cert/econ/scenario_card.ts --email E --attacker A
 */
import { call, measure, delta, expect, results, saveEvidence } from './lib';
import { importAndApproveBank, uploadLiabilityCsv, approveAndPropose, liabilityApplyRoute, rowsFor, userIdOf, CATEGORY, type BankRowSpec } from './flows';
import { fireConcurrently } from './concurrent';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const attacker = arg('--attacker')!;
const salt = arg('--salt') ?? 'B';
const evidence: Record<string, unknown> = { email };

const panelDefault = (fields: any[]) => fields.filter((f) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value).map((f) => f.field_name);

function cardCsv(tag: string, extra: string[] = []) {
  return ['Transaction Date,Description,Amount,Transaction Type,Merchant',
    `14/08/2026,FHIP TEST GROCER ${tag},200.00,Purchase,FHIP Test Grocer`,
    `18/08/2026,FHIP TEST CAFE ${tag},20.00,Purchase,FHIP Test Cafe`,
    `22/08/2026,Payment Received - Thank You ${tag},220.00,Payment,`, ...extra];
}
const cardQuery = (masked: string, opening: string, closing: string, from = '2026-08-01', to = '2026-08-31', due = '2026-09-15') => ({
  statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Card', masked_identifier: masked,
  statement_period_start: from, statement_period_end: to, statement_date: to, due_date: due, opening_balance: opening, closing_balance: closing, credit_limit: '5000.00', minimum_payment: '25.00',
});

async function pair(n: 1 | 2, category: BankRowSpec['category'], concurrent: boolean) {
  const tag = `${salt}${n}`;
  const m0 = await measure(email);
  const bank = await importAndApproveBank(email, [{ date: '2026-08-22', description: `FHIP TEST CARD PAYMENT ${tag}`, amount: -220, category }], { masked: `xxxx72${n}${n}`, filename: `fhip-test-bank-card-${tag}.csv` });
  expect(bank.approve?.status === 200, `card pair ${n}: bank statement approved (repayment filed as ${category})`, bank.approve);
  const card = await uploadLiabilityCsv(email, cardCsv(tag), cardQuery(`xxxx88${n}${n}`, '1000.00', '1000.00'), `fhip-test-card-${tag}.csv`);
  const pay = card.activities.find((a: any) => a.activity_type === 'PAYMENT');
  expect(pay?.linked_transaction_id === bank.txns[0]?.id, `card pair ${n}: card PAYMENT matched to the bank debit`, { linked: pay?.linked_transaction_id, bank: bank.txns[0]?.id });
  const pp = await approveAndPropose(email, card.documentId);
  const m1 = await measure(email);
  expect(delta(m0, m1, 'expenses.actualTotalInWindow') === (category === 'shopping' ? 220 : 0) && delta(m0, m1, 'dashboard.totalLiabilities') === 0,
    `card pair ${n}: before Apply only the bank line counts (card purchases 0, liability 0)`, { dSpend: delta(m0, m1, 'expenses.actualTotalInWindow'), dLiab: delta(m0, m1, 'dashboard.totalLiabilities') });
  const body = { decision: 'add_new', selectedFields: panelDefault(pp.fields), owner: 'self' };
  let applied: any;
  if (concurrent) {
    const conc = await fireConcurrently(2, () => call(email, 'POST', liabilityApplyRoute(pp.proposalId!), { json: body }));
    evidence[`pair${n}Concurrent`] = conc;
    expect(conc.overlapped, `card pair ${n}: the two Apply calls overlapped in time`, conc.results.map((r) => [Math.round(r.startedAt), Math.round(r.endedAt)]));
    const st = conc.results.map((r) => r.status).sort();
    expect(st[0] === 200 && st[1] === 409, `card pair ${n}: exactly one Apply succeeded, the other ALREADY_APPLIED`, conc.results.map((r) => ({ s: r.status, code: r.json?.code })));
    applied = conc.results.find((r) => r.status === 200)!.json.data;
  } else {
    const r = await call(email, 'POST', liabilityApplyRoute(pp.proposalId!), { json: body });
    expect(r.status === 200, `card pair ${n}: Apply succeeded`, { s: r.status, j: r.json });
    applied = r.json.data;
  }
  evidence[`pair${n}Applied`] = applied;
  const links = await rowsFor('fdh_transaction_links', await userIdOf(email), 'id,transaction_id_from,transaction_id_to,link_type,status', (q) => q.eq('transaction_id_from', bank.txns[0].id));
  expect(links.length === 1 && links[0].link_type === 'credit_card_settlement' && links[0].status === 'confirmed', `card pair ${n}: ONE confirmed credit_card_settlement link from the bank debit`, links);
  const m2 = await measure(email);
  evidence[`pair${n}`] = { m0, m1, m2, bank: bank.txns, card: card.statement, fields: pp.fields };
  const spend = delta(m0, m2, 'expenses.actualTotalInWindow');
  expect(spend === 220, `card pair ${n} ORACLE: purchases 200 + 20 repaid 220 -> household spending +220 (never 440) [repayment filed as ${category}]`, { dSpend: spend, ledger: applied?.ledger });
  expect(delta(m0, m2, 'dashboard.totalLiabilities') === 1000, `card pair ${n}: liability balance = statement closing 1,000 (totalLiabilities +1,000)`, delta(m0, m2, 'dashboard.totalLiabilities'));
  expect(delta(m0, m2, 'dashboard.debtMonthlyRepayments') === 0, `card pair ${n}: revolving card adds 0 debt service (D-08; no interest)`, delta(m0, m2, 'dashboard.debtMonthlyRepayments'));
  return { bank, card, pp, applied };
}

async function main() {
  const userId = await userIdOf(email);
  const p1 = await pair(1, 'credit_card_payment', true);
  // repeat Apply
  const txBefore = await rowsFor('fdh_transactions', userId, 'id');
  const rep = await call(email, 'POST', liabilityApplyRoute(p1.pp.proposalId!), { json: { decision: 'add_new', selectedFields: panelDefault(p1.pp.fields), owner: 'self' } });
  const txAfter = await rowsFor('fdh_transactions', userId, 'id');
  expect(rep.status === 409 && rep.json?.code === 'ALREADY_APPLIED' && txAfter.length === txBefore.length, 'card: repeat Apply -> ALREADY_APPLIED, 0 new ledger rows', { s: rep.status, code: rep.json?.code });
  // cross-tenant: attacker tries to re-file the victim's bank line and to re-point the card payment match
  const xs = await call(attacker, 'POST', `/api/financial-data-hub/bank-transactions/${p1.bank.txns[0].id}/set-category`, { json: { category_id: CATEGORY.shopping } });
  const xm = await call(attacker, 'POST', `/api/financial-data-hub/liability-statement/${p1.card.documentId}/match-payment`, { json: { activity_id: p1.card.activities.find((a: any) => a.activity_type === 'PAYMENT').id, bank_transaction_id: null } });
  const legNow = (await rowsFor('fdh_transactions', userId, 'id,economic_transaction_type,category_id', (q) => q.eq('id', p1.bank.txns[0].id)))[0];
  evidence.crossTenant = { setCategory: { s: xs.status, j: xs.json }, matchPayment: { s: xm.status, j: xm.json }, legNow };
  expect(xs.status >= 400 && xm.status >= 400 && legNow.economic_transaction_type === 'transfer', 'card: cross-tenant set-category and match-payment refused; victim line unchanged', { setCategory: xs.status, matchPayment: xm.status });

  // Cash advance + interest on card 1 (July statement: opening 638 + 300 + 50 + 12 = 1,000).
  const m3 = await measure(email);
  const jul = await uploadLiabilityCsv(email, ['Transaction Date,Description,Amount,Transaction Type,Merchant',
    `16/07/2026,FHIP TEST ATM CASH ADVANCE ${salt},300.00,Cash_Advance,`,
    `17/07/2026,FHIP TEST BOOKSHOP ${salt},50.00,Purchase,FHIP Test Bookshop`,
    `28/07/2026,INTEREST CHARGED ${salt},12.00,Interest,`], cardQuery('xxxx8811', '638.00', '1000.00', '2026-07-01', '2026-07-31', '2026-08-15'), `fhip-test-card-jul-${salt}.csv`);
  const ppj = await approveAndPropose(email, jul.documentId);
  // The panel's own default decision: the proposal's recommendation (an OLDER statement -> keep_existing).
  const julMode = ppj.proposal.json?.data?.proposal?.recommended_apply_mode === 'keep_existing' ? 'keep_existing' : 'update_existing';
  const liabBeforeJul = (await rowsFor('liabilities', userId, 'id,due_date,balance', (q) => q.eq('id', p1.applied.target_entity_id)))[0];
  const aj = await call(email, 'POST', liabilityApplyRoute(ppj.proposalId!), { json: julMode === 'keep_existing' ? { decision: julMode, owner: 'self' } : { decision: julMode, selectedFields: panelDefault(ppj.fields), owner: 'self' } });
  const liabAfterJul = (await rowsFor('liabilities', userId, 'id,due_date,balance', (q) => q.eq('id', p1.applied.target_entity_id)))[0];
  expect(liabAfterJul.due_date === liabBeforeJul.due_date && Number(liabAfterJul.balance) === Number(liabBeforeJul.balance), 'card: the OLDER July statement leaves the August due date / balance in place', { mode: julMode, before: liabBeforeJul, after: liabAfterJul });
  const m4 = await measure(email);
  evidence.cashAdvance = { m3, m4, apply: aj.json, fields: ppj.fields };
  expect(aj.status === 200, 'card: July statement applied', { s: aj.status, j: aj.json });
  const ns = (m: any, b: string) => m.expenses.nonSpending[b].totalInWindow;
  expect(ns(m4, 'cash_withdrawal') - ns(m3, 'cash_withdrawal') === 300 && delta(m3, m4, 'expenses.actualTotalInWindow') === 50, 'card: cash advance 300 -> "Cash — spending unknown", NOT consumption (spending +50 = the purchase only)', { dCash: ns(m4, 'cash_withdrawal') - ns(m3, 'cash_withdrawal'), dSpend: delta(m3, m4, 'expenses.actualTotalInWindow') });
  expect(ns(m4, 'cost_of_debt') - ns(m3, 'cost_of_debt') === 12, 'card: interest 12 -> cost of debt', ns(m4, 'cost_of_debt') - ns(m3, 'cost_of_debt'));

  // Pair 2: the repayment mis-filed as Shopping before the card Apply.
  await pair(2, 'shopping', false);
  saveEvidence(`scenario_card_${salt}`, { evidence, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); saveEvidence(`scenario_card_${salt}_error`, { evidence, results, error: String(e?.stack ?? e) }); process.exitCode = 1; });
