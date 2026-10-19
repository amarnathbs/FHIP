// Counts the Supabase round trips one app request makes (server started with --count-requests), and the local round-trip time, so a localhost wall time can be
// turned into an estimate: sequential trips x round-trip time + compute. DEV only. Usage: node scripts/nav2_rc/count_post.mjs <userKey> [GET|POST] [route] [bodyJson]
import fs from 'node:fs';
import path from 'node:path';
import { api, USERS, logoutAll } from '../nav2_stage3/_lib.mjs';
import { loadDevEnv } from '../canonical_cert/lib/env.mjs';

const dir = path.resolve(process.cwd(), '.canonical-cert');
const sum = () => {
  let requests = 0, waitMs = 0, maxInFlight = 0;
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^sb-requests-\d+\.json$/.test(f)) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); requests += j.requests; waitMs += j.waitMs; maxInFlight = Math.max(maxInFlight, j.maxInFlight); } catch { /* being written */ } }
  return { requests, waitMs, maxInFlight };
};
const [userKey = 'holder', method = 'POST', route = '/api/reports/fund-analytics', body = '{"period":"since_first_held"}'] = process.argv.slice(2);
const d = loadDevEnv();
const rtts = [];
for (let i = 0; i < 5; i++) { const t0 = Date.now(); const r = await fetch(`${d.url}/rest/v1/ii_reference_job_control?select=job_key&limit=1`, { headers: { apikey: d.serviceKey, Authorization: `Bearer ${d.serviceKey}` } }); await r.text(); rtts.push(Date.now() - t0); }
rtts.sort((a, b) => a - b);
console.log(`local round trip to DEV (median of 5): ${rtts[2]} ms`);
await api(USERS[userKey], 'GET', '/api/reports/fund-analytics'); // sign in and warm
await new Promise((r) => setTimeout(r, 400));
const before = sum();
const t0 = Date.now();
const res = await api(USERS[userKey], method, route, method === 'POST' ? { json: JSON.parse(body) } : {});
const wall = Date.now() - t0;
await new Promise((r) => setTimeout(r, 400));
const after = sum();
const n = after.requests - before.requests;
console.log(`${method} ${route} -> ${res.status} in ${wall} ms; Supabase round trips: ${n}; time waiting on them (sum): ${after.waitMs - before.waitMs} ms; max in flight ${after.maxInFlight}`);
console.log(`model: ${n} trips x production round trip (assume 15 ms) = ${n * 15} ms + compute ${Math.max(0, wall - (after.waitMs - before.waitMs))} ms`);
console.log(res.text.slice(0, 200));
await logoutAll();
