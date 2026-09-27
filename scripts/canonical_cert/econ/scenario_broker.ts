/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * ORACLE (AU broker): bank -> broker 10,000 + BUY -> household spending 0; SELL 15,000 -> ordinary income 0;
 * dividend 400 at the broker + 400 at the bank -> ONE 400 income event. Holdings reach Net Worth only after the
 * explicit "Add to Net Worth" step (D-05).
 * APPLY SAFETY: two simultaneous investment Apply calls -> one effect; repeat Apply -> nothing new;
 *   cross-tenant Apply -> refused.
 *
 *   npx tsx scripts/canonical_cert/econ/scenario_broker.ts --email E --attacker A
 */
import { call, measure, delta, expect, results, saveEvidence, round2 } from './lib';
import { importAndApproveBank, rowsFor, userIdOf } from './flows';
import { brokerTransactionStatement } from '../documents/builders';
import { fireConcurrently } from './concurrent';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const attacker = arg('--attacker')!;
const salt = arg('--salt') ?? 'B';
const evidence: Record<string, unknown> = { email };
const log = (label: string, r: { status: number; json: any }) => { console.log(`  ${label} -> HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`); return r; };

async function iiCounts(userId: string) {
  const [tx, snaps, inv, acts] = await Promise.all([
    rowsFor('ii_transactions', userId, 'id'),
    rowsFor('ii_holding_snapshots', userId, 'id'),
    rowsFor('investments', userId, 'id,current_value,source_type'),
    rowsFor('fdh_investment_statement_activities', userId, 'id,activity_type,amount,linked_transaction_id,bank_match_status,apply_status'),
  ]);
  return { iiTransactions: tx.length, snapshots: snaps.length, investments: inv.length, invRows: inv, activities: acts };
}

