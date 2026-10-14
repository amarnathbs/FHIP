// DEV: one real POST of the fund analytics route for the choice of 20, with the Supabase request trace (server started with SB_TRACE=1 --count-requests), then the
// sequential depth: how many requests ran one after another, which tables, and where the wall time went. No data, only table paths and times.
//   node scripts/nav2_rc/trace_post.mjs [nFunds=20] [warmups=1]
import fs from 'node:fs';
import path from 'node:path';
import { api, logoutAll, USERS } from '../nav2_stage3/_lib.mjs';
import { FUND } from '../nav2_stage3/_flow.mjs';

const n = Number(process.argv[2] ?? 20);
const warm = Number(process.argv[3] ?? 1);
const rh = JSON.parse(fs.readFileSync('test-artifacts/nav2_rc/rh_funds.json', 'utf8')).map((x) => x.instrumentId);
const funds = [FUND.A, FUND.B, FUND.D, FUND.E, ...rh].slice(0, n);
const dir = path.resolve('.canonical-cert');
const lines = () => { const out = []; if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^sb-trace-\d+\.log$/.test(f)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) { const [s, e, m, p] = l.split(','); out.push({ s: Number(s), e: Number(e), m, p }); } return out.sort((a, b) => a.s - b.s); };
try {
  for (let i = 0; i < warm; i++) { const w = await api(USERS.admin, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held', funds }, headers: { 'Idempotency-Key': `trace-warm-${i}-${Date.now()}-abcdef` } }); console.log('warm', w.status); }
  const before = lines().length;
  const t0 = Date.now();
  const r = await api(USERS.admin, 'POST', '/api/reports/fund-analytics', { json: { period: 'since_first_held', funds }, headers: { 'Idempotency-Key': `trace-run-${Date.now()}-abcdef0` } });
  const wall = Date.now() - t0;
  await new Promise((res) => setTimeout(res, 800));
  const L = lines().slice(before);
  console.log(`status ${r.status}, wall ${wall} ms, supabase requests ${L.length}`);
  // sequential depth: greedy "waves" (a request that starts after the previous wave's latest end belongs to a new wave)
  let waves = 0, waveEnd = -1;
  for (const x of L) { if (x.s >= waveEnd) { waves++; waveEnd = x.e; } else waveEnd = Math.max(waveEnd, x.e); }
  console.log(`sequential waves (depth): ${waves}`);
  const by = {};
  for (const x of L) { const k = `${x.m} ${x.p.replace('/rest/v1/', '')}`; by[k] = by[k] ?? { n: 0, ms: 0 }; by[k].n++; by[k].ms += x.e - x.s; }
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1].ms - a[1].ms).slice(0, 14)) console.log(`  ${String(v.n).padStart(4)} x ${k.padEnd(52)} total ${v.ms} ms`);
  const t1 = L.length ? L[0].s : 0;
  fs.writeFileSync('test-artifacts/nav2_rc/trace_post.json', JSON.stringify(L.map((x) => ({ start: x.s - t1, ms: x.e - x.s, m: x.m, p: x.p })), null, 0));
} finally { await logoutAll(); }
