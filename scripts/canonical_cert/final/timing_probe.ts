/**
 * One-off timing probe for the B1 deploy-blocker recheck (feature/canonical-cert-final-timing-and-r20-scope).
 * Times GET /api/dashboard/summary and GET /api/financial-data-hub/expenses/actuals against DEV on
 * localhost, and reads the Supabase round-trip counter written by count_supabase_requests.cjs (which
 * must be preloaded via NODE_OPTIONS=--require on the dev server process).
 *
 *   npx tsx scripts/canonical_cert/final/timing_probe.ts --email <e> --port 3974
 */
import fs from 'node:fs';
import path from 'node:path';
import { api } from '../lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const port = Number(arg('--port'));
if (!email || !port) throw new Error('usage: timing_probe.ts --email e --port p');

function sbCounters(): Record<string, { requests: number; waitMs: number; maxInFlight: number }> {
  const dir = path.resolve('.canonical-cert');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^sb-requests-\d+\.json$/.test(f)) : [];
  const out: Record<string, { requests: number; waitMs: number; maxInFlight: number }> = {};
  for (const f of files) {
    try { out[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* ignore */ }
  }
  return out;
}

function sumCounters(c: Record<string, { requests: number; waitMs: number; maxInFlight: number }>) {
  return Object.values(c).reduce((a, b) => ({ requests: a.requests + b.requests, waitMs: a.waitMs + b.waitMs, maxInFlight: Math.max(a.maxInFlight, b.maxInFlight) }), { requests: 0, waitMs: 0, maxInFlight: 0 });
}

async function timedGet(route: string, label: string) {
  const before = sumCounters(sbCounters());
  const t0 = Date.now();
  const r = await api(email, 'GET', route, { port });
  const ms = Date.now() - t0;
  // give the 50ms debounce flush in count_supabase_requests.cjs time to land
  await new Promise((res) => setTimeout(res, 250));
  const after = sumCounters(sbCounters());
  const delta = { requests: after.requests - before.requests, waitMs: after.waitMs - before.waitMs, maxInFlight: after.maxInFlight };
  console.log(`${label}: status=${r.status} wall=${ms}ms supabaseRequests=${delta.requests} supabaseWaitMs=${delta.waitMs} maxInFlight=${delta.maxInFlight}`);
  return { label, route, status: r.status, ms, delta, bodyPreview: r.text.slice(0, 300) };
}

async function main() {
  const results = [];
  // Run twice each: cold (first hit after sign-in / any route-level cache) and warm.
  results.push(await timedGet('/api/dashboard/summary', 'dashboard/summary run1'));
  results.push(await timedGet('/api/expenses/actuals', 'expenses/actuals run1'));
  results.push(await timedGet('/api/dashboard/summary', 'dashboard/summary run2'));
  results.push(await timedGet('/api/expenses/actuals', 'expenses/actuals run2'));
  results.push(await timedGet('/api/dashboard/summary', 'dashboard/summary run3'));
  const out = { takenAt: new Date().toISOString(), email, port, results };
  const file = path.resolve('.canonical-cert', 'final', 'timing-probe.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exitCode = 1; });
