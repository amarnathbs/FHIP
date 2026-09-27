/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * ORACLE: payslip net 5,000 (gross 6,700, tax 1,700, employer super 575) + bank salary credit 5,000
 *   -> income counted ONCE (net +5,000 / gross +6,700), in BOTH upload orders (WP-09 restamp).
 *   Employer super 575 never becomes income.
 * APPLY SAFETY: two simultaneous income Apply calls -> exactly one effect; repeat -> ALREADY_APPLIED;
 *   cross-tenant Apply -> refused.
 *
 *   npx tsx scripts/canonical_cert/econ/scenario_payslip.ts --order payslip-first --email E --attacker A
 *   npx tsx scripts/canonical_cert/econ/scenario_payslip.ts --order bank-first    --email E --attacker A
 *   (payslip-first resume after an interrupted run: --resume-proposal <id> --m0 <file>)
 */
import fs from 'node:fs';
import { call, measure, delta, expect, results, saveEvidence } from './lib';
import { importAndApproveBank, rowsFor, userIdOf } from './flows';
import { uploadPayslip, approvePayslip, incomeApplyRoute, payslipPanelSelection } from './payslip_flow';
import { fireConcurrently } from './concurrent';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const attacker = arg('--attacker')!;
const order = arg('--order') as 'payslip-first' | 'bank-first';
const salt = arg('--salt') ?? 'B';
const tag = `${order}_${salt}`;
const evidence: Record<string, unknown> = { order, email };
const AUG = { year: 2026, month: 8 };

async function bankSalary() {
  const bank = await importAndApproveBank(email, [
    { date: '2026-08-01', description: `FHIP TEST EMPLOYER PTY LTD SALARY ${salt}`, amount: 5000, category: 'income' },
  ], { masked: order === 'bank-first' ? 'xxxx7104' : 'xxxx7103', filename: `fhip-test-bank-salary-${tag}.csv` });
  expect(bank.approve?.status === 200, `${order}: bank salary statement approved`, bank.approve);
  return bank;
}

async function payslipToProposal() {
  const up = await uploadPayslip(email, AUG, salt);
  const pe = up.review?.payroll_event;
  expect(pe?.gross_pay === 6700 && pe?.net_pay === 5000 && pe?.employer_retirement_contribution === 575 && pe?.ytd_gross === 13400,
    `${order}: payslip extracted current period (gross 6,700 / net 5,000 / employer super 575), YTD kept apart (13,400)`, { gross: pe?.gross_pay, net: pe?.net_pay, sup: pe?.employer_retirement_contribution, ytd: pe?.ytd_gross });
  const ap = await approvePayslip(email, up.documentId);
  expect(ap.approve.status === 200 && Boolean(ap.proposalId), `${order}: payslip approved and income proposal generated`, { approve: ap.approve.status, proposal: ap.proposal.status });
  return { up, ap, payrollEventId: pe?.id as string };
}

