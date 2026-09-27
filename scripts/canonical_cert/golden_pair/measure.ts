/**
 * Golden pair: read EVERY listed consumer through the real LOCALHOST routes, as the signed-in user, and
 * save the raw responses. Nothing here touches the database directly.
 *
 *   npx tsx scripts/canonical_cert/golden_pair/measure.ts --email <e> --port 3971 --label M [--heavy] [--report]
 *
 * --heavy adds the POST consumers that persist a run (Twin generate, forecast runs); --report generates the
 * monthly report and reads its sections (the report route is idempotent per month, so only once per phase).
 * Output: .canonical-cert/gp/measure-<label>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { api } from '../lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const port = Number(arg('--port'));
const label = arg('--label')!;
if (!email || !port || !label) throw new Error('usage: measure.ts --email e --port p --label L [--heavy] [--report]');

const GETS = [
  '/api/income', '/api/income/actuals',
  '/api/expenses', '/api/expenses/actuals',
  '/api/assets', '/api/assets/bank-balances',
  '/api/liabilities',
  '/api/investments', '/api/investments/imported-statements',
  '/api/retirement',
  '/api/dashboard/summary',
  '/api/health-score',
  '/api/intelligence/financial-dna',
  '/api/resilience',
];
const FORECASTS = ['net_worth', 'resilience', 'retirement', 'debt', 'investment', 'cross_border'];

type Out = Record<string, { status: number; ms: number; json: unknown; text?: string }>;

async function call(out: Out, key: string, method: string, route: string, json?: unknown) {
  const t0 = Date.now();
  const r = await api(email, method, route, { port, json });
  out[key] = { status: r.status, ms: Date.now() - t0, json: r.json, ...(r.json ? {} : { text: r.text.slice(0, 500) }) };
  console.log(`${String(r.status).padEnd(4)} ${String(Date.now() - t0).padStart(6)}ms ${method} ${route}${json ? ' ' + JSON.stringify(json) : ''}`);
  return r;
}

async function main() {
  const out: Out = {};
  for (const g of GETS) await call(out, `GET ${g}`, 'GET', g);
  if (args.includes('--heavy')) {
    await call(out, 'POST /api/financial-twin/generate', 'POST', '/api/financial-twin/generate');
    for (const f of FORECASTS) {
      const r = await call(out, `POST /api/forecast/run ${f}`, 'POST', '/api/forecast/run', { forecast_type: f });
      const runId = (r.json as { data?: { run?: { id?: string } } } | null)?.data?.run?.id;
      // The run's projected results (the forecast outputs themselves, not just the run header).
      if (runId) await call(out, `GET /api/forecast/runs/[id] ${f}`, 'GET', `/api/forecast/runs/${runId}`);
    }
  }
  if (args.includes('--report')) {
    const g = await call(out, 'POST /api/reports/generate', 'POST', '/api/reports/generate', {});
    const data = (g.json as { data?: Record<string, unknown> } | null)?.data ?? {};
    const id = (data.reportId ?? data.report_id ?? data.id ?? (data.report as Record<string, unknown> | undefined)?.id) as string | undefined;
    if (id) {
      await call(out, 'GET /api/reports/[id]', 'GET', `/api/reports/${id}`);
      await call(out, 'GET /api/reports/[id]/sections', 'GET', `/api/reports/${id}/sections`);
    } else console.log(`report id not found in ${JSON.stringify(data).slice(0, 300)}`);
  }
  const file = path.resolve('.canonical-cert', 'gp', `measure-${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ label, takenAt: new Date().toISOString(), email, out }, null, 1));
  console.log(`wrote ${file}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
