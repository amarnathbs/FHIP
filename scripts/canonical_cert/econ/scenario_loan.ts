/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * ORACLE: loan payment 2,000 = principal 1,550 + interest 430 + fee 20
 *   -> liability -1,550 (opening 400,000 -> closing 398,450), cost of debt 450, debt service / outflow 2,000 ONCE,
 *   spending 0, income 0.  Drawdown (LOAN_ADVANCE 5,000 + bank redraw credit 5,000) -> income 0.
 * APPLY SAFETY: two simultaneous Apply calls -> exactly one effect; repeat Apply -> ALREADY_APPLIED, nothing new;
 *   a different user's Apply of this user's proposal -> refused, nothing written.
 *
 *   npx tsx scripts/canonical_cert/econ/scenario_loan.ts --email forecast.tc007@example.test --attacker forecast.tc038@example.test
 */
import { call, measure, delta, expect, results, saveEvidence, round2 } from './lib';
import { importAndApproveBank, uploadLiabilityCsv, approveAndPropose, liabilityApplyRoute, rowsFor, userIdOf } from './flows';
import { fireConcurrently } from './concurrent';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const attacker = arg('--attacker')!;
const salt = arg('--salt') ?? 'B';
const evidence: Record<string, unknown> = {};

/** The Liabilities panel's default selection: recommended, not confirmation-gated, and changed. */
function panelDefault(fields: any[]): string[] {
  return fields.filter((f) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value).map((f) => f.field_name);
}

async function counts(userId: string) {
  const [liab, txns, links, apps, allocs] = await Promise.all([
    rowsFor('liabilities', userId, 'id,balance,source_type,liability_name,debt_type'),
    rowsFor('fdh_transactions', userId, 'id,financial_account_id,economic_transaction_type,amount_original,credit_debit'),
    rowsFor('fdh_transaction_links', userId, 'id,link_type,status'),
    rowsFor('fhip_import_applications', userId, 'id,proposal_id,target_entity_id'),
    rowsFor('fdh_transaction_allocations', userId, 'transaction_id,allocation_sequence,economic_transaction_type,amount'),
  ]);
  return { liabilities: liab.length, transactions: txns.length, links: links.length, applications: apps.length, allocations: allocs.length, liab, allocs };
}

