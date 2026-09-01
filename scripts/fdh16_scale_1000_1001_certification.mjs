// FDH-16 — fresh 1000/1001 boundary retrieval proof (spec §166, §247 "must be
// fresh").
//
// FDH16-DEF-001 (found live by this script's first run, now fixed): a raw,
// unpaginated PostgREST request against this DEV project is silently capped
// at 1000 rows (content-range header confirms the true total but the body
// only carries 1000) — and lib/services/dashboardData.ts's loadDashboard()
// had no .range() on any of its 8 register queries, so a household with
// >1000 active rows in any one register would have its Dashboard/Net-Worth/
// Cashflow totals silently computed from an incomplete row set. Fixed in
// this same round via a fetchAllRows() pagination helper (see
// lib/services/dashboardData.ts and FDH16_RESIDUAL_RISK_REGISTER.md).
//
// This script: (1) demonstrates the raw platform behaviour as a permanent
// negative control, (2) proves the REAL, FIXED loadDashboard() (imported
// directly, called with a service-role-backed supabase-js client for one
// synthetic user, never re-implemented by hand) retrieves and sums all rows
// correctly at both the 1000 and 1001 boundary.
//
// Run: node scripts/fdh16_scale_1000_1001_certification.mjs
import fs from 'node:fs';

function loadEnv() {
  const text = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    if (!line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const DEV_REF = 'vqycarelcoijzwlpkpcz';
if (!BASE || !SERVICE || !ANON) { console.error('FATAL: missing env vars'); process.exit(2); }
if (!BASE.includes(DEV_REF)) { console.error(`FATAL: refusing to run — ${BASE} is not the known DEV project.`); process.exit(2); }

const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
async function svc(method, path, body, extraHeaders = {}) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { ...SH, 'Content-Type': 'application/json', ...extraHeaders }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function asUser(token, method, path, body, extraHeaders = {}) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
};

async function createUser() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `fdh16-scale-${stamp}@fhip-test.invalid`;
  const password = `Fdh16Scale!${stamp}`;
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { ...SH, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await svc('PATCH', `user_profiles?user_id=eq.${j.id}`, { full_name: 'FDH16 Scale Check', country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100, country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
  const signInR = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const signInJ = await signInR.json();
  if (!signInJ.access_token) throw new Error(`signIn failed: ${JSON.stringify(signInJ).slice(0, 300)}`);
  return { id: j.id, email, token: signInJ.access_token };
}
async function deleteUser(id) { await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH }); }

async function bulkInsertExpenses(uid, count) {
  const CHUNK = 200;
  for (let i = 0; i < count; i += CHUNK) {
    const n = Math.min(CHUNK, count - i);
    const rows = Array.from({ length: n }, (_, k) => ({
      user_id: uid, expense_name: `FDH16 Scale Expense ${i + k + 1}`, amount: 1, frequency: 'monthly',
      is_essential: false, expense_category: 'other', currency_code: 'AUD', is_active: true,
    }));
    const r = await svc('POST', 'expense_items', rows, { Prefer: 'return=minimal' });
    if (r.status >= 300) throw new Error(`bulk insert chunk failed (${r.status}): ${r.text.slice(0, 300)}`);
  }
}

async function main() {
  console.log('=== FDH-16 LIVE DEV: 1000/1001 scale boundary certification ===');
  const U = await createUser();
  console.log(`Synthetic scale user: ${U.email} (${U.id})`);
  const { createClient } = await import('@supabase/supabase-js');
  const { loadDashboard } = await import('../lib/services/dashboardData.ts');
  const serviceClient = createClient(BASE, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    console.log('\n--- Inserting 1000 expense_items rows ---');
    await bulkInsertExpenses(U.id, 1000);

    console.log('\n--- NEGATIVE CONTROL: raw unpaginated PostgREST request at 1000 rows ---');
    const r1000raw = await asUser(U.token, 'GET', `expense_items?user_id=eq.${U.id}&is_active=eq.true&select=expense_name,amount,frequency,is_essential,master_item_key,expense_category`, undefined, { Prefer: 'count=exact' });
    console.log(`  raw retrieved=${r1000raw.json?.length} content-range=${r1000raw.headers.get('content-range')} (at exactly 1000, the cap is not yet visible)`);

    const summary1000 = await loadDashboard(U.id, serviceClient);
    check('SCALE-1000-FIX: real (fixed) loadDashboard() totalMonthlyExpenses = 1000 at the boundary', summary1000.totalMonthlyExpenses === 1000, `engine=${summary1000.totalMonthlyExpenses}`);

    console.log('\n--- Inserting 1 more row (total 1001) ---');
    await bulkInsertExpenses(U.id, 1);

    console.log('\n--- NEGATIVE CONTROL: raw unpaginated PostgREST request at 1001 rows (demonstrates the underlying platform cap, permanently) ---');
    const r1001raw = await asUser(U.token, 'GET', `expense_items?user_id=eq.${U.id}&is_active=eq.true&select=expense_name,amount,frequency,is_essential,master_item_key,expense_category`, undefined, { Prefer: 'count=exact' });
    check('SCALE-1001-NEGATIVE-CONTROL: raw single-request PostgREST call IS silently capped at 1000 of 1001 (content-range proves the platform truncates; this is exactly the symptom the fix guards against)', r1001raw.json?.length === 1000 && (r1001raw.headers.get('content-range') || '').endsWith('/1001'), `retrieved=${r1001raw.json?.length} content-range=${r1001raw.headers.get('content-range')}`);

    console.log('\n--- FIX PROOF: real (fixed) loadDashboard() at 1001 rows ---');
    const summary1001 = await loadDashboard(U.id, serviceClient);
    check('SCALE-1001-FIX: real (fixed) loadDashboard() totalMonthlyExpenses = 1001, NOT silently truncated to 1000', summary1001.totalMonthlyExpenses === 1001, `engine=${summary1001.totalMonthlyExpenses}`);
  } finally {
    console.log('\n--- CLEANUP ---');
    await svc('DELETE', `expense_items?user_id=eq.${U.id}`);
    await svc('DELETE', `financial_snapshots?user_id=eq.${U.id}`);
    await deleteUser(U.id);
    const residual = await svc('GET', `expense_items?user_id=eq.${U.id}&select=id`);
    const residualSnap = await svc('GET', `financial_snapshots?user_id=eq.${U.id}&select=id`);
    const residualUser = await fetch(`${BASE}/auth/v1/admin/users/${U.id}`, { headers: SH });
    check('CLEANUP: 0 residual expense_items rows', Array.isArray(residual.json) && residual.json.length === 0, `rows=${residual.json?.length}`);
    check('CLEANUP: 0 residual financial_snapshots rows', Array.isArray(residualSnap.json) && residualSnap.json.length === 0, `rows=${residualSnap.json?.length}`);
    check('CLEANUP: auth user deleted', residualUser.status >= 400, `status=${residualUser.status}`);
  }
  console.log(`\n${pass}/${pass + fail} PASS`);
  if (fail) process.exitCode = 1;
}
main();
