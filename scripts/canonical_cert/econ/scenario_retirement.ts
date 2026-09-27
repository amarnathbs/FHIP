/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * ORACLES (retirement = a summary-balance register):
 *   - rollover Fund A -> Fund B (July statements): income 0, expense 0, Net Worth 0;
 *   - employer super 575 on the payslip + 575 on the fund statement -> ONE effect (retirement contribution
 *     once, never income).
 * APPLY SAFETY: two simultaneous retirement Apply calls -> one effect; repeat -> nothing new; cross-tenant refused.
 *
 *   npx tsx scripts/canonical_cert/econ/scenario_retirement.ts --email E --attacker A
 */
import { call, measure, delta, expect, results, saveEvidence, round2 } from './lib';
import { rowsFor, userIdOf } from './flows';
import { uploadPayslip, approvePayslip, incomeApplyRoute, payslipPanelSelection } from './payslip_flow';
import { fireConcurrently } from './concurrent';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const attacker = arg('--attacker')!;
const salt = arg('--salt') ?? 'B';
const evidence: Record<string, unknown> = { email };
const log = (label: string, r: { status: number; json: any }) => { console.log(`  ${label} -> HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r; };

const period = (month: number) => ({ from: `2026-${String(month).padStart(2, '0')}-01`, to: `2026-${String(month).padStart(2, '0')}-${month === 6 ? '30' : '31'}` });

function summaryCsv(items: [string, number][], month: number) {
  const p = period(month);
  return ['Item,Amount,Period', ...items.map(([k, v]) => `${k},${v.toFixed(2)},${p.from} to ${p.to}`)].join('\n') + '\n';
}

async function importFund(fund: 'A' | 'B', month: number, items: [string, number][]) {
  const p = period(month);
  const qs = new URLSearchParams({ jurisdiction: 'AU', currency_code: 'AUD', fund_name: `FHIP Test Super Fund ${fund}`, masked_account_identifier: fund === 'A' ? 'xxxx1177' : 'xxxx2288', statement_period_start: p.from, statement_period_end: p.to, filename: `fhip-test-super-${fund}-${month}-${salt}.csv` });
  const up = log(`upload fund ${fund} m${month}`, await call(email, 'POST', `/api/financial-data-hub/retirement-statement/upload?${qs}`, { body: new TextEncoder().encode(summaryCsv(items, month)), contentType: 'text/csv' }));
  const documentId = up.json?.data?.document_id as string;
  if (!documentId || up.status !== 200) throw new Error(`retirement upload failed: ${up.status}`);
  const review0 = await call(email, 'GET', `/api/financial-data-hub/retirement-statement/${documentId}`);
  const match = log('account-match auto', await call(email, 'POST', `/api/financial-data-hub/retirement-statement/${documentId}/account-match`, { json: { action: 'auto' } }));
  if (match.json?.data?.account_match_status !== 'matched') {
    log('account-match confirm_new', await call(email, 'POST', `/api/financial-data-hub/retirement-statement/${documentId}/account-match`, { json: { action: 'confirm_new' } }));
  }
  log('evidence-matches', await call(email, 'POST', `/api/financial-data-hub/retirement-statement/${documentId}/evidence-matches`));
  const ap = log('approve', await call(email, 'POST', `/api/financial-data-hub/retirement-statement/${documentId}/approve`));
  const pr = log('proposal', await call(email, 'POST', `/api/financial-data-hub/retirement-statement/${documentId}/proposal`));
  const body = pr.json?.data ?? pr.json;
  const fields = (body?.fields ?? []) as any[];
  const norm = fields.map((f) => ({ name: f.field_name ?? f.fieldName, rec: f.is_recommended ?? f.isRecommended, conf: f.requires_confirmation ?? f.requiresConfirmation, proposed: f.proposed_value ?? f.proposedValue, existing: f.existing_value ?? f.existingValue }));
  return { documentId, review0: review0.json?.data ?? review0.json, approve: ap, proposalId: String(body?.proposal_id), mode: body?.recommended_apply_mode as string, fields: norm };
}

const defaultTicked = (fields: { name: string; rec: boolean; conf: boolean }[]) => fields.filter((f) => f.rec && !f.conf).map((f) => f.name);

async function applyFund(documentId: string, proposalId: string, decision: string, selected: string[], who = email) {
  return call(who, 'POST', `/api/financial-data-hub/retirement-statement/${documentId}/apply`, { json: { proposal_id: proposalId, decision, selected_fields: selected } });
}

async function main() {
  const userId = await userIdOf(email);
  const m0 = await measure(email);
  evidence.m0 = m0;

  // --- June: both funds as they stood (A 30,000; B 100,000), no activity --------------------------
  const aJun = await importFund('A', 6, [['Opening balance', 30000], ['Closing balance', 30000]]);
  const bJun = await importFund('B', 6, [['Opening balance', 100000], ['Closing balance', 100000]]);
  evidence.june = { aJun, bJun };
  const r0 = await rowsFor('retirement_accounts', userId, 'id');
  // cross-tenant attempt first (proposal is READY)
  const xt = log('cross-tenant apply', await applyFund(aJun.documentId, aJun.proposalId, aJun.mode === 'add_new' ? 'add_new' : 'update_existing', defaultTicked(aJun.fields), attacker));
  const r0b = await rowsFor('retirement_accounts', userId, 'id');
  evidence.crossTenant = xt;
  expect(xt.status >= 400 && r0b.length === r0.length, 'retirement: cross-tenant Apply refused, nothing written', { status: xt.status, err: xt.json?.error });
  // TRUE CONCURRENCY on fund A's Apply
  const conc = await fireConcurrently(2, () => applyFund(aJun.documentId, aJun.proposalId, aJun.mode === 'add_new' ? 'add_new' : 'update_existing', defaultTicked(aJun.fields)));
  evidence.concurrentApply = conc;
  const r1 = await rowsFor('retirement_accounts', userId, 'id,account_name,current_balance');
  const apps = await rowsFor('fhip_import_applications', userId, 'id,target_entity_id', (q) => q.eq('target_domain', 'retirement'));
  expect(conc.overlapped, 'retirement: the two Apply calls overlapped in time', conc.results.map((r) => [Math.round(r.startedAt), Math.round(r.endedAt)]));
  expect(conc.results.filter((r) => r.status === 200).length === 1 && r1.length - r0.length === 1 && apps.length === 1, 'retirement: exactly one Apply succeeded -> ONE retirement account, ONE application', { statuses: conc.results.map((r) => ({ s: r.status, code: r.json?.code ?? r.json?.error })), dAccounts: r1.length - r0.length, apps: apps.length });
  const rep = log('repeat apply', await applyFund(aJun.documentId, aJun.proposalId, aJun.mode === 'add_new' ? 'add_new' : 'update_existing', defaultTicked(aJun.fields)));
  const r1b = await rowsFor('retirement_accounts', userId, 'id');
  const apps1b = await rowsFor('fhip_import_applications', userId, 'id', (q) => q.eq('target_domain', 'retirement'));
  expect(rep.status === 409 && r1b.length === r1.length && apps1b.length === apps.length, 'retirement: repeat Apply refused (409), 0 new rows', { status: rep.status, code: rep.json?.code ?? rep.json?.error });
  const bJunApply = log('apply B June', await applyFund(bJun.documentId, bJun.proposalId, bJun.mode === 'add_new' ? 'add_new' : 'update_existing', defaultTicked(bJun.fields)));
  expect(bJunApply.status === 200, 'retirement: fund B June applied', bJunApply.json);
  const m1 = await measure(email);
  evidence.m1 = m1;
  expect(delta(m0, m1, 'dashboard.totalRetirement') === 130000, 'retirement: June balances in once (A 30,000 + B 100,000 = +130,000)', delta(m0, m1, 'dashboard.totalRetirement'));

  // --- July: rollover A -> B (30,000) ------------------------------------------------------------
  const aJul = await importFund('A', 7, [['Opening balance', 30000], ['Rollover out', 30000], ['Closing balance', 0]]);
  const bJul = await importFund('B', 7, [['Opening balance', 100000], ['Rollover in', 30000], ['Closing balance', 130000]]);
  evidence.july = { aJul, bJul };
  const aJulApply = log('apply A July', await applyFund(aJul.documentId, aJul.proposalId, aJul.mode === 'add_new' ? 'add_new' : 'update_existing', defaultTicked(aJul.fields)));
  const bJulApply = log('apply B July', await applyFund(bJul.documentId, bJul.proposalId, bJul.mode === 'add_new' ? 'add_new' : 'update_existing', defaultTicked(bJul.fields)));
  expect(aJulApply.status === 200 && bJulApply.status === 200 && aJul.mode === 'update_existing' && bJul.mode === 'update_existing', 'retirement: July statements update the SAME two accounts', { a: [aJulApply.status, aJul.mode], b: [bJulApply.status, bJul.mode] });
  const m2 = await measure(email);
  evidence.m2 = m2;
  expect(delta(m1, m2, 'dashboard.totalRetirement') === 0 && delta(m1, m2, 'dashboard.netWorth') === 0, 'retirement ORACLE: rollover A -> B -> Net Worth 0 (retirement total unchanged)', { dRet: delta(m1, m2, 'dashboard.totalRetirement'), dNW: delta(m1, m2, 'dashboard.netWorth') });
  expect(delta(m1, m2, 'dashboard.grossMonthlyIncome') === 0 && delta(m1, m2, 'dashboard.totalMonthlyExpenses') === 0, 'retirement ORACLE: rollover -> income 0, expense 0', { dInc: delta(m1, m2, 'dashboard.grossMonthlyIncome'), dExp: delta(m1, m2, 'dashboard.totalMonthlyExpenses') });

  // --- August: employer super 575 on the payslip AND on fund B's statement --------------------------
  const ps = await uploadPayslip(email, { year: 2026, month: 8 }, salt);
  const pa = await approvePayslip(email, ps.documentId);
  const psApply = log('payslip apply', await call(email, 'POST', incomeApplyRoute(pa.proposalId!), { json: { decision: pa.proposal.json?.data?.proposal?.recommended_apply_mode === 'update_existing' ? 'update_existing' : 'add_new', selectedFields: payslipPanelSelection(pa.fields) } }));
  const m3 = await measure(email);
  evidence.m3 = m3;
  expect(psApply.status === 200 && delta(m2, m3, 'dashboard.grossMonthlyIncome') === 6700, 'employer super: payslip adds gross 6,700 only (employer super 575 is NOT income)', delta(m2, m3, 'dashboard.grossMonthlyIncome'));
  expect(delta(m2, m3, 'dashboard.retirementEmployerMonthlyContribution') === 0 && delta(m2, m3, 'dashboard.totalRetirement') === 0, 'employer super: the payslip alone changes no retirement figure (evidence only)', { dContrib: delta(m2, m3, 'dashboard.retirementEmployerMonthlyContribution'), dRet: delta(m2, m3, 'dashboard.totalRetirement') });
  const bAug = await importFund('B', 8, [['Opening balance', 130000], ['Employer contributions', 575], ['Contributions tax', 86.25], ['Closing balance', 130488.75]]);
  evidence.august = bAug;
  const ticked = [...new Set([...defaultTicked(bAug.fields), ...bAug.fields.filter((f) => /employer_contribution|contribution_frequency/.test(f.name)).map((f) => f.name)])];
  evidence.augustTicked = ticked;
  const bAugApply = log('apply B August (contribution ticked)', await applyFund(bAug.documentId, bAug.proposalId, 'update_existing', ticked));
  const m4 = await measure(email);
  evidence.m4 = m4;
  const acct = (await rowsFor('retirement_accounts', userId, 'id,account_name,current_balance,employer_contribution,contribution_frequency')).filter((r: any) => String(r.account_name ?? '').includes('Fund B'));
  evidence.fundBAfterAugust = acct;
  expect(bAugApply.status === 200 && delta(m3, m4, 'dashboard.totalRetirement') === 488.75, 'employer super: fund statement adds the contribution to the balance ONCE (575 - 86.25 tax = +488.75)', delta(m3, m4, 'dashboard.totalRetirement'));
  expect(delta(m3, m4, 'dashboard.grossMonthlyIncome') === 0, 'employer super: fund statement adds 0 income', delta(m3, m4, 'dashboard.grossMonthlyIncome'));
  expect(round2(delta(m2, m4, 'dashboard.retirementEmployerMonthlyContribution')) === 575 || !ticked.some((t) => /employer_contribution/.test(t)),
    'employer super ORACLE: payslip 575 + fund 575 -> employer contribution counted ONCE (575/month, never 1,150)', { dContrib: delta(m2, m4, 'dashboard.retirementEmployerMonthlyContribution'), account: acct });
  saveEvidence(`scenario_retirement_${salt}`, { evidence, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); saveEvidence(`scenario_retirement_${salt}_error`, { evidence, results, error: String(e?.stack ?? e) }); process.exitCode = 1; });