async function main() {
  const userId = await userIdOf(email);
  if (args.includes('--july-only')) {
    // Resume after an interrupted run: m4 is the figure set measured BEFORE the July bank statement.
    const prev = JSON.parse((await import('node:fs')).readFileSync(arg('--resume-evidence')!, 'utf8'));
    evidence.resumedFrom = arg('--resume-evidence');
    return julyPart(userId, { target_entity_id: arg('--liability-id')! }, prev.evidence.m4);
  }
  const m0 = await measure(email);
  evidence.m0 = m0;

  // 1) Bank statement (August): the 2,000 repayment debit. The user files it as a loan repayment.
  const bank = await importAndApproveBank(email, [
    { date: '2026-08-15', description: `FHIP TEST HOME LOAN REPAYMENT ${salt}`, amount: -2000, category: 'loan_principal' },
  ], { masked: 'xxxx7102', filename: `fhip-test-bank-loan-aug-${salt}.csv` });
  evidence.bankAug = { documentId: bank.documentId, decisions: bank.decisions, approve: bank.approve, txns: bank.txns };
  expect(bank.approve?.status === 200, 'loan: bank statement approved through category-review approve-all', bank.approve);
  const m1 = await measure(email);
  evidence.m1 = m1;

  // 2) Loan statement (August): repayment decomposed 1,550 / 430 / 20.
  const loan = await uploadLiabilityCsv(email, [
    'Payment Date,Description,Amount,Type,Principal,Interest,Fee',
    `15/08/2026,Monthly Repayment ${salt},2000.00,Repayment,1550.00,430.00,20.00`,
  ], {
    statement_type: 'loan', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Home Loan',
    masked_identifier: 'xxxx5602', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', statement_date: '2026-08-31',
    opening_balance: '400000.00', closing_balance: '398450.00', interest_rate: '6.14',
  }, `fhip-test-home-loan-aug-${salt}.csv`);
  evidence.loanAug = loan;
  expect(loan.statement?.reconciliation_status === 'reconciled', 'loan: statement reconciled', { status: loan.statement?.reconciliation_status, variance: loan.statement?.reconciliation_variance });
  const pay = loan.activities.find((a: any) => a.activity_type === 'PAYMENT');
  expect(Boolean(pay) && pay.linked_transaction_id === bank.txns[0]?.id && pay.bank_match_status === 'matched', 'loan: repayment matched to the bank debit', { linked: pay?.linked_transaction_id, bankTxn: bank.txns[0]?.id, status: pay?.bank_match_status });

  const pp = await approveAndPropose(email, loan.documentId);
  evidence.loanAugProposal = pp;
  expect(pp.approve.status === 200 && Boolean(pp.proposalId), 'loan: statement approved and proposal generated', { approve: pp.approve.status, proposal: pp.proposal.status });
  const m2 = await measure(email);
  evidence.m2 = m2;
  expect(delta(m1, m2, 'dashboard.totalLiabilities') === 0 && delta(m1, m2, 'dashboard.debtMonthlyRepayments') === 0 && delta(m1, m2, 'expenses.actualTotalInWindow') === 0,
    'loan: before Apply the statement has ZERO effect (liabilities, debt service, spending)', { dLiab: delta(m1, m2, 'dashboard.totalLiabilities'), dDebt: delta(m1, m2, 'dashboard.debtMonthlyRepayments'), dSpend: delta(m1, m2, 'expenses.actualTotalInWindow') });

  // 3) CROSS-TENANT: another user tries to Apply this user's READY proposal.
  const c0 = await counts(userId);
  const xt = await call(attacker, 'POST', liabilityApplyRoute(pp.proposalId!), { json: { decision: 'add_new', selectedFields: panelDefault(pp.fields), owner: 'self' } });
  const c0b = await counts(userId);
  const attackerId = await userIdOf(attacker);
  const attackerLiab = await rowsFor('liabilities', attackerId, 'id,source_type', (q) => q.eq('source_type', 'liability_statement_import'));
  evidence.crossTenant = { status: xt.status, json: xt.json, victimBefore: { l: c0.liabilities, a: c0.applications }, victimAfter: { l: c0b.liabilities, a: c0b.applications }, attackerImportedLiabilities: attackerLiab.length };
  expect(xt.status >= 400 && c0b.liabilities === c0.liabilities && c0b.applications === c0.applications && c0b.transactions === c0.transactions && attackerLiab.length === 0,
    'loan: cross-tenant Apply refused and wrote nothing (victim or attacker)', { status: xt.status, code: xt.json?.code, error: xt.json?.error });

  // 4) TRUE CONCURRENCY: two simultaneous Apply calls.
  const selected = panelDefault(pp.fields);
  const conc = await fireConcurrently(2, () => call(email, 'POST', liabilityApplyRoute(pp.proposalId!), { json: { decision: 'add_new', selectedFields: selected, owner: 'self' } }));
  evidence.concurrentApply = conc;
  const statuses = conc.results.map((r) => r.status).sort();
  const c1 = await counts(userId);
  evidence.countsAfterApply = { before: { ...c0, liab: undefined, allocs: undefined }, after: { ...c1, liab: undefined, allocs: undefined } };
  expect(conc.overlapped, 'loan: the two Apply calls genuinely overlapped in time', conc.results.map((r) => ({ start: Math.round(r.startedAt), end: Math.round(r.endedAt) })));
  expect(statuses[0] === 200 && statuses[1] === 409 && conc.results.some((r) => r.json?.code === 'ALREADY_APPLIED'), 'loan: exactly one Apply succeeded, the other ALREADY_APPLIED', conc.results.map((r) => ({ status: r.status, code: r.json?.code, outcome: r.json?.data?.outcome })));
  expect(c1.liabilities - c0.liabilities === 1 && c1.applications - c0.applications === 1, 'loan: exactly ONE liability and ONE application row created', { dLiab: c1.liabilities - c0.liabilities, dApp: c1.applications - c0.applications });
  const applied = conc.results.find((r) => r.status === 200)!.json.data;
  evidence.applied = applied;
  const newLiab = c1.liab.find((l: any) => l.id === applied.target_entity_id);
  expect(newLiab && Number(newLiab.balance) === 398450, 'loan: liability balance = statement closing 398,450 (opening 400,000 - principal 1,550)', newLiab);
  const allocs = c1.allocs.filter((a: any) => !c0.allocs.some((b: any) => b.transaction_id === a.transaction_id && b.allocation_sequence === a.allocation_sequence));
  const byType = Object.fromEntries(['debt_principal', 'debt_interest', 'fee'].map((t) => [t, round2(allocs.filter((a: any) => a.economic_transaction_type === t).reduce((s: number, a: any) => s + Number(a.amount), 0))]));
  expect(byType.debt_principal === 1550 && byType.debt_interest === 430 && byType.fee === 20, 'loan: ledger allocations principal 1,550 / interest 430 / fee 20', byType);

  const m3 = await measure(email);
  evidence.m3 = m3;
  const dDebt = delta(m2, m3, 'dashboard.debtMonthlyRepayments');
  const dCod = delta(m2, m3, 'dashboard.costOfDebtMonthly');
  expect(delta(m2, m3, 'dashboard.totalLiabilities') === 398450, 'loan: totalLiabilities +398,450 (the new imported loan, once)', delta(m2, m3, 'dashboard.totalLiabilities'));
  expect(dDebt === 2000, 'loan: household debt service +2,000 (the payment counted ONCE: 1,550 + 430 + 20)', dDebt);
  expect(dCod === 450, 'loan: cost of debt 450 (interest 430 + fee 20)', dCod);
  expect(delta(m2, m3, 'expenses.actualTotalInWindow') === 0 && delta(m2, m3, 'dashboard.totalMonthlyExpenses') === 0, 'loan: spending +0 (interest/fee are cost of debt inside debt service, principal is not expense)', { dActual: delta(m2, m3, 'expenses.actualTotalInWindow'), dDash: delta(m2, m3, 'dashboard.totalMonthlyExpenses') });
  expect(delta(m2, m3, 'dashboard.grossMonthlyIncome') === 0, 'loan: income +0', delta(m2, m3, 'dashboard.grossMonthlyIncome'));
  expect(round2(delta(m2, m3, 'dashboard.monthlySurplus')) === -2000, 'loan: surplus -2,000 (cash outflow once)', delta(m2, m3, 'dashboard.monthlySurplus'));

  // 5) REPEAT Apply (sequential) -> ALREADY_APPLIED, nothing new.
  const rep = await call(email, 'POST', liabilityApplyRoute(pp.proposalId!), { json: { decision: 'add_new', selectedFields: selected, owner: 'self' } });
  const c2 = await counts(userId);
  evidence.repeatApply = { status: rep.status, json: rep.json };
  expect(rep.status === 409 && rep.json?.code === 'ALREADY_APPLIED' && c2.liabilities === c1.liabilities && c2.transactions === c1.transactions && c2.links === c1.links && c2.allocations === c1.allocations && c2.applications === c1.applications,
    'loan: repeat Apply -> ALREADY_APPLIED and 0 new rows (liabilities, transactions, links, allocations, applications)', { status: rep.status, code: rep.json?.code });
  const m4 = await measure(email);
  evidence.m4 = m4;
  expect(delta(m3, m4, 'dashboard.debtMonthlyRepayments') === 0 && delta(m3, m4, 'dashboard.totalLiabilities') === 0, 'loan: repeat Apply changed no figure', { dDebt: delta(m3, m4, 'dashboard.debtMonthlyRepayments') });
  await julyPart(userId, applied, m4);
}

