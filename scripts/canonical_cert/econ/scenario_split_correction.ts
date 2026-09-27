/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * USER CORRECTIONS + SPLITS PROPAGATE (live): on an approved bank statement,
 *   - an approved line is locked (set-category / split refused until the statement is reopened);
 *   - reopen -> the statement's lines go back to pending (effect 0 while pending);
 *   - split Woolworths 300 into groceries 250 + shopping 50 -> food actual -50, shopping +50, total unchanged;
 *   - an unreconciled split (sum != parent) and an "unknown" split line are refused;
 *   - re-approve -> every figure (Expenses actuals, Dashboard, WP-15 averages) follows the split.
 *
 *   npx tsx scripts/canonical_cert/econ/scenario_split_correction.ts --email E --document D
 */
import { call, measure, delta, expect, results, saveEvidence } from './lib';
import { rowsFor, userIdOf, CATEGORY } from './flows';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const documentId = arg('--document')!;
const SUB_GROCERIES = '4551726d-31f8-4d5b-9b32-e265b8d199e5';

async function groups() {
  const r = await call(email, 'GET', '/api/expenses/actuals?pageSize=500');
  return Object.fromEntries(((r.json?.data?.groups ?? []) as any[]).map((g) => [g.group, g.actualMonthly]));
}

async function main() {
  const userId = await userIdOf(email);
  const txns = await rowsFor('fdh_transactions', userId, 'id,description_raw,amount_original,approval_status', (q) => q.eq('statement_upload_id', documentId));
  const woolies = txns.find((t: any) => t.description_raw.startsWith('WOOLWORTHS'));
  const m0 = await measure(email);
  const g0 = await groups();
  const lockedSplit = await call(email, 'POST', `/api/financial-data-hub/bank-transactions/${woolies.id}/split`, { json: { allocations: [{ economic_transaction_type: 'expense', category_id: CATEGORY.food, amount: 300 }], finalize: true } });
  expect(lockedSplit.status === 409, 'split: an APPROVED line cannot be split until its statement is reopened (409)', { s: lockedSplit.status, e: lockedSplit.json?.error });
  const reopen = await call(email, 'POST', `/api/financial-data-hub/documents/${documentId}/reopen`, { json: { reason: 'cert: split propagation' } });
  const m1 = await measure(email);
  expect(reopen.status === 200 && delta(m0, m1, 'expenses.actualTotalInWindow') === -845, 'reopen: all 4 lines back to pending -> their effect is 0 while pending (845 leaves the actuals)', { s: reopen.status, d: delta(m0, m1, 'expenses.actualTotalInWindow'), pending: (m1.expenses as any).unknownPendingCount });
  const unreconciled = await call(email, 'POST', `/api/financial-data-hub/bank-transactions/${woolies.id}/split`, { json: { allocations: [{ economic_transaction_type: 'expense', category_id: CATEGORY.food, subcategory_id: SUB_GROCERIES, amount: 250 }, { economic_transaction_type: 'expense', category_id: CATEGORY.shopping, amount: 40 }], finalize: true } });
  expect(unreconciled.status === 422, 'split: 250 + 40 != 300 refused (422)', { s: unreconciled.status, e: unreconciled.json?.error });
  const unknownPart = await call(email, 'POST', `/api/financial-data-hub/bank-transactions/${woolies.id}/split`, { json: { allocations: [{ economic_transaction_type: 'expense', category_id: CATEGORY.food, amount: 250 }, { economic_transaction_type: 'unknown', amount: 50 }], finalize: true } });
  expect(unknownPart.status === 422, 'split: an "unknown" split line is refused (UNKNOWN never silently counted)', { s: unknownPart.status, e: unknownPart.json?.error });
  const split = await call(email, 'POST', `/api/financial-data-hub/bank-transactions/${woolies.id}/split`, { json: { allocations: [{ economic_transaction_type: 'expense', category_id: CATEGORY.food, subcategory_id: SUB_GROCERIES, amount: 250 }, { economic_transaction_type: 'expense', category_id: CATEGORY.shopping, amount: 50 }], finalize: true } });
  expect(split.status === 200, 'split: 250 groceries + 50 shopping saved (finalized)', { s: split.status, j: split.json });
  const reapprove = await call(email, 'POST', `/api/financial-data-hub/documents/${documentId}/category-review/approve-all`);
  expect(reapprove.status === 200, 'split: statement re-approved', reapprove.json);
  const m2 = await measure(email);
  const g2 = await groups();
  expect(delta(m0, m2, 'expenses.actualTotalInWindow') === 0, 'split: total actual spending unchanged (845)', delta(m0, m2, 'expenses.actualTotalInWindow'));
  expect(Math.round((g2.food - g0.food) * 100) / 100 === -50 && Math.round(((g2.shopping ?? 0) - (g0.shopping ?? 0)) * 100) / 100 === 50, 'split PROPAGATES: food actual -50, shopping actual +50', { food: [g0.food, g2.food], shopping: [g0.shopping ?? null, g2.shopping ?? null] });
  const prev = await call(email, 'GET', '/api/expenses/planned-from-actuals');
  const gro = ((prev.json?.data?.items ?? []) as any[]).find((i) => i.masterItemKey === 'groceries');
  expect(Number(gro?.actualMonthly) === 750, 'split PROPAGATES into WP-15: groceries average 800 -> 750', gro);
  saveEvidence('scenario_split_correction_B', { m0, m1, m2, g0, g2, split: split.json, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
