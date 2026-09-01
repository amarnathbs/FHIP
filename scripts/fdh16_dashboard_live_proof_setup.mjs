// FDH-16 — fresh hosted-DEV Dashboard integration proof (spec sections 98-105,
// 209-213, 247 "Dashboard integration... hosted UI smoke" must be fresh).
//
// Creates ONE synthetic AU household with known canonical values across every
// domain the Dashboard reads (per lib/services/dashboardData.ts's own real
// query list), so a real browser session against the real Dashboard page can
// be independently reconciled against an oracle computed here.
//
// Usage:
//   node scripts/fdh16_dashboard_live_proof_setup.mjs create   -> prints credentials + oracle, writes state file
//   node scripts/fdh16_dashboard_live_proof_setup.mjs cleanup  -> deletes everything, re-verifies 0 residue
import fs from 'node:fs';

const STATE_FILE = new URL('../fdh16_dashboard_proof_state.json', import.meta.url);

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
async function svc(method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { ...SH, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function asUser(token, method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function insertAsUser(token, table, body, track) {
  const r = await asUser(token, 'POST', table, body);
  const row = Array.isArray(r.json) ? r.json[0] : null;
  if (!row) throw new Error(`insertAsUser ${table} failed (${r.status}): ${r.text.slice(0, 500)}`);
  if (track) track.push({ table, id: row.id });
  return row;
}

async function createUser() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `fdh16-dashcheck-${stamp}@fhip-test.invalid`;
  const password = `Fdh16Dash!${stamp}`;
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { ...SH, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await svc('PATCH', `user_profiles?user_id=eq.${j.id}`, { full_name: 'FDH16 Dashboard Check', country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100, country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
  const signInR = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const signInJ = await signInR.json();
  if (!signInJ.access_token) throw new Error(`signIn failed: ${JSON.stringify(signInJ).slice(0, 300)}`);
  return { id: j.id, email, password, token: signInJ.access_token };
}
async function deleteUser(id) {
  await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH });
}

const FACTS = { income: 7000, expense: 2200, asset: 50000, liability: 30000, investment: 80000, retirement: 200000 };

async function create() {
  const U = await createUser();
  const track = [];
  await insertAsUser(U.token, 'income_sources', { user_id: U.id, source_name: 'Salary', income_type: 'salary', amount: FACTS.income, frequency: 'monthly', currency_code: 'AUD', is_active: true, owner: 'self' }, track);
  await insertAsUser(U.token, 'expense_items', { user_id: U.id, expense_name: 'Groceries', amount: FACTS.expense, frequency: 'monthly', is_essential: true, expense_category: 'groceries', currency_code: 'AUD', is_active: true }, track);
  await insertAsUser(U.token, 'assets', { user_id: U.id, asset_name: 'Everyday Bank Balance', asset_class: 'cash', current_value: FACTS.asset, currency_code: 'AUD', is_active: true }, track);
  await insertAsUser(U.token, 'liabilities', { user_id: U.id, liability_name: 'Car Loan', debt_type: 'personal_loan', balance: FACTS.liability, currency_code: 'AUD', is_active: true, owner: 'self' }, track);
  await insertAsUser(U.token, 'investments', { user_id: U.id, investment_name: 'ASX Portfolio', investment_type: 'shares', current_value: FACTS.investment, cost_base: FACTS.investment * 0.8, currency_code: 'AUD', is_active: true }, track);
  const member = await insertAsUser(U.token, 'retirement_members', { user_id: U.id, member_type: 'self', country_code: 'AU' }, track);
  await insertAsUser(U.token, 'retirement_accounts', { user_id: U.id, account_name: 'Super', account_type: 'super', current_balance: FACTS.retirement, currency_code: 'AUD', is_active: true, owner: 'self', retirement_member_id: member.id }, track);

  const oracleNetWorth = FACTS.asset + FACTS.investment + FACTS.retirement - FACTS.liability;
  const state = { userId: U.id, email: U.email, password: U.password, track, FACTS, oracleNetWorth };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('=== FDH-16 Dashboard live proof fixture created ===');
  console.log(`Email: ${U.email}`);
  console.log(`Password: ${U.password}`);
  console.log(`Expected Net Worth oracle: ${FACTS.asset} + ${FACTS.investment} + ${FACTS.retirement} - ${FACTS.liability} = ${oracleNetWorth}`);
  console.log(`Expected monthly income: ${FACTS.income}, expected monthly expense: ${FACTS.expense}`);
  console.log(`Expected liabilities total: ${FACTS.liability}`);
  console.log(`State written to ${STATE_FILE.pathname}`);
}

async function cleanup() {
  if (!fs.existsSync(STATE_FILE)) { console.log('No state file — nothing to clean up.'); return; }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  for (const { table, id } of state.track.reverse()) {
    await svc('DELETE', `${table}?id=eq.${id}`);
  }
  // financial_snapshots row created by loadDashboard()'s own upsert — clean that too.
  await svc('DELETE', `financial_snapshots?user_id=eq.${state.userId}`);
  await deleteUser(state.userId);
  const residual = await svc('GET', `income_sources?user_id=eq.${state.userId}&select=id`);
  const residualUser = await fetch(`${BASE}/auth/v1/admin/users/${state.userId}`, { headers: SH });
  const residualSnap = await svc('GET', `financial_snapshots?user_id=eq.${state.userId}&select=id`);
  console.log(`CLEANUP: residual income rows = ${residual.json?.length ?? 'N/A'}`);
  console.log(`CLEANUP: residual financial_snapshots rows = ${residualSnap.json?.length ?? 'N/A'}`);
  console.log(`CLEANUP: auth user delete status = ${residualUser.status} (expect >=400 / not found)`);
  fs.unlinkSync(STATE_FILE);
}

const mode = process.argv[2];
if (mode === 'create') await create();
else if (mode === 'cleanup') await cleanup();
else { console.error('usage: node scripts/fdh16_dashboard_live_proof_setup.mjs create|cleanup'); process.exit(2); }