async function julyPart(userId: string, applied: { target_entity_id: string }, m4: Awaited<ReturnType<typeof measure>>) {
  // 6) DRAWDOWN (July): bank redraw credit 5,000 + LOAN_ADVANCE 5,000 on the loan (opening 395,000 -> closing 400,000).
  if (!args.includes('--skip-bank-jul')) {
    const bankJul = await importAndApproveBank(email, [
      { date: '2026-07-10', description: `FHIP TEST LOAN REDRAW ${salt}`, amount: 5000, category: 'transfer_own_account' },
    ], { masked: 'xxxx7102', filename: `fhip-test-bank-loan-jul-${salt}.csv`, period: { from: '2026-07-01', to: '2026-07-31' } });
    evidence.bankJul = { documentId: bankJul.documentId, decisions: bankJul.decisions, approve: bankJul.approve };
  }
  const loanJul = await uploadLiabilityCsv(email, [
    'Payment Date,Description,Amount,Type,Principal,Interest,Fee',
    `14/07/2026,Redraw ${salt},5000.00,Loan_Advance,,,`,
  ], {
    statement_type: 'loan', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Home Loan',
    masked_identifier: 'xxxx5602', statement_period_start: '2026-07-01', statement_period_end: '2026-07-31', statement_date: '2026-07-31',
    opening_balance: '395000.00', closing_balance: '400000.00', interest_rate: '6.14',
  }, `fhip-test-home-loan-jul-${salt}.csv`);
  evidence.loanJul = loanJul;
  const ppJul = await approveAndPropose(email, loanJul.documentId);
  evidence.loanJulProposal = ppJul;
  const balField = ppJul.fields.find((f: any) => f.field_name === 'balance');
  evidence.olderStatementBalanceField = balField;
  const julDefault = panelDefault(ppJul.fields);
  evidence.olderStatementPanelDefault = julDefault;
  expect(!(balField && julDefault.includes('balance')), 'loan: an OLDER (July) statement is NOT pre-selected to overwrite the balance set from the newer (August) statement',
    { existing: balField?.existing_value, proposed: balField?.proposed_value, recommended: balField?.is_recommended, preselected: julDefault });
  const m5 = await measure(email);
  evidence.m5 = m5;
  // The panel's default decision is the proposal's recommendation (after the fix: keep_existing for an older statement).
  const julMode = ppJul.proposal.json?.data?.proposal?.recommended_apply_mode === 'keep_existing' ? 'keep_existing' : 'update_existing';
  const applyJul = await call(email, 'POST', liabilityApplyRoute(ppJul.proposalId!), { json: julMode === 'keep_existing' ? { decision: julMode, owner: 'self' } : { decision: julMode, selectedFields: julDefault.length ? julDefault : undefined, owner: 'self' } });
  evidence.applyJul = { status: applyJul.status, json: applyJul.json };
  const m6 = await measure(email);
  evidence.m6 = m6;
  const liabAfterJul = (await rowsFor('liabilities', userId, 'id,balance,due_date', (q) => q.eq('id', applied.target_entity_id)))[0];
  evidence.liabilityAfterOlderApply = liabAfterJul;
  expect(delta(m4, m6, 'dashboard.grossMonthlyIncome') === 0 && delta(m4, m6, 'income.countedMonthly') === 0, 'loan: drawdown 5,000 -> income +0 (bank redraw credit and LOAN_ADVANCE)', { dGross: delta(m4, m6, 'dashboard.grossMonthlyIncome'), dCounted: delta(m4, m6, 'income.countedMonthly') });
  expect(Number(liabAfterJul?.balance) === 398450, 'loan: applying the OLDER July statement with the panel defaults leaves the current balance 398,450', liabAfterJul);
  saveEvidence(`scenario_loan_${salt}`, { evidence, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); saveEvidence(`scenario_loan_${salt}_error`, { evidence, results, error: String(e?.stack ?? e) }); process.exitCode = 1; });