async function main() {
  const userId = await userIdOf(email);
  const m0 = await measure(email);
  evidence.m0 = m0;

  // 1) Bank statement: the three bank legs, filed by the user with the obvious categories.
  const bank = await importAndApproveBank(email, [
    { date: '2026-08-04', description: `TRANSFER TO FHIP TEST BROKER ${salt}`, amount: -10000, category: 'investment_purchase' },
    { date: '2026-08-20', description: `FHIP TEST BROKER SALE PROCEEDS ${salt}`, amount: 15000, category: 'investment_sale' },
    { date: '2026-08-25', description: `FHIP TEST DIVIDEND BHP ${salt}`, amount: 400, category: 'income' },
  ], { masked: 'xxxx7106', filename: `fhip-test-bank-broker-${salt}.csv` });
  evidence.bank = { documentId: bank.documentId, decisions: bank.decisions, approve: bank.approve, txns: bank.txns };
  expect(bank.approve?.status === 200, 'broker: bank statement approved', bank.approve);
  const m1 = await measure(email);
  evidence.m1 = m1;
  expect(delta(m0, m1, 'expenses.actualTotalInWindow') === 0, 'broker: bank->broker 10,000 counts 0 spending', delta(m0, m1, 'expenses.actualTotalInWindow'));
  expect(delta(m0, m1, 'income.countedMonthly') === 400, 'broker: bank income = the 400 dividend only (sale proceeds 15,000 NOT income)', delta(m0, m1, 'income.countedMonthly'));

  // 2) Broker transaction statement through the AU import panel's sequence.
  const doc = brokerTransactionStatement({ year: 2026, month: 8 }, salt);
  const qs = new URLSearchParams({ ...doc.upload.query, masked_account_identifier: 'xxxx2536', filename: doc.filename });
  const up = log('upload', await call(email, 'POST', `/api/financial-data-hub/investment-statement/upload?${qs}`, { body: doc.bytes, contentType: 'text/csv' }));
  const documentId = up.json?.data?.document_id as string;
  evidence.upload = up.json;
  if (!up.json?.data?.statement_id) throw new Error('investment upload produced no statement');
  let review = await call(email, 'GET', `/api/financial-data-hub/investment-statement/${documentId}`);
  evidence.reviewAfterUpload = review.json?.data;
  const acct = log('account-match resolve', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/account-match`, { json: { action: 'resolve', account_type: 'broker', currency_code: 'AUD' } }));
  if (acct.json?.data?.outcome !== 'single_match') {
    log('account-match confirm_new', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/account-match`, { json: { action: 'confirm_new', institution_name: 'FHIP Test Broker', masked_account_identifier: 'xxxx2536', currency_code: 'AUD', owner_self: true } }));
  } else if (!acct.json?.data?.owner_recorded) {
    log('account-match set_owner', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/account-match`, { json: { action: 'set_owner', owner_self: true } }));
  }
  review = await call(email, 'GET', `/api/financial-data-hub/investment-statement/${documentId}`);
  const acts = (review.json?.data?.activities ?? []) as any[];
  const poss = (review.json?.data?.positions ?? []) as any[];
  for (const [table, row] of [...poss.map((p) => ['fdh_investment_statement_positions', p]), ...acts.map((a) => ['fdh_investment_statement_activities', a])] as [string, any][]) {
    if (row.security_match_status === 'matched' || !(row.ticker_raw || row.security_name_raw || row.isin)) continue;
    const r = log(`security-match ${row.activity_type ?? 'position'} ${row.ticker_raw}`, await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/security-match`, { json: { table, row_id: row.id } }));
    if (r.json?.data?.outcome !== 'matched' && r.json?.data?.outcome !== 'single_match') {
      log(`security-match create ${row.ticker_raw}`, await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/security-match`, { json: { table, row_id: row.id, confirm_new_security: true, instrument_class: 'equity' } }));
    }
  }
  evidence.bankMatch = log('bank-match', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/bank-match`)).json;
  review = await call(email, 'GET', `/api/financial-data-hub/investment-statement/${documentId}`);
  evidence.reviewBeforeApprove = review.json?.data;
  const ra = (review.json?.data?.activities ?? []) as any[];
  const link = (t: string) => ra.find((a) => a.activity_type === t);
  const bankId = (d: string) => bank.txns.find((t: any) => t.description_raw.startsWith(d))?.id;
  expect(link('BUY')?.linked_transaction_id === bankId('TRANSFER TO FHIP TEST BROKER') || link('CASH_DEPOSIT')?.linked_transaction_id === bankId('TRANSFER TO FHIP TEST BROKER'), 'broker: the 10,000 bank debit is matched to broker evidence', { buy: link('BUY')?.linked_transaction_id, dep: link('CASH_DEPOSIT')?.linked_transaction_id, bank: bankId('TRANSFER TO FHIP TEST BROKER') });
  expect(link('SELL')?.linked_transaction_id === bankId('FHIP TEST BROKER SALE PROCEEDS'), 'broker: SELL matched to the 15,000 bank credit', { sell: link('SELL')?.linked_transaction_id, bank: bankId('FHIP TEST BROKER SALE PROCEEDS') });
  expect(link('DIVIDEND')?.linked_transaction_id === bankId('FHIP TEST DIVIDEND BHP'), 'broker: DIVIDEND matched to the 400 bank credit', { div: link('DIVIDEND')?.linked_transaction_id, bank: bankId('FHIP TEST DIVIDEND BHP') });
  const ap = log('approve', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/approve`));
  evidence.approve = ap.json;
  const m2 = await measure(email);
  evidence.m2 = m2;
  expect(delta(m1, m2, 'dashboard.totalInvestments') === 0 && delta(m1, m2, 'dashboard.grossMonthlyIncome') === 0, 'broker: approved (not Applied) statement -> 0 effect', { dInv: delta(m1, m2, 'dashboard.totalInvestments'), dInc: delta(m1, m2, 'dashboard.grossMonthlyIncome') });

  // 3) Cross-tenant, then TRUE CONCURRENCY on Apply.
  const c0 = await iiCounts(userId);
  const xt = log('cross-tenant apply', await call(attacker, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/apply`));
  const c0b = await iiCounts(userId);
  evidence.crossTenant = xt;
  expect(xt.status >= 400 && c0b.iiTransactions === c0.iiTransactions && c0b.snapshots === c0.snapshots, 'broker: cross-tenant Apply refused, nothing written', { status: xt.status, err: xt.json?.error });
  const conc = await fireConcurrently(2, () => call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/apply`));
  evidence.concurrentApply = conc;
  const c1 = await iiCounts(userId);
  expect(conc.overlapped, 'broker: the two Apply calls overlapped in time', conc.results.map((r) => [Math.round(r.startedAt), Math.round(r.endedAt)]));
  const newTx = c1.iiTransactions - c0.iiTransactions;
  evidence.countsAfterApply = { before: { tx: c0.iiTransactions, snaps: c0.snapshots }, after: { tx: c1.iiTransactions, snaps: c1.snapshots } };
  expect(conc.results.some((r) => r.status === 200) && newTx === 3, 'broker: concurrent Apply wrote ii_transactions exactly once (BUY, SELL, DIVIDEND = 3; broker cash unsupported)', { statuses: conc.results.map((r) => ({ status: r.status, body: JSON.stringify(r.json).slice(0, 300) })), newTx });
  const rep = log('repeat apply', await call(email, 'POST', `/api/financial-data-hub/investment-statement/${documentId}/apply`));
  const c2 = await iiCounts(userId);
  evidence.repeat = rep;
  expect(c2.iiTransactions === c1.iiTransactions && c2.snapshots === c1.snapshots, 'broker: repeat Apply -> 0 new ii rows', { status: rep.status, tx: c2.iiTransactions - c1.iiTransactions });

  const m3 = await measure(email);
  evidence.m3 = m3;
  expect(delta(m0, m3, 'expenses.actualTotalInWindow') === 0, 'broker ORACLE: bank->broker 10,000 + BUY -> spending 0', delta(m0, m3, 'expenses.actualTotalInWindow'));
  expect(delta(m0, m3, 'income.countedMonthly') === 400 && round2(delta(m0, m3, 'dashboard.grossMonthlyIncome')) === 400, 'broker ORACLE: dividend broker 400 + bank 400 -> ONE 400; SELL 15,000 -> income 0', { dCounted: delta(m0, m3, 'income.countedMonthly'), dGross: delta(m0, m3, 'dashboard.grossMonthlyIncome') });
  saveEvidence(`scenario_broker_${salt}`, { evidence, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); saveEvidence(`scenario_broker_${salt}_error`, { evidence, results, error: String(e?.stack ?? e) }); process.exitCode = 1; });
