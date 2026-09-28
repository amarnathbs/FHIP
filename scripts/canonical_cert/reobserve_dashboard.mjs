/**
 * SPD-14 / mission section 9 -- re-observe GET /api/dashboard/summary and GET /api/expenses/actuals for an
 * ALREADY-POPULATED synthetic user (no new upload), reading the Supabase round-trip counter written by
 * dev_server.mjs --count-requests. Used to get a clean before/after comparison for the SAME data under
 * different server code (restart the dev server with the code under test, then run this).
 *
 *   node scripts/canonical_cert/reobserve_dashboard.mjs --email <e> --port 3980 [--n 3]
 */
import fs from 'node:fs';
import path from 'node:path';
import { api } from './lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email');
const port = Number(arg('--port'));
const n = Number(arg('--n') ?? 3);
if (!email || !port) { console.error('usage: reobserve_dashboard.mjs --email <e> --port <p> [--n 3]'); process.exit(1); }

function sbCounter() {
  const dir = path.resolve('.canonical-cert');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^sb-requests-\d+\.json$/.test(f)) : [];
  if (files.length === 0) return null;
  return files.reduce((acc, f) => {
    try { const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { requests: acc.requests + s.requests, waitMs: acc.waitMs + s.waitMs }; } catch { return acc; }
  }, { requests: 0, waitMs: 0 });
}

async function call(step, method, route) {
  const before = sbCounter();
  const t = Date.now();
  const r = await api(email, method, route, { port });
  const ms = Date.now() - t;
  await new Promise((res) => setTimeout(res, 250));
  const after = sbCounter();
  const sbRequests = before && after ? after.requests - before.requests : null;
  const sbWaitMs = before && after ? after.waitMs - before.waitMs : null;
  console.log(`${step.padEnd(28)} HTTP ${r.status}  ${String(ms).padStart(6)} ms  sb=${sbRequests} (${sbWaitMs} ms waiting)`);
  return { ms, sbRequests, sbWaitMs, json: r.json };
}

async function main() {
  const results = [];
  for (let i = 0; i < n; i++) {
    const label = i === 0 ? 'cold' : `warm#${i}`;
    const dash = await call(`${label}: dashboard/summary`, 'GET', '/api/dashboard/summary');
    const d = dash.json?.data ?? {};
    results.push({ label, ms: dash.ms, sbRequests: dash.sbRequests, sbWaitMs: dash.sbWaitMs, bankMonthlyExpenses: d.bankMonthlyExpenses, bankMonthlyIncome: d.bankMonthlyIncome, totalMonthlyExpenses: d.totalMonthlyExpenses });
  }
  const act = await call('expenses/actuals', 'GET', '/api/expenses/actuals?page=1&pageSize=500');
  console.log(JSON.stringify({ results, actuals: { lineCount: act.json?.data?.lineCount, totals: act.json?.data?.totals } }, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
