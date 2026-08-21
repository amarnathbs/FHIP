// Focused reproduction: does an unbounded PostgREST select silently truncate
// a large ii_prices_nav history, and does that make the R5 SIP repository
// lose NAV for later instruments?
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
let env = null;
for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
  if (fs.existsSync(p)) {
    env = {};
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    break;
  }
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };

async function sb(p, opts = {}) {
  const res = await fetch(`${URL_}${p}`, { headers: { ...H, ...(opts.prefer ? { Prefer: opts.prefer } : {}) }, method: opts.method ?? 'GET', body: opts.body ? JSON.stringify(opts.body) : undefined });
  const t = await res.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* */ }
  return { status: res.status, json: j, text: t, headers: res.headers };
}

const stamp = Date.now();
const inst = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `PAGINATION PROBE ${stamp}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR' } });
const id = inst.json?.[0]?.id;
if (!id) { console.log('instrument seed failed', inst.text); process.exit(2); }

// Seed 1500 NAV rows.
const rows = [];
let d = new Date(Date.UTC(2019, 0, 1));
for (let i = 0; i < 1500; i++) {
  rows.push({ instrument_id: id, price_date: d.toISOString().slice(0, 10), price: 100 + i * 0.01, currency_code: 'INR', quality_status: 'ok' });
  d.setUTCDate(d.getUTCDate() + 1);
}
for (let i = 0; i < rows.length; i += 500) {
  const r = await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: rows.slice(i, i + 500) });
  if (r.status >= 300) { console.log('nav seed failed', r.text.slice(0, 200)); }
}

const unbounded = await sb(`/rest/v1/ii_prices_nav?instrument_id=eq.${id}&select=price_date&order=price_date.asc`, { prefer: 'count=exact' });
console.log(`\nSeeded 1500 NAV rows for one instrument.`);
console.log(`Unbounded select returned: ${Array.isArray(unbounded.json) ? unbounded.json.length : 'err'} rows`);
console.log(`Content-Range: ${unbounded.headers.get('content-range')}`);
console.log(`Latest price_date seen by an unbounded query: ${Array.isArray(unbounded.json) ? unbounded.json[unbounded.json.length - 1]?.price_date : 'n/a'}`);
console.log(`TRUE latest price_date seeded:                 ${rows[rows.length - 1].price_date}`);
const truncated = Array.isArray(unbounded.json) && unbounded.json.length < 1500;
console.log(`\n==> SILENT TRUNCATION: ${truncated ? 'YES — this is the bug' : 'NO'}`);

// Cleanup
await sb(`/rest/v1/ii_prices_nav?instrument_id=eq.${id}`, { method: 'DELETE' });
await sb(`/rest/v1/ii_instruments?id=eq.${id}`, { method: 'DELETE' });
console.log('cleanup done');
