// FDH-16 — Targeted Final Closure, item 1: fresh 1000/1001 boundary proof for
// lib/services/reportSnapshotResolver.ts's Premium report data loader
// (resolveReportSourceData), the second confirmed instance of FDH16-DEF-001
// (see FDH16_RESIDUAL_RISK_REGISTER.md). That fix was previously accepted by
// source-inspection pattern-matching only ("fetchAllRows() is used here too,
// therefore it must behave the same way") — this script instead proves it
// directly: real data, real boundary, the REAL resolver function imported and
// invoked (never a reimplementation).
//
// Register 1 (mandatory): expense_items -> ReportSourceData.premium.expenseItems
// Register 2 (secondary, "if easy"): investments -> ReportSourceData.premium.investments
//
// Run: node scripts/fdh16_report_resolver_scale_certification.mjs
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
  const email = `fdh16-reportscale-${stamp}@fhip-test.invalid`;
  const password = `Fdh16Rpt!${stamp}`;
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { ...SH, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await svc('PATCH', `user_profiles?user_id=eq.${j.id}`, { full_name: 'FDH16 Report Scale Check', country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100, country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
  // Premium tier required — resolveReportSourceData only populates .premium
  // (which is where the fixed fetchAllRows() queries live) for planTier === 'premium'.
  const entUpdate = await svc('PATCH', `user_entitlements?user_id=eq.${j.id}`, { plan_tier: 'premium' }, { Prefer: 'return=representation' });
  if (!Array.isArray(entUpdate.json) || entUpdate.json.length !== 1 || entUpdate.json[0].plan_tier !== 'premium') {
    throw new Error(`Failed to set premium entitlement: ${entUpdate.status} ${entUpdate.text.slice(0, 300)}`);
  }
  const signInR = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const signInJ = await signInR.json();
  if (!signInJ.access_token) throw new Error(`signIn failed: ${JSON.stringify(signInJ).slice(0, 300)}`);
  return { id: j.id, email, token: signInJ.access_token };
}
async function deleteUser(id) { await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH }); }

async function bulkInsertExpenses(uid, count, startAt) {
  const CHUNK = 200;
  for (let i = 0; i < count; i += CHUNK) {
    const n = Math.min(CHUNK, count - i);
    const rows = Array.from({ length: n }, (_, k) => ({
      user_id: uid, expense_name: `FDH16 Report Scale Expense ${startAt + i + k + 1}`, amount: 1, frequency: 'monthly',
      is_essential: false, expense_category: 'other', currency_code: 'AUD', is_active: true,
    }));
    const r = await svc('POST', 'expense_items', rows, { Prefer: 'return=minimal' });
    if (r.status >= 300) throw new Error(`bulk insert expense_items chunk failed (${r.status}): ${r.text.slice(0, 300)}`);
  }
}
async function bulkInsertInvestments(uid, count, startAt) {
  const CHUNK = 200;
  for (let i = 0; i < count; i += CHUNK) {
    const n = Math.min(CHUNK, count - i);
    const rows = Array.from({ length: n }, (_, k) => ({
      user_id: uid, investment_name: `FDH16 Report Scale Investment ${startAt + i + k + 1}`, investment_type: 'shares',
      current_value: 1, currency_code: 'AUD', country_code: 'AU', is_active: true,
    }));
    const r = await svc('POST', 'investments', rows, { Prefer: 'return=minimal' });
    if (r.status >= 300) throw new Error(`bulk insert investments chunk failed (${r.status}): ${r.text.slice(0, 300)}`);
  }
}

