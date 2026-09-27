/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * UNKNOWN is never silently categorised or counted (live): a bank line nothing recognises stays 'unknown'
 * after the app's own auto-categorise, every approval path refuses it, and it counts 0 while waiting.
 *
 *   npx tsx scripts/canonical_cert/econ/scenario_unknown.ts --email E
 */
import { call, measure, delta, expect, results, saveEvidence } from './lib';
import { importAndApproveBank } from './flows';

const email = process.argv[process.argv.indexOf('--email') + 1];

async function main() {
  const m0 = await measure(email);
  const bank = await importAndApproveBank(email, [
    { date: '2026-08-12', description: 'QX7 ZZPAY 88213 REF 0041', amount: -77.7, category: null },
    { date: '2026-08-13', description: 'FHIP TEST MYSTERY CREDIT 5521', amount: 123.45, category: null },
  ], { masked: 'xxxx7199', filename: 'fhip-test-bank-unknown-B.csv', approve: false });
  const t = bank.txns as any[];
  expect(t.length === 2 && t.every((x) => x.economic_transaction_type === 'unknown' && x.category_id === null && x.approval_status === 'pending'),
    'unknown: after the app\'s auto-categorise both lines are still unknown / uncategorised / pending (never guessed)', t.map((x) => [x.description_raw, x.economic_transaction_type, x.classification_method]));
  const all = await call(email, 'POST', `/api/financial-data-hub/documents/${bank.documentId}/category-review/approve-all`);
  const stmt = await call(email, 'POST', `/api/financial-data-hub/documents/${bank.documentId}/approve`);
  const one = await call(email, 'POST', `/api/financial-data-hub/bank-transactions/${t[0].id}/approve`);
  const bulk = await call(email, 'POST', '/api/financial-data-hub/bank-transactions/bulk-approve', { json: { transaction_ids: t.map((x) => x.id) } });
  const { select } = await import('./lib');
  const after = await select('fdh_transactions', (q) => q.select('id,approval_status,economic_transaction_type').in('id', t.map((x) => x.id)));
  expect(all.status === 409 && stmt.status === 409 && one.status === 409 && after.every((x: any) => x.approval_status === 'pending'),
    'unknown: approve-all, statement approve and single approve all refuse (409); nothing approved', { approveAll: all.status, statement: stmt.status, single: one.status });
  expect(bulk.status === 200 && bulk.json?.data?.succeeded === 0 && bulk.json?.data?.failed === 2, 'unknown: bulk-approve approves none of them', { status: bulk.status, body: JSON.stringify(bulk.json).slice(0, 300) });
  const m1 = await measure(email);
  expect(delta(m0, m1, 'expenses.actualTotalInWindow') === 0 && delta(m0, m1, 'income.countedMonthly') === 0 && delta(m0, m1, 'expenses.unknownPendingCount') === 2,
    'unknown: effect 0 on spending and income; shown as 2 lines waiting', { dSpend: delta(m0, m1, 'expenses.actualTotalInWindow'), dInc: delta(m0, m1, 'income.countedMonthly'), dPending: delta(m0, m1, 'expenses.unknownPendingCount') });
  saveEvidence('scenario_unknown_B', { bank: { documentId: bank.documentId, txns: t }, responses: { all: all.json, stmt: stmt.json, one: one.json, bulk: bulk.json }, m0, m1, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
