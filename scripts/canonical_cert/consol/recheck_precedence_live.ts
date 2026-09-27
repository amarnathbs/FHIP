/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * Stage-3 CONSOLIDATION live recheck (range A): the merged spending-rule precedence through the real
 * localhost routes, as the signed-in user, on DEV.
 *
 * One bank statement (repayment 220 filed by the user as "Shopping" + a 20 CREDIT the user files as
 * "Food & Dining"), then the card statement (purchases 200 + 20, payment 220 matched to the bank debit),
 * approved and Applied the way the Liabilities panel does. Oracles (deltas against the user's own baseline):
 *   - D1:      household spending +220 (the card purchases), never +440 -- the user's "Shopping" choice on the
 *              repayment is overridden by the CONFIRMED settlement link the Apply creates;
 *   - rule 10: the 20 credit filed as Food is an UNLINKED refund: spending unchanged by it, refundsUnlinked +20;
 *   - before Apply: only the user-filed repayment counts (+220 spending, liability 0);
 *   - Net Worth -1,000 (the card liability, statement closing), bank balance NOT added (D-04 is opt-in);
 *   - the Dashboard's combined expenses move by the same amount as the expense read model's combined basis.
 *
 *   CERT_PORT=3971 npx tsx scripts/canonical_cert/consol/recheck_precedence_live.ts --email <e> --salt Q1
 */
import { call, measure, delta, expect, results, saveEvidence } from '../econ/lib';
import { importAndApproveBank, uploadLiabilityCsv, approveAndPropose, liabilityApplyRoute, rowsFor, userIdOf } from '../econ/flows';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const salt = arg('--salt') ?? 'Q1';
const panelDefault = (fields: any[]) => fields.filter((f) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value).map((f) => f.field_name);

async function main() {
  const evidence: Record<string, unknown> = { email, salt };
  const userId = await userIdOf(email);
  const m0 = await measure(email);
  evidence.m0 = m0;

  const bank = await importAndApproveBank(email, [
    { date: '2026-08-22', description: `FHIP TEST CARD PAYMENT ${salt}`, amount: -220, category: 'shopping' },
    { date: '2026-08-24', description: `FHIP TEST GROCER CREDIT ${salt}`, amount: 20, category: 'food' },
  ], { masked: 'xxxx7919', filename: `fhip-test-bank-consol-${salt}.csv` });
  evidence.bank = bank;
  expect(bank.approve?.status === 200, 'bank statement approved (repayment filed Shopping, credit filed Food)', bank.approve?.status);
  const credit = bank.txns.find((t: any) => t.credit_debit === 'credit');
  expect(credit?.user_override === true && credit?.category_id != null, 'the 20 credit carries the user\'s own category (user_override)', { type: credit?.economic_transaction_type, override: credit?.user_override });

  const m1 = await measure(email);
  evidence.m1 = m1;
  expect(delta(m0, m1, 'expenses.actualTotalInWindow') === 220, 'before the card Apply: only the user-filed repayment counts (+220)', delta(m0, m1, 'expenses.actualTotalInWindow'));
  expect(delta(m0, m1, 'expenses.refundsUnlinked') === 20, 'rule 10: the 20 credit filed as Food is an UNLINKED refund (+20 unlinked), not spending', delta(m0, m1, 'expenses.refundsUnlinked'));

  const card = await uploadLiabilityCsv(email, ['Transaction Date,Description,Amount,Transaction Type,Merchant',
    `14/08/2026,FHIP TEST GROCER ${salt},200.00,Purchase,FHIP Test Grocer`,
    `18/08/2026,FHIP TEST CAFE ${salt},20.00,Purchase,FHIP Test Cafe`,
    `22/08/2026,Payment Received - Thank You ${salt},220.00,Payment,`], {
    statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Card', masked_identifier: 'xxxx8919',
    statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', statement_date: '2026-08-31', due_date: '2026-09-15',
    opening_balance: '1000.00', closing_balance: '1000.00', credit_limit: '5000.00', minimum_payment: '25.00',
  }, `fhip-test-card-consol-${salt}.csv`);
  const pay = card.activities.find((a: any) => a.activity_type === 'PAYMENT');
  const repayment = bank.txns.find((t: any) => t.credit_debit === 'debit');
  expect(pay?.linked_transaction_id === repayment?.id, 'card PAYMENT matched to the bank repayment', { linked: pay?.linked_transaction_id, bank: repayment?.id });
  const pp = await approveAndPropose(email, card.documentId);
  const r = await call(email, 'POST', liabilityApplyRoute(pp.proposalId!), { json: { decision: 'add_new', selectedFields: panelDefault(pp.fields), owner: 'self' } });
  expect(r.status === 200, 'card statement Applied', { s: r.status, code: r.json?.code });
  evidence.card = { documentId: card.documentId, statementId: card.statementId, proposalId: pp.proposalId, apply: r.json?.data };
  const links = await rowsFor('fdh_transaction_links', userId, 'id,link_type,status', (q) => q.eq('transaction_id_from', repayment.id));
  expect(links.length === 1 && links[0].link_type === 'credit_card_settlement' && links[0].status === 'confirmed', 'ONE confirmed credit_card_settlement link from the user-filed repayment', links);

  const m2 = await measure(email);
  evidence.m2 = m2;
  expect(delta(m0, m2, 'expenses.actualTotalInWindow') === 220, 'D1 ORACLE (merged): purchases 200 + 20 repaid 220, repayment filed Shopping -> spending +220, never +440', delta(m0, m2, 'expenses.actualTotalInWindow'));
  expect(delta(m0, m2, 'expenses.refundsUnlinked') === 20 && delta(m0, m2, 'expenses.refundsNetted') === 0, 'rule 10 (merged): the credit stays an unlinked refund after the Apply (+20 unlinked, 0 netted)', { unlinked: delta(m0, m2, 'expenses.refundsUnlinked'), netted: delta(m0, m2, 'expenses.refundsNetted') });
  expect(delta(m0, m2, 'dashboard.totalLiabilities') === 1000, 'liability = statement closing 1,000', delta(m0, m2, 'dashboard.totalLiabilities'));
  expect(delta(m0, m2, 'dashboard.netWorth') === -1000, 'Net Worth -1,000 (the card liability; the bank balance is NOT added until the user applies it, D-04)', delta(m0, m2, 'dashboard.netWorth'));
  expect(delta(m0, m2, 'dashboard.totalMonthlyExpenses') === delta(m0, m2, 'expenses.combinedMonthly'), 'Dashboard combined expenses move exactly as the expense read model\'s combined basis', { dash: delta(m0, m2, 'dashboard.totalMonthlyExpenses'), rm: delta(m0, m2, 'expenses.combinedMonthly') });
  const disclosure = (m2.dashboard as any).bankBalanceEvidence;
  expect(disclosure != null && disclosure.count >= 1, 'the not-yet-applied bank balance is disclosed as "not in Net Worth" (merged disclosure helper)', disclosure);

  const ok = results.filter((x) => x.ok).length;
  saveEvidence(`consol_recheck_${salt}`, { evidence, results });
  console.log(`\n${ok}/${results.length} checks passed`);
  if (ok !== results.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