async function main() {
  console.log('=== FDH-16 CLOSURE item 1: report resolver 1000/1001 boundary certification ===');
  const U = await createUser();
  console.log(`Synthetic report-scale user (premium): ${U.email} (${U.id})`);
  const { createClient } = await import('@supabase/supabase-js');
  const { resolveReportSourceData } = await import('../lib/services/reportSnapshotResolver.ts');
  const serviceClient = createClient(BASE, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    // ============================================================
    // REGISTER 1 (mandatory): expense_items -> premium.expenseItems
    // ============================================================
    console.log('\n--- REGISTER 1: expense_items ---');
    console.log('Inserting 1000 expense_items rows...');
    await bulkInsertExpenses(U.id, 1000, 0);

    console.log('NEGATIVE CONTROL: raw unpaginated PostgREST request at 1000 rows (not yet visible at exactly 1000)');
    const r1000raw = await asUser(U.token, 'GET', `expense_items?user_id=eq.${U.id}&is_active=eq.true&select=id,amount`, undefined, { Prefer: 'count=exact' });
    console.log(`  raw retrieved=${r1000raw.json?.length} content-range=${r1000raw.headers.get('content-range')}`);

    console.log('Calling the REAL resolveReportSourceData() at 1000 rows...');
    const src1000 = await resolveReportSourceData(U.id, undefined, serviceClient);
    check('REG1-1000: premium.expenseItems.length === 1000', src1000.premium?.expenseItems?.length === 1000, `got=${src1000.premium?.expenseItems?.length}`);
    const sum1000 = (src1000.premium?.expenseItems ?? []).reduce((s, r) => s + Number(r.amount), 0);
    check('REG1-1000: economic total (sum of amount) === 1000', sum1000 === 1000, `sum=${sum1000}`);

    console.log('Inserting 1 more expense_items row (total 1001)...');
    await bulkInsertExpenses(U.id, 1, 1000);

    console.log('NEGATIVE CONTROL: raw unpaginated PostgREST request at 1001 rows (permanent platform-cap proof)');
    const r1001raw = await asUser(U.token, 'GET', `expense_items?user_id=eq.${U.id}&is_active=eq.true&select=id,amount`, undefined, { Prefer: 'count=exact' });
    check('REG1-NEGCTRL: raw single-request PostgREST call IS silently capped at 1000 of 1001', r1001raw.json?.length === 1000 && (r1001raw.headers.get('content-range') || '').endsWith('/1001'), `retrieved=${r1001raw.json?.length} content-range=${r1001raw.headers.get('content-range')}`);

    console.log('Calling the REAL resolveReportSourceData() at 1001 rows...');
    const src1001 = await resolveReportSourceData(U.id, undefined, serviceClient);
    check('REG1-1001 (DECISIVE): premium.expenseItems.length === 1001, NOT silently truncated to 1000', src1001.premium?.expenseItems?.length === 1001, `got=${src1001.premium?.expenseItems?.length}`);
    const sum1001 = (src1001.premium?.expenseItems ?? []).reduce((s, r) => s + Number(r.amount), 0);
    check('REG1-1001 (DECISIVE): economic total (sum of amount) === 1001, NOT $1 short', sum1001 === 1001, `sum=${sum1001}`);

    // ============================================================
    // REGISTER 2 (secondary): investments -> premium.investments
    // ============================================================
    console.log('\n--- REGISTER 2 (secondary): investments ---');
    console.log('Inserting 1000 investments rows...');
    await bulkInsertInvestments(U.id, 1000, 0);
    const src2_1000 = await resolveReportSourceData(U.id, undefined, serviceClient);
    check('REG2-1000: premium.investments.length === 1000', src2_1000.premium?.investments?.length === 1000, `got=${src2_1000.premium?.investments?.length}`);

    console.log('Inserting 1 more investments row (total 1001)...');
    await bulkInsertInvestments(U.id, 1, 1000);
    const r2_1001raw = await asUser(U.token, 'GET', `investments?user_id=eq.${U.id}&is_active=eq.true&select=id,current_value`, undefined, { Prefer: 'count=exact' });
    check('REG2-NEGCTRL: raw investments request also capped at 1000 of 1001', r2_1001raw.json?.length === 1000 && (r2_1001raw.headers.get('content-range') || '').endsWith('/1001'), `retrieved=${r2_1001raw.json?.length} content-range=${r2_1001raw.headers.get('content-range')}`);

    const src2_1001 = await resolveReportSourceData(U.id, undefined, serviceClient);
    check('REG2-1001 (DECISIVE): premium.investments.length === 1001, NOT silently truncated to 1000', src2_1001.premium?.investments?.length === 1001, `got=${src2_1001.premium?.investments?.length}`);
    const invSum1001 = (src2_1001.premium?.investments ?? []).reduce((s, r) => s + Number(r.current_value), 0);
    check('REG2-1001 (DECISIVE): investments economic total === 1001', invSum1001 === 1001, `sum=${invSum1001}`);
  } finally {
    console.log('\n--- CLEANUP ---');
    await svc('DELETE', `expense_items?user_id=eq.${U.id}`);
    await svc('DELETE', `investments?user_id=eq.${U.id}`);
    await svc('DELETE', `financial_snapshots?user_id=eq.${U.id}`);
    await deleteUser(U.id);
    const residualExp = await svc('GET', `expense_items?user_id=eq.${U.id}&select=id`);
    const residualInv = await svc('GET', `investments?user_id=eq.${U.id}&select=id`);
    const residualSnap = await svc('GET', `financial_snapshots?user_id=eq.${U.id}&select=id`);
    const residualUser = await fetch(`${BASE}/auth/v1/admin/users/${U.id}`, { headers: SH });
    check('CLEANUP: 0 residual expense_items rows', Array.isArray(residualExp.json) && residualExp.json.length === 0, `rows=${residualExp.json?.length}`);
    check('CLEANUP: 0 residual investments rows', Array.isArray(residualInv.json) && residualInv.json.length === 0, `rows=${residualInv.json?.length}`);
    check('CLEANUP: 0 residual financial_snapshots rows', Array.isArray(residualSnap.json) && residualSnap.json.length === 0, `rows=${residualSnap.json?.length}`);
    check('CLEANUP: auth user deleted', residualUser.status >= 400, `status=${residualUser.status}`);
  }
  console.log(`\n${pass}/${pass + fail} PASS`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error('FATAL ERROR', e); process.exitCode = 1; });
