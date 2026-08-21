// Investment Intelligence R5 — browser-QA fixture.
//
// Seeds a throwaway DEV user with data designed to exercise the exact UI
// states R5 must render honestly, and PRINTS THE CREDENTIALS so a real
// browser session can log in and the rendered output can be read directly
// (rather than inferred from React source, which is explicitly not
// acceptable evidence).
//
// Scenarios seeded:
//   1. Healthy monthly SIP with a mapped benchmark   -> full figures render
//   2. SIP on a scheme with NO benchmark mapping     -> benchmark must show
//                                                       "Not available", not 0.00%
//   3. SIP with a long gap                           -> gap/pause state
//   4. Every scheme lacks fund-holdings disclosure   -> X-Ray must render the
//                                                       0%-coverage unavailable
//                                                       state and NO charts
//
// Teardown: node scripts/ii_r5_browser_qa_fixture.mjs --teardown <userId>
//
// Run: node scripts/ii_r5_browser_qa_fixture.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
function loadEnv() {
  for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
    if (fs.existsSync(p)) {
      const env = {};
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
      return env;
    }
  }
  throw new Error('No .env.local found');
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { ok: res.ok, status: res.status, json, text };
}

function addMonths(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  const tm = d.getUTCMonth() + n;
  const y = d.getUTCFullYear() + Math.floor(tm / 12);
  const m = ((tm % 12) + 12) % 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), dim))).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
if (process.argv[2] === '--teardown') {
  const userId = process.argv[3];
  if (!userId) { console.log('usage: --teardown <userId>'); process.exit(1); }
  const insts = await sb(`/rest/v1/ii_instruments?instrument_name=like.R5 QA*&select=id`);
  for (const i of insts.json ?? []) {
    await sb(`/rest/v1/ii_instrument_benchmarks?instrument_id=eq.${i.id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_prices_nav?instrument_id=eq.${i.id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_instruments?id=eq.${i.id}`, { method: 'DELETE' });
  }
  const bms = await sb(`/rest/v1/ii_benchmarks?benchmark_key=like.R5_QA_%&select=id`);
  for (const b of bms.json ?? []) {
    await sb(`/rest/v1/ii_benchmark_series?benchmark_id=eq.${b.id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_benchmarks?id=eq.${b.id}`, { method: 'DELETE' });
  }
  await sb(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
  console.log('teardown complete');
  process.exit(0);
}

const stamp = Date.now();
const email = `ii-r5-qa-${stamp}@fhip-test.local`;
const password = 'TestPass!' + stamp;
const asOf = '2024-06-28';

const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
const userId = created.json?.id;
if (!userId) { console.log('user create failed', created.text); process.exit(2); }

let schemeSeq = 0;
async function seed({ name, startNav, drift, sipStart, sipCount, sipAmount, withBenchmark, benchmarkDrift = 0.09, gapAt = null }) {
  schemeSeq += 1;
  const inst = await sb('/rest/v1/ii_instruments', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_name: `R5 QA ${name} ${stamp}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' },
  });
  const instrumentId = inst.json[0].id;
  const acct = await sb('/rest/v1/ii_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, account_type: 'mf_folio', institution_name: 'R5 QA AMC', folio_number: `QA-${stamp}-${schemeSeq}`, country_code: 'IN', currency_code: 'INR', status: 'active' },
  });
  const accountId = acct.json[0].id;

  const navStart = addMonths(sipStart, -1);
  const navRows = [];
  let v = startNav;
  const daily = Math.pow(1 + drift, 1 / 365) - 1;
  for (let d = navStart; d <= asOf; d = addDays(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) navRows.push({ instrument_id: instrumentId, price_date: d, price: Math.round(v * 1e6) / 1e6, currency_code: 'INR', quality_status: 'ok' });
    v *= 1 + daily;
  }
  for (let i = 0; i < navRows.length; i += 500) await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: navRows.slice(i, i + 500) });
  const navMap = new Map(navRows.map((r) => [r.price_date, r.price]));
  const navOnOrAfter = (d) => { for (let k = 0; k <= 10; k++) { const key = addDays(d, k); if (navMap.has(key)) return navMap.get(key); } return null; };
  const navAsOfFn = (d) => { for (let k = 0; k <= 10; k++) { const key = addDays(d, -k); if (navMap.has(key)) return navMap.get(key); } return null; };

  const txns = [];
  for (let k = 0; k < sipCount; k++) {
    if (gapAt !== null && k >= gapAt && k < gapAt + 4) continue;
    const date = addMonths(sipStart, k);
    const nav = navOnOrAfter(date);
    txns.push({ user_id: userId, account_id: accountId, instrument_id: instrumentId, currency_code: 'INR', transaction_type: 'sip', transaction_date: date, gross_amount: sipAmount, units: Math.round((sipAmount / nav) * 1e6) / 1e6, price_per_unit: nav, status: 'reconciled', source_reference: `SIP INSTALMENT ${k + 1}` });
  }
  await sb('/rest/v1/ii_transactions', { method: 'POST', body: txns });

  const units = txns.reduce((s, t) => s + t.units, 0);
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: userId, account_id: accountId, instrument_id: instrumentId, currency_code: 'INR', quality_status: 'certified', as_of_date: asOf, units: Math.round(units * 1e6) / 1e6, value: Math.round(units * navAsOfFn(asOf) * 100) / 100 } });

  if (withBenchmark) {
    const bm = await sb('/rest/v1/ii_benchmarks', { method: 'POST', prefer: 'return=representation', body: { benchmark_key: `R5_QA_NIFTY_${stamp}_${schemeSeq}`, benchmark_label: 'R5 QA Broad Market TRI', benchmark_category: 'index', country_code: 'IN', return_type: 'TRI' } });
    const benchmarkId = bm.json[0].id;
    const bmRows = [];
    let bv = 15000;
    const bd = Math.pow(1 + benchmarkDrift, 1 / 365) - 1;
    for (let d = navStart; d <= asOf; d = addDays(d, 1)) {
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      if (dow !== 0 && dow !== 6) bmRows.push({ benchmark_id: benchmarkId, series_date: d, value: Math.round(bv * 1e6) / 1e6, currency_code: 'INR', quality_status: 'ok' });
      bv *= 1 + bd;
    }
    for (let i = 0; i < bmRows.length; i += 500) await sb('/rest/v1/ii_benchmark_series', { method: 'POST', body: bmRows.slice(i, i + 500) });
    await sb('/rest/v1/ii_instrument_benchmarks', { method: 'POST', body: { instrument_id: instrumentId, benchmark_id: benchmarkId, relationship_type: 'primary', effective_from: '1900-01-01', mapping_version: 'v1', quality_status: 'ok' } });
  }
  return instrumentId;
}

await seed({ name: 'Benchmarked Growth Fund', startNav: 100, drift: 0.14, sipStart: '2021-01-05', sipCount: 41, sipAmount: 5000, withBenchmark: true });
await seed({ name: 'Unbenchmarked Fund', startNav: 60, drift: 0.09, sipStart: '2021-06-08', sipCount: 36, sipAmount: 3000, withBenchmark: false });
await seed({ name: 'Paused SIP Fund', startNav: 200, drift: 0.06, sipStart: '2021-03-02', sipCount: 30, sipAmount: 7500, withBenchmark: true, gapAt: 12 });

console.log(JSON.stringify({ userId, email, password, asOf }, null, 2));
