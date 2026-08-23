// R4 — durable UX verification fixture.
//
// Creates a throwaway DEV user with a seeded multi-currency portfolio so the
// Performance page can be rendered in a real browser, and prints the Supabase
// session object for programmatic injection into localStorage (so no password
// is ever typed into a login form).
//
//   node scripts/ii_r4_ux_fixture.mjs create   -> seeds, prints session JSON
//   node scripts/ii_r4_ux_fixture.mjs destroy  -> deletes everything it made
//
// State is kept in scripts/.ii_r4_ux_fixture.json (gitignored scratch).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const STATE_FILE = path.join(__dirname, '.ii_r4_ux_fixture.json');

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
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

async function req(p, { method = 'GET', apikey = SERVICE, token = SERVICE, body, prefer } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

const cmd = process.argv[2];

if (cmd === 'destroy') {
  if (!fs.existsSync(STATE_FILE)) { console.log('No fixture state; nothing to destroy.'); process.exit(0); }
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  for (const id of s.instrumentIds ?? []) {
    await req(`/rest/v1/ii_prices_nav?instrument_id=eq.${id}`, { method: 'DELETE' });
    await req(`/rest/v1/ii_instrument_benchmarks?instrument_id=eq.${id}`, { method: 'DELETE' });
    await req(`/rest/v1/ii_portfolio_truth_status?instrument_id=eq.${id}`, { method: 'DELETE' });
    await req(`/rest/v1/ii_transactions?instrument_id=eq.${id}`, { method: 'DELETE' });
    await req(`/rest/v1/ii_holding_snapshots?instrument_id=eq.${id}`, { method: 'DELETE' });
    await req(`/rest/v1/ii_instruments?id=eq.${id}`, { method: 'DELETE' });
  }
  for (const id of s.benchmarkIds ?? []) {
    await req(`/rest/v1/ii_benchmark_series?benchmark_id=eq.${id}`, { method: 'DELETE' });
    await req(`/rest/v1/ii_benchmarks?id=eq.${id}`, { method: 'DELETE' });
  }
  if (s.accountId) await req(`/rest/v1/ii_accounts?id=eq.${s.accountId}`, { method: 'DELETE' });
  if (s.userId) {
    await req(`/rest/v1/ii_analytics_results?user_id=eq.${s.userId}`, { method: 'DELETE' });
    await req(`/auth/v1/admin/users/${s.userId}`, { method: 'DELETE' });
  }
  fs.unlinkSync(STATE_FILE);
  console.log('Fixture destroyed.');
  process.exit(0);
}

// ---- create ---------------------------------------------------------------
const stamp = Date.now();
const email = `ii-r4-ux-${stamp}@fhip-test.local`;
const password = `TestPass!${stamp}`;

const user = await req('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
const userId = user.id;

const state = { userId, email, instrumentIds: [], benchmarkIds: [], accountId: null };

async function makeBenchmark(key, monthlyReturn) {
  const [b] = await req('/rest/v1/ii_benchmarks', {
    method: 'POST',
    prefer: 'return=representation',
    body: { benchmark_key: key, benchmark_label: key, benchmark_category: 'index', country_code: 'IN', return_type: 'TRI' },
  });
  state.benchmarkIds.push(b.id);
  const rows = [];
  let level = 100;
  for (let i = 0; i < 36; i++) {
    rows.push({ benchmark_id: b.id, series_date: new Date(Date.UTC(2021, i + 1, 0)).toISOString().slice(0, 10), value: level.toFixed(6), quality_status: 'ok' });
    level *= 1 + monthlyReturn;
  }
  await req('/rest/v1/ii_benchmark_series', { method: 'POST', body: rows });
  return b.id;
}

const bench = await makeBenchmark(`R4UX_${stamp}`, 0.007);

const [acct] = await req('/rest/v1/ii_accounts', {
  method: 'POST',
  prefer: 'return=representation',
  body: { user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: 'UX Test AMC', folio_number: `UX-${stamp}` },
});
state.accountId = acct.id;

async function seedFund({ name, currency, country, monthly, mapped, completeness, initial }) {
  const [inst] = await req('/rest/v1/ii_instruments', {
    method: 'POST',
    prefer: 'return=representation',
    body: { instrument_name: name, instrument_class: 'mutual_fund', country_of_domicile: country, base_currency: currency, status: 'verified' },
  });
  state.instrumentIds.push(inst.id);
  if (mapped) {
    await req('/rest/v1/ii_instrument_benchmarks', {
      method: 'POST',
      body: { instrument_id: inst.id, benchmark_id: bench, relationship_type: 'primary', effective_from: '1900-01-01', mapping_version: 'ux-v1', quality_status: 'ok' },
    });
  }
  const navs = [];
  const snaps = [];
  let nav = 100;
  for (let i = 0; i < 36; i++) {
    const date = new Date(Date.UTC(2021, i + 1, 0)).toISOString().slice(0, 10);
    navs.push({ instrument_id: inst.id, currency_code: currency, price_date: date, price: nav.toFixed(6), quality_status: 'ok' });
    snaps.push({
      user_id: userId, account_id: acct.id, instrument_id: inst.id, currency_code: currency,
      as_of_date: date, units: '1000.000000', value: (nav * 1000).toFixed(2), quality_status: 'certified',
    });
    nav *= i % 4 === 0 ? 0.985 : 1 + monthly;
  }
  await req('/rest/v1/ii_prices_nav', { method: 'POST', body: navs });
  await req('/rest/v1/ii_holding_snapshots', { method: 'POST', body: snaps });
  await req('/rest/v1/ii_transactions', {
    method: 'POST',
    body: {
      user_id: userId, account_id: acct.id, instrument_id: inst.id, currency_code: currency,
      transaction_type: 'purchase', transaction_date: '2021-01-31', gross_amount: initial.toFixed(2),
      units: '1000.000000', status: 'reconciled',
    },
  });
  await req('/rest/v1/ii_portfolio_truth_status', {
    method: 'POST',
    body: { user_id: userId, account_id: acct.id, instrument_id: inst.id, status: 'certified', history_completeness: completeness },
  });
}

// A deliberately mixed portfolio so the page shows BOTH real numbers and
// genuine suppression states side by side.
await seedFund({ name: `UX Growth Fund ${stamp}`, currency: 'INR', country: 'IN', monthly: 0.018, mapped: true, completeness: 'complete_from_inception', initial: 100000 });
await seedFund({ name: `UX Unmapped Fund ${stamp}`, currency: 'INR', country: 'IN', monthly: 0.012, mapped: false, completeness: 'complete_from_inception', initial: 50000 });
await seedFund({ name: `UX Partial-History Fund ${stamp}`, currency: 'INR', country: 'IN', monthly: 0.010, mapped: true, completeness: 'partial_history', initial: 30000 });
await seedFund({ name: `UX Aussie Fund ${stamp}`, currency: 'AUD', country: 'AU', monthly: 0.009, mapped: false, completeness: 'complete_from_inception', initial: 20000 });

const session = await req('/auth/v1/token?grant_type=password', { method: 'POST', apikey: ANON, token: ANON, body: { email, password } });

fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const projectRef = new URL(BASE).host.split('.')[0];
console.log(JSON.stringify({
  storageKey: `sb-${projectRef}-auth-token`,
  session: {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
    expires_in: session.expires_in ?? 3600,
    token_type: 'bearer',
    user: session.user,
  },
}));
