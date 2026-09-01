// FDH-16 Targeted Final Closure, item 2: creates one synthetic, premium-tier,
// AU household with data across every surface the UI smoke must cover
// (Income/Expenses/Assets/Liabilities/Investments/Retirement/Goals), so the
// smoke pass exercises real content rather than only empty states. Prints
// the login credentials and user id (needed for teardown) to stdout.
//
// Run: npx tsx scripts/fdh16_ui_smoke_user_setup.mjs           (create)
// Run: npx tsx scripts/fdh16_ui_smoke_user_setup.mjs --teardown <uid>  (delete)
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
if (!BASE.includes(DEV_REF)) { console.error(`FATAL: refusing to run — ${BASE} is not the known DEV project.`); process.exit(2); }
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
async function svc(method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { ...SH, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function asUser(token, method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

const args = process.argv.slice(2);
if (args[0] === '--teardown') {
  const uid = args[1];
  (async () => {
    for (const t of ['income_sources', 'expense_items', 'assets', 'liabilities', 'investments', 'retirement_accounts', 'retirement_members', 'insurance_policies', 'user_goals', 'financial_snapshots']) {
      await svc('DELETE', `${t}?user_id=eq.${uid}`);
    }
    const del = await fetch(`${BASE}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: SH });
    console.log('teardown delete status:', del.status);
    for (const t of ['income_sources', 'expense_items', 'assets', 'liabilities', 'investments', 'retirement_accounts', 'user_goals']) {
      const r = await svc('GET', `${t}?user_id=eq.${uid}&select=id`);
      console.log(`  residue ${t}:`, r.json?.length);
    }
    const check = await fetch(`${BASE}/auth/v1/admin/users/${uid}`, { headers: SH });
    console.log('user still exists (should be 404):', check.status);
  })();
} else {
  (async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const email = `fdh16-uismoke-${stamp}@fhip-test.invalid`;
    const password = `Fdh16UiSmoke!${stamp}`;
    const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { ...SH, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
    const j = await r.json();
    if (!j.id) throw new Error(`createUser failed: ${JSON.stringify(j).slice(0, 300)}`);
    const uid = j.id;
    const now = new Date().toISOString();
    await svc('PATCH', `user_profiles?user_id=eq.${uid}`, { full_name: 'FDH16 UI Smoke', country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100, country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
    await svc('PATCH', `user_entitlements?user_id=eq.${uid}`, { plan_tier: 'premium' });

    const signInR = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const signInJ = await signInR.json();
    const token = signInJ.access_token;

    await asUser(token, 'POST', 'income_sources', { user_id: uid, source_name: 'Salary', employer_name: 'FDH16 UI Smoke Employer', income_type: 'salary', amount: 9000, frequency: 'monthly', currency_code: 'AUD', is_active: true, owner: 'self' });
    await asUser(token, 'POST', 'expense_items', { user_id: uid, expense_name: 'Rent', amount: 2200, frequency: 'monthly', is_essential: true, expense_category: 'housing', currency_code: 'AUD', is_active: true });
    await asUser(token, 'POST', 'expense_items', { user_id: uid, expense_name: 'Groceries', amount: 800, frequency: 'monthly', is_essential: true, expense_category: 'groceries', currency_code: 'AUD', is_active: true });
    await asUser(token, 'POST', 'assets', { user_id: uid, asset_name: 'Home', current_value: 750000, asset_class: 'property', country_code: 'AU', currency_code: 'AUD', is_active: true });
    await asUser(token, 'POST', 'liabilities', { user_id: uid, liability_name: 'Home Loan', debt_type: 'mortgage', balance: 450000, interest_rate: 6.1, monthly_repayment: 2800, currency_code: 'AUD', country_code: 'AU', is_active: true, owner: 'self' });
    await asUser(token, 'POST', 'investments', { user_id: uid, investment_name: 'Vanguard ETF', investment_type: 'etf', current_value: 65000, currency_code: 'AUD', country_code: 'AU', is_active: true });
    const memberR = await asUser(token, 'POST', 'retirement_members', { user_id: uid, member_type: 'self', country_code: 'AU' });
    const memberId = memberR.json?.[0]?.id;
    await asUser(token, 'POST', 'retirement_accounts', { user_id: uid, account_name: 'Super', account_type: 'super', current_balance: 180000, currency_code: 'AUD', country_code: 'AU', is_active: true, owner: 'self', retirement_member_id: memberId });
    await asUser(token, 'POST', 'insurance_policies', { user_id: uid, policy_name: 'Life Cover', cover_type: 'life', cover_amount: 500000, premium: 45, premium_frequency: 'monthly', is_active: true });
    await asUser(token, 'POST', 'user_goals', { user_id: uid, goal_name: 'Emergency Fund', target_amount: 30000, current_amount: 12000, currency_code: 'AUD', priority: 'high', status: 'active', target_date: '2027-06-01' });

    console.log(JSON.stringify({ uid, email, password }));
  })();
}
