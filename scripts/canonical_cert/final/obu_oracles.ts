/* eslint-disable @typescript-eslint/no-explicit-any -- certification script: untyped JSON route responses */
/**
 * Owner-before-upload DEV certification, step 31: financial isolation oracles, measured through the app's own read surfaces.
 *   CERT_PORT=3991 npx tsx scripts/canonical_cert/final/obu_oracles.ts
 * O1 SMSF bank expense 1,000: personal Expenses unchanged (control: the same statement as Self adds 1,000).
 * O2 Company held 1,000,000, user owns 50%: Net Worth moves by 500,000 (100% would be 1,000,000); the personal investments total does not move.
 * O3 Bank entity attempt is refused; personal Income / Expenses / Net Worth unchanged.
 * Actors: AU3 = forecast.tc015 (ledger OBU3), IN1 = forecast.tc083 (ledger OBU). DEV only, existing fixture users only.
 */
import { call, measure, delta, expect, results } from '../econ/lib';
import { importAndApproveBank } from '../econ/flows';
import fs from 'node:fs';
import { hostGuard } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const AU3 = 'forecast.tc015@example.test';
const IN1 = 'forecast.tc083@example.test';

async function main() {
  // ---------- O1: SMSF-owned bank expense ----------
  const m0 = await measure(AU3);
  const smsf = await importAndApproveBank(AU3, [{ date: '2026-08-05', description: 'FHIP OBU SMSF ADMIN FEE', amount: -1000, category: 'shopping' }], { masked: 'xxxx3101', filename: 'obu-oracle-smsf.csv', ownerRole: 'smsf' });
  expect(smsf.approve?.status === 200, 'O1: the SMSF-owned bank statement is imported and approved', smsf.approve);
  const m1 = await measure(AU3);
  expect(delta(m0, m1, 'expenses.actualTotalInWindow') === 0 && delta(m0, m1, 'dashboard.totalMonthlyExpenses') === 0, 'O1 ORACLE: SMSF expense 1,000 leaves personal Expenses unchanged (window total and Dashboard monthly expenses both +0)', { dWindow: delta(m0, m1, 'expenses.actualTotalInWindow'), dDash: delta(m0, m1, 'dashboard.totalMonthlyExpenses') });
  const self = await importAndApproveBank(AU3, [{ date: '2026-08-06', description: 'FHIP OBU SELF FEE', amount: -1000, category: 'shopping' }], { masked: 'xxxx3102', filename: 'obu-oracle-self.csv', ownerRole: 'self' });
  expect(self.approve?.status === 200, 'O1 control: the same 1,000 expense on a SELF statement is imported and approved', self.approve);
  const m2 = await measure(AU3);
  expect(delta(m1, m2, 'expenses.actualTotalInWindow') === 1000, 'O1 CONTROL: as Self the same 1,000 DOES count in personal Expenses (+1,000), so the +0 above is the owner rule, not a dead flow', { dWindow: delta(m1, m2, 'expenses.actualTotalInWindow') });
  console.log('INFO  O1: SMSF CASH-FLOW INTEGRATION is NOT built: an SMSF-owned bank statement is excluded from personal Expenses but does not feed the SMSF cash-flow view (deferred downstream capability, PO ruling; reported as a gap, not passed)');
  results.push({ ok: true, label: 'O1 gap record: SMSF bank-transaction -> SMSF cash-flow integration not built (deferred, PARTIAL)', detail: 'owner attribution certified only' });

  // ---------- O3: bank entity attempt ----------
  const ents = (await call(AU3, 'GET', '/api/business-entities')).json?.data ?? [];
  let company = ents.find((e: any) => e.entity_type === 'company');
  if (!company) {
    const mk = await call(AU3, 'POST', '/api/business-entities', { json: { name: 'FHIP OBU Oracle Company', entity_type: 'company', ownership_percentage: 100, valuation_mode: 'summary', summary_net_asset_value: 0, currency_code: 'AUD' }, owner: null });
    company = mk.json?.data;
  }
  const m3 = await measure(AU3);
  const csvBytes = Buffer.from(['Date,Description,Debit Amount,Credit Amount,Balance', '07/08/2026,FHIP OBU ENTITY SPEND,500.00,,1000.00', ''].join('\n'));
  const ent = await call(AU3, 'POST', '/api/financial-data-hub/bank-csv/upload?country_code=AU&currency_code=AUD&masked_identifier=xxxx3103', { body: csvBytes, contentType: 'text/csv', owner: { kind: 'entity', entityId: company.id } });
  const m4 = await measure(AU3);
  expect(ent.status >= 400 && ent.status < 500, 'O3: a Company-owned bank statement is refused before any processing', { status: ent.status, error: ent.json?.error });
  expect(delta(m3, m4, 'expenses.actualTotalInWindow') === 0 && delta(m3, m4, 'income.countedMonthly') === 0 && delta(m3, m4, 'dashboard.netWorth') === 0, 'O3 ORACLE: personal Expenses, Income and Net Worth are unchanged by the refused entity bank attempt', { dExp: delta(m3, m4, 'expenses.actualTotalInWindow'), dInc: delta(m3, m4, 'income.countedMonthly'), dNW: delta(m3, m4, 'dashboard.netWorth') });

  // ---------- O2: company 1,000,000 at 50% ----------
  const ents1 = (await call(IN1, 'GET', '/api/business-entities')).json?.data ?? [];
  const co = ents1.find((e: any) => e.entity_type === 'company' && /FHIP OBU Company/.test(e.name));
  if (!co) throw new Error('IN1 has no synthetic company (run obu_cas_journeys.mjs step 15 first)');
  const baseNAV = await call(IN1, 'PATCH', `/api/business-entities/${co.id}`, { json: { ownership_percentage: 50, summary_net_asset_value: 0 }, owner: null });
  const n0 = await measure(IN1);
  const inv0 = (n0.dashboard as any).totalInvestments;
  const set = await call(IN1, 'PATCH', `/api/business-entities/${co.id}`, { json: { summary_net_asset_value: 1_000_000, ownership_percentage: 50 }, owner: null });
  const n1 = await measure(IN1);
  expect(baseNAV.status < 300 && set.status < 300, 'O2: the synthetic Company is set to a 1,000,000 value at 50% ownership through the real route', { base: baseNAV.status, set: set.status });
  expect(delta(n0, n1, 'dashboard.netWorth') === 500_000, 'O2 ORACLE: the macro (Net Worth) contribution is 500,000 (50% of 1,000,000)', { dNetWorth: delta(n0, n1, 'dashboard.netWorth') });
  expect(delta(n0, n1, 'dashboard.totalInvestments') === 0 && (n1.dashboard as any).totalInvestments === inv0, 'O2 ORACLE: the personal Investments total does NOT add the 1,000,000', { dInvestments: delta(n0, n1, 'dashboard.totalInvestments') });
  const full = await call(IN1, 'PATCH', `/api/business-entities/${co.id}`, { json: { ownership_percentage: 100 }, owner: null });
  const n2 = await measure(IN1);
  expect(full.status < 300 && delta(n1, n2, 'dashboard.netWorth') === 500_000, 'O2 CONTROL: at 100% ownership the same company contributes 1,000,000 (+500,000 more), so the 500,000 above is the ownership rule', { dNetWorth: delta(n1, n2, 'dashboard.netWorth') });
  await call(IN1, 'PATCH', `/api/business-entities/${co.id}`, { json: { ownership_percentage: 50, summary_net_asset_value: 0 }, owner: null });
}

main().then(() => {
  fs.writeFileSync('.canonical-cert/obu-oracles-results.json', JSON.stringify(results, null, 2));
  const bad = results.filter((r: any) => r.ok === false);
  console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
  process.exit(bad.length ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