async function main() {
  const userId = await userIdOf(email);
  let m0: any;
  let proposalId: string; let fields: any[]; let payrollEventId: string;
  let bankTxnId: string | null = null;

  if (arg('--resume-proposal')) {
    m0 = JSON.parse(fs.readFileSync(arg('--m0')!, 'utf8'));
    proposalId = arg('--resume-proposal')!;
    const pr = await rowsFor('fhip_import_proposal_fields', userId, 'field_name,value_kind,proposed_value,existing_value,is_recommended,requires_confirmation', (q) => q.eq('proposal_id', proposalId));
    fields = pr;
    const p = (await rowsFor('fhip_import_proposals', userId, 'source_payroll_event_id', (q) => q.eq('id', proposalId)))[0];
    payrollEventId = p.source_payroll_event_id;
    evidence.resumed = { proposalId, m0File: arg('--m0') };
  } else {
    m0 = await measure(email);
    if (order === 'bank-first') {
      const bank = await bankSalary();
      bankTxnId = bank.txns[0]?.id ?? null;
      evidence.bank = { documentId: bank.documentId, decisions: bank.decisions };
      const mb = await measure(email);
      evidence.mAfterBank = mb;
      expect(delta(m0, mb, 'income.countedMonthly') === 5000, 'bank-first: approved bank salary alone counts as actual income 5,000 (D-07)', delta(m0, mb, 'income.countedMonthly'));
    }
    const pp = await payslipToProposal();
    proposalId = pp.ap.proposalId!; fields = pp.ap.fields; payrollEventId = pp.payrollEventId;
    evidence.payslip = { documentId: pp.up.documentId, payrollEvent: pp.up.review?.payroll_event, proposal: pp.ap.proposal.json };
    if (order === 'bank-first') {
      const pe = (await rowsFor('fdh_payroll_events', userId, 'id,bank_match_status,bank_match_transaction_id', (q) => q.eq('id', payrollEventId)))[0];
      evidence.restampAtExtraction = pe;
      expect(pe?.bank_match_status === 'matched' && pe?.bank_match_transaction_id === bankTxnId, 'bank-first: the payslip matched the ALREADY-approved bank credit (WP-09 restamp)', pe);
    }
  }
  evidence.m0 = m0;
  const m1 = await measure(email);
  evidence.m1 = m1;
  const preApplyBase = order === 'bank-first' ? (evidence.mAfterBank as any) : m0;
  expect(delta(preApplyBase, m1, 'dashboard.netMonthlyIncome') === 0 && delta(preApplyBase, m1, 'dashboard.grossMonthlyIncome') === 0,
    `${order}: approved-but-not-Applied payslip has ZERO income effect`, { dNet: delta(preApplyBase, m1, 'dashboard.netMonthlyIncome'), dGross: delta(preApplyBase, m1, 'dashboard.grossMonthlyIncome') });

  // cross-tenant attempt on the READY proposal
  const before = await rowsFor('income_sources', userId, 'id');
  const xt = await call(attacker, 'POST', incomeApplyRoute(proposalId), { json: { decision: 'add_new', selectedFields: payslipPanelSelection(fields) } });
  const after = await rowsFor('income_sources', userId, 'id');
  const attackerId = await userIdOf(attacker);
  const attackerImported = await rowsFor('income_sources', attackerId, 'id,source_type', (q) => q.eq('source_type', 'payslip_import'));
  evidence.crossTenant = { status: xt.status, json: xt.json };
  expect(xt.status >= 400 && after.length === before.length && attackerImported.length === 0, `${order}: cross-tenant income Apply refused, nothing written`, { status: xt.status, code: xt.json?.code });

  // TRUE CONCURRENCY
  const selection = payslipPanelSelection(fields);
  evidence.selection = selection;
  const apps0 = await rowsFor('fhip_import_applications', userId, 'id', (q) => q.eq('target_domain', 'income'));
  const conc = await fireConcurrently(2, () => call(email, 'POST', incomeApplyRoute(proposalId), { json: { decision: 'add_new', selectedFields: selection } }));
  evidence.concurrentApply = conc;
  const apps1 = await rowsFor('fhip_import_applications', userId, 'id', (q) => q.eq('target_domain', 'income'));
  const src1 = await rowsFor('income_sources', userId, 'id,amount,net_amount,source_type,frequency');
  expect(conc.overlapped, `${order}: the two income Apply calls overlapped in time`, conc.results.map((r) => [Math.round(r.startedAt), Math.round(r.endedAt)]));
  const st = conc.results.map((r) => r.status).sort();
  expect(st[0] === 200 && st[1] === 409 && conc.results.some((r) => r.json?.code === 'ALREADY_APPLIED'), `${order}: exactly one income Apply succeeded, the other ALREADY_APPLIED`, conc.results.map((r) => ({ status: r.status, code: r.json?.code, outcome: r.json?.data?.outcome })));
  expect(src1.length - after.length === 1 && apps1.length - apps0.length === 1, `${order}: exactly ONE income_sources row and ONE application created`, { dSources: src1.length - after.length, dApps: apps1.length - apps0.length });

  const m2 = await measure(email);
  evidence.m2 = m2;
  if (order === 'payslip-first') {
    expect(delta(m1, m2, 'dashboard.netMonthlyIncome') === 5000 && delta(m1, m2, 'dashboard.grossMonthlyIncome') === 6700,
      'payslip-first: Apply adds net 5,000 / gross 6,700 (employer super 575 NOT income)', { dNet: delta(m1, m2, 'dashboard.netMonthlyIncome'), dGross: delta(m1, m2, 'dashboard.grossMonthlyIncome') });
    const bank = await bankSalary();
    bankTxnId = bank.txns[0]?.id ?? null;
    evidence.bank = { documentId: bank.documentId, decisions: bank.decisions };
    const pe = (await rowsFor('fdh_payroll_events', userId, 'id,bank_match_status,bank_match_transaction_id', (q) => q.eq('id', payrollEventId)))[0];
    evidence.matchAfterBankApproval = pe;
    expect(pe?.bank_match_status === 'matched' && pe?.bank_match_transaction_id === bankTxnId, 'payslip-first: the later bank approval matched the payslip (post-approval matcher)', pe);
    const m3 = await measure(email);
    evidence.m3 = m3;
    expect(delta(m2, m3, 'dashboard.netMonthlyIncome') === 0 && delta(m2, m3, 'dashboard.grossMonthlyIncome') === 0 && delta(m2, m3, 'income.countedMonthly') === 0,
      'payslip-first: the matching bank salary adds 0 (represented by the payslip income)', { dNet: delta(m2, m3, 'dashboard.netMonthlyIncome'), dGross: delta(m2, m3, 'dashboard.grossMonthlyIncome'), dCounted: delta(m2, m3, 'income.countedMonthly') });
    expect(delta(m0, m3, 'dashboard.netMonthlyIncome') === 5000 && delta(m0, m3, 'dashboard.grossMonthlyIncome') === 6700,
      'payslip-first ORACLE: payslip + bank salary = ONE income (net +5,000, gross +6,700, never +10,000 net)', { dNet: delta(m0, m3, 'dashboard.netMonthlyIncome'), dGross: delta(m0, m3, 'dashboard.grossMonthlyIncome') });
  } else {
    expect(delta(m0, m2, 'dashboard.netMonthlyIncome') === 5000 && delta(m0, m2, 'dashboard.grossMonthlyIncome') === 6700 && delta(m0, m2, 'income.countedMonthly') === 0,
      'bank-first ORACLE: bank salary + payslip = ONE income (net +5,000, gross +6,700; bank credit now represented, never +10,000)', { dNet: delta(m0, m2, 'dashboard.netMonthlyIncome'), dGross: delta(m0, m2, 'dashboard.grossMonthlyIncome'), dCounted: delta(m0, m2, 'income.countedMonthly') });
  }
  const rep = await call(email, 'POST', incomeApplyRoute(proposalId), { json: { decision: 'add_new', selectedFields: selection } });
  const src2 = await rowsFor('income_sources', userId, 'id');
  const mR = await measure(email);
  evidence.repeat = { status: rep.status, json: rep.json };
  expect(rep.status === 409 && rep.json?.code === 'ALREADY_APPLIED' && src2.length === src1.length && delta(m2, mR, 'dashboard.grossMonthlyIncome') === (order === 'payslip-first' ? 0 : 0),
    `${order}: repeat income Apply -> ALREADY_APPLIED, 0 new rows, no figure change`, { status: rep.status, code: rep.json?.code });
  saveEvidence(`scenario_payslip_${tag}`, { evidence, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); saveEvidence(`scenario_payslip_${tag}_error`, { evidence, results, error: String(e?.stack ?? e) }); process.exitCode = 1; });
