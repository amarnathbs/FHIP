/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * WP-15 input-population proposals, live:
 *  (a) "update planned from actual averages": generate / apply / re-apply / stale / TRUE concurrency
 *  (b) bank closing balance -> cash asset (D-04): generate / apply / re-apply / superseded / TRUE concurrency
 *
 *   npx tsx scripts/canonical_cert/econ/scenario_wp15.ts --email E --attacker A
 */
import { call, measure, delta, expect, results, saveEvidence, round2 } from './lib';
import { importAndApproveBank, rowsFor, userIdOf } from './flows';
import { fireConcurrently } from './concurrent';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const attacker = arg('--attacker')!;
const salt = arg('--salt') ?? 'B';
const evidence: Record<string, unknown> = { email };
const log = (label: string, r: { status: number; json: any }) => { console.log(`  ${label} -> HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 700)}`); return r; };
const SUB = { groceries: '4551726d-31f8-4d5b-9b32-e265b8d199e5', coffee: '979908f7-1088-488c-afe3-49dd4d144e2c', bank_fee: '521a978e-2d88-4d90-8b14-dc662c2d52c8' };

async function main() {
  const userId = await userIdOf(email);
  const m0 = await measure(email);
  evidence.m0 = m0;

  // A planned groceries item the user entered by hand (600/month).
  const created = log('create planned groceries', await call(email, 'POST', '/api/expenses', { json: { expense_name: 'Groceries (cert)', expense_category: 'food', amount: 600, frequency: 'monthly', currency_code: 'AUD', owner: 'self', is_essential: true, master_item_key: 'groceries' } }));
  const groceriesId = created.json?.data?.id as string;

  // August bank statement, categorised with subcategories by the user.
  const bank = await importAndApproveBank(email, [
    { date: '2026-08-03', description: `WOOLWORTHS FHIP TEST STORE ${salt}`, amount: -300, category: 'food' },
    { date: '2026-08-17', description: `COLES FHIP TEST ${salt}`, amount: -500, category: 'food' },
    { date: '2026-08-19', description: `FHIP TEST CAFE ${salt}`, amount: -40, category: 'food' },
    { date: '2026-08-28', description: `FHIP TEST BANK ACCOUNT FEE ${salt}`, amount: -5, category: 'financial_fees' },
  ], { masked: 'xxxx7107', filename: `fhip-test-bank-wp15-${salt}.csv`, approve: false, opening: 12000 });
  const subFor: Record<string, string> = { WOOLWORTHS: SUB.groceries, COLES: SUB.groceries, 'FHIP TEST CAFE': SUB.coffee, 'FHIP TEST BANK ACCOUNT FEE': SUB.bank_fee };
  for (const t of bank.txns as any[]) {
    const key = Object.keys(subFor).find((k) => t.description_raw.startsWith(k));
    if (key) log(`subcategory ${key}`, await call(email, 'POST', `/api/financial-data-hub/bank-transactions/${t.id}/correction`, { json: { field_name: 'subcategory_id', corrected_value: subFor[key], reason: 'cert: user picks subcategory' } }));
  }
  const approve = log('approve-all', await call(email, 'POST', `/api/financial-data-hub/documents/${bank.documentId}/category-review/approve-all`));
  evidence.bank = { documentId: bank.documentId, closing: bank.closing, approve: approve.json };
  const m1 = await measure(email);
  evidence.m1 = m1;

  // (a) expense averages
  const preview = log('preview', await call(email, 'GET', '/api/expenses/planned-from-actuals'));
  evidence.preview = preview.json;
  const gen1 = log('generate #1', await call(email, 'POST', '/api/expenses/planned-from-actuals', { json: { action: 'generate' } }));
  evidence.generate1 = gen1.json;
  const items1 = (gen1.json?.data?.items ?? []) as any[];
  const byKey = (items: any[], k: string) => items.find((i) => i.masterItemKey === k);
  const g1 = byKey(items1, 'groceries');
  expect(Boolean(g1?.proposalId) && round2(Number(g1?.actualMonthly)) === 800 && round2(Number(g1?.existing?.amount)) === 600, 'WP-15a: groceries proposal 600 -> 800 (covered-month average of 300 + 500)', g1);
  const decisions = (items: any[]) => items.filter((i) => i.proposalId).map((i) => ({ proposalId: i.proposalId, decision: i.recommended === 'add_new' ? 'add_new' : 'update_existing' }));
  const d1 = decisions(items1);
  evidence.decisions1 = d1;
  const plannedBefore = await rowsFor('expense_items', userId, 'id,expense_name,amount,master_item_key,source_type,is_active');

  // STALE: the user edits the planned item after the proposal was generated.
  log('user edits planned groceries 600 -> 650', await call(email, 'PATCH', `/api/expenses/${groceriesId}`, { json: { amount: 650 } }));
  const stale = log('apply stale batch', await call(email, 'POST', '/api/expenses/planned-from-actuals', { json: { action: 'apply', decisions: d1 } }));
  const plannedAfterStale = await rowsFor('expense_items', userId, 'id,amount,master_item_key');
  evidence.stale = { status: stale.status, json: stale.json };
  expect(stale.status === 409 && stale.json?.code === 'STALE_PROPOSAL' && plannedAfterStale.length === plannedBefore.length && Number(plannedAfterStale.find((r: any) => r.id === groceriesId)?.amount) === 650,
    'WP-15a: stale proposal refused (409 STALE_PROPOSAL), batch all-or-nothing: 0 rows added, groceries stays at the user\'s 650', { status: stale.status, code: stale.json?.code, rows: plannedAfterStale.length - plannedBefore.length });

  // cross-tenant on a fresh (ready) proposal set
  const gen2 = log('generate #2', await call(email, 'POST', '/api/expenses/planned-from-actuals', { json: { action: 'generate' } }));
  const items2 = (gen2.json?.data?.items ?? []) as any[];
  const d2 = decisions(items2);
  evidence.generate2 = gen2.json; evidence.decisions2 = d2;
  const attackerId = await userIdOf(attacker);
  const attackerBefore = await rowsFor('expense_items', attackerId, 'id');
  const xt = log('cross-tenant apply', await call(attacker, 'POST', '/api/expenses/planned-from-actuals', { json: { action: 'apply', decisions: d2 } }));
  const attackerAfter = await rowsFor('expense_items', attackerId, 'id');
  const victimAfterXt = await rowsFor('expense_items', userId, 'id,amount');
  evidence.crossTenant = xt;
  expect(xt.status >= 400 && attackerAfter.length === attackerBefore.length && victimAfterXt.length === plannedAfterStale.length && Number(victimAfterXt.find((r: any) => r.id === groceriesId)?.amount) === 650,
    'WP-15a: cross-tenant Apply refused, nothing written for either user', { status: xt.status, code: xt.json?.code });

  // TRUE CONCURRENCY
  const conc = await fireConcurrently(2, () => call(email, 'POST', '/api/expenses/planned-from-actuals', { json: { action: 'apply', decisions: d2 } }));
  evidence.concurrentApply = conc;
  const plannedAfter = await rowsFor('expense_items', userId, 'id,expense_name,amount,frequency,master_item_key,source_type,is_active');
  const newRows = plannedAfter.filter((r: any) => !plannedAfterStale.some((b: any) => b.id === r.id));
  evidence.plannedAfter = plannedAfter;
  expect(conc.overlapped, 'WP-15a: the two Apply calls overlapped in time', conc.results.map((r) => [Math.round(r.startedAt), Math.round(r.endedAt)]));
  expect(conc.results.filter((r) => r.status === 200).length === 1 && conc.results.some((r) => r.json?.code === 'ALREADY_APPLIED'), 'WP-15a: exactly one Apply succeeded, the other ALREADY_APPLIED', conc.results.map((r) => ({ s: r.status, code: r.json?.code })));
  const addCount = items2.filter((i) => i.proposalId && i.recommended === 'add_new').length;
  expect(newRows.length === addCount && Number(plannedAfter.find((r: any) => r.id === groceriesId)?.amount) === 800, 'WP-15a: each item written ONCE (groceries -> 800; one row per "add")', { newRows: newRows.map((r: any) => [r.master_item_key, r.amount, r.source_type]), addCount });
  const m2 = await measure(email);
  evidence.m2 = m2;
  expect(delta(m1, m2, 'expenses.combinedMonthly') === 0 && delta(m1, m2, 'dashboard.totalMonthlyExpenses') === 0, 'WP-15a: Apply leaves the combined/Dashboard expense figure unchanged for groups with covered actuals (plan now equals actual)', { dComb: delta(m1, m2, 'expenses.combinedMonthly'), dDash: delta(m1, m2, 'dashboard.totalMonthlyExpenses') });
  const rep = log('re-apply', await call(email, 'POST', '/api/expenses/planned-from-actuals', { json: { action: 'apply', decisions: d2 } }));
  const plannedAfterRep = await rowsFor('expense_items', userId, 'id');
  expect(rep.status === 409 && rep.json?.code === 'ALREADY_APPLIED' && plannedAfterRep.length === plannedAfter.length, 'WP-15a: re-apply -> ALREADY_APPLIED, 0 new rows', { status: rep.status, code: rep.json?.code });

  // (b) bank balance -> cash asset
  const bb = log('bank-balances preview', await call(email, 'GET', '/api/assets/bank-balances'));
  evidence.bankBalances = bb.json;
  const item = ((bb.json?.data?.items ?? []) as any[]).find((i) => Number(i.closingBalance ?? i.balance) === bank.closing) ?? (bb.json?.data?.items ?? [])[0];
  const accountId = item?.accountId as string;
  const mB0 = await measure(email);
  evidence.mB0 = mB0;
  const p1 = log('generate balance #1', await call(email, 'POST', '/api/assets/bank-balances', { json: { action: 'generate', accountId } }));
  const p2 = log('generate balance #2', await call(email, 'POST', '/api/assets/bank-balances', { json: { action: 'generate', accountId } }));
  const pid1 = p1.json?.data?.item?.proposalId as string; const pid2 = p2.json?.data?.item?.proposalId as string;
  evidence.balanceProposals = { p1: p1.json, p2: p2.json };
  const assets0 = await rowsFor('assets', userId, 'id');
  const sup = log('apply superseded #1', await call(email, 'POST', '/api/assets/bank-balances', { json: { action: 'apply', proposalId: pid1, decision: 'add_new' } }));
  const assets0b = await rowsFor('assets', userId, 'id');
  expect(pid1 !== pid2 ? (sup.status >= 400 && assets0b.length === assets0.length) : true, 'WP-15b: a superseded (regenerated) balance proposal is refused, nothing written', { same: pid1 === pid2, status: sup.status, code: sup.json?.code });
  const xtb = log('cross-tenant balance apply', await call(attacker, 'POST', '/api/assets/bank-balances', { json: { action: 'apply', proposalId: pid2, decision: 'add_new' } }));
  const attackerAssets = await rowsFor('assets', attackerId, 'id,source_type', (q) => q.eq('source_type', 'bank_statement'));
  expect(xtb.status >= 400 && attackerAssets.length === 0 && (await rowsFor('assets', userId, 'id')).length === assets0.length, 'WP-15b: cross-tenant balance Apply refused, nothing written', { status: xtb.status, code: xtb.json?.code });
  const concB = await fireConcurrently(2, () => call(email, 'POST', '/api/assets/bank-balances', { json: { action: 'apply', proposalId: pid2, decision: 'add_new' } }));
  evidence.concurrentBalanceApply = concB;
  const assets1 = await rowsFor('assets', userId, 'id,asset_name,current_value,source_type,source_financial_account_id');
  const newAssets = assets1.filter((a: any) => !assets0.some((b: any) => b.id === a.id));
  expect(concB.overlapped, 'WP-15b: the two balance Apply calls overlapped in time', concB.results.map((r) => [Math.round(r.startedAt), Math.round(r.endedAt)]));
  expect(concB.results.filter((r) => r.status === 200).length === 1 && newAssets.length === 1 && Number(newAssets[0]?.current_value) === bank.closing, `WP-15b: exactly ONE cash asset created, value = statement closing ${bank.closing}`, { statuses: concB.results.map((r) => ({ s: r.status, code: r.json?.code })), newAssets });
  const mB1 = await measure(email);
  evidence.mB1 = mB1;
  expect(delta(mB0, mB1, 'dashboard.netWorth') === bank.closing, `WP-15b: Net Worth +${bank.closing} once (the evidence bucket is never added)`, { dNW: delta(mB0, mB1, 'dashboard.netWorth'), evidenceBefore: (mB0.dashboard as any).bankBalanceEvidence, evidenceAfter: (mB1.dashboard as any).bankBalanceEvidence });
  const repB = log('re-apply balance', await call(email, 'POST', '/api/assets/bank-balances', { json: { action: 'apply', proposalId: pid2, decision: 'add_new' } }));
  const p3 = log('generate balance #3 (after apply)', await call(email, 'POST', '/api/assets/bank-balances', { json: { action: 'generate', accountId } }));
  evidence.afterApplyGenerate = p3.json;
  const assets2 = await rowsFor('assets', userId, 'id');
  expect(repB.status === 409 && assets2.length === assets1.length, 'WP-15b: re-apply -> 409, 0 new assets', { status: repB.status, code: repB.json?.code });
  saveEvidence(`scenario_wp15_${salt}`, { evidence, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); saveEvidence(`scenario_wp15_${salt}_error`, { evidence, results, error: String(e?.stack ?? e) }); process.exitCode = 1; });
