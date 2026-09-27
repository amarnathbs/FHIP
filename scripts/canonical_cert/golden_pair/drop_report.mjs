/**
 * Golden pair SETUP between measurements (DEV, service role): delete a report THIS RUN generated, so the
 * next POST /api/reports/generate builds a fresh one (the route returns the month's existing report
 * unchanged). Refuses a report that existed at the ledger baseline.
 *   node scripts/canonical_cert/golden_pair/drop_report.mjs --ledger A-gp --id <reportId>
 */
import { ResidueLedger } from '../lib/residueLedger.mjs';
import { loadDevEnv } from '../lib/env.mjs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
  const L = ResidueLedger.open(arg('--ledger'));
  const [uid] = L.data.users;
  const id = arg('--id');
  if ((L.data.baseline[uid].tables.reports ?? []).includes(JSON.stringify([id]))) throw new Error('refusing: report existed at baseline');
  const { url, serviceKey } = loadDevEnv();
  const h = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=representation' };
  // report_generation_runs.report_id has no ON DELETE action (0010): remove this run's generation rows first.
  const runs = await (await fetch(`${url}/rest/v1/report_generation_runs?report_id=eq.${id}&user_id=eq.${uid}&select=id`, { headers: h })).json();
  const baseRuns = new Set(L.data.baseline[uid].tables.report_generation_runs ?? []);
  for (const run of runs) {
    if (baseRuns.has(JSON.stringify([run.id]))) throw new Error(`refusing: generation run ${run.id} existed at baseline`);
    const d = await fetch(`${url}/rest/v1/report_generation_runs?id=eq.${run.id}`, { method: 'DELETE', headers: h });
    console.log(`DELETE report_generation_runs ${run.id}: HTTP ${d.status}`);
  }
  const r = await fetch(`${url}/rest/v1/reports?id=eq.${id}&user_id=eq.${uid}`, { method: 'DELETE', headers: h });
  console.log(`DELETE reports ${id}: HTTP ${r.status} rows ${(await r.json()).length ?? '?'}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
