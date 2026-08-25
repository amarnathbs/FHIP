import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3219';
function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) { const m = line.match(/^([A-Za-z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];
async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}
async function app(pathname, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(`${APP}${pathname}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const stamp = Date.now();
const email = `r10-retdebug-${stamp}@fhip-test.invalid`;
const password = `TestPass!${stamp}Aa1`;
let userId;
try {
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  userId = created.json.id;
  await sb(`/rest/v1/user_entitlements?user_id=eq.${userId}`, { method: 'PATCH', body: { plan_tier: 'premium' } });
  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await tokenRes.json();
  const cookie = `sb-${PROJECT_REF}-auth-token=base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`;

  await sb('/rest/v1/user_profiles', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { user_id: userId, full_name: 'Retirement Debug', date_of_birth: '1985-06-15', country_of_residence: 'IN', preferred_currency: 'INR', onboarding_completed: true } });
  await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', amount: 150000, frequency: 'monthly', is_active: true } });
  await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: userId, expense_name: 'Household', amount: 60000, frequency: 'monthly', is_essential: true, expense_category: 'housing', is_active: true } });
  await sb('/rest/v1/retirement_accounts', { method: 'POST', body: { user_id: userId, account_name: 'NPS', account_type: 'NPS', current_balance: 800000, currency_code: 'INR', country_code: 'IN', is_active: true } });

  console.log('userId:', userId);
  console.log('calling report generate (which internally calls buildForecastReportData -> safeRunDetail for retirement)...');
  const genRes = await app('/api/reports/generate', { cookie, method: 'POST', body: { reportType: 'net_worth' } });
  console.log('report generate status:', genRes.status);
  const sections = (genRes.json?.data ?? genRes.json)?.sections ?? [];
  const retirementSection = sections.find((s) => s.sectionCode === 'retirement_readiness');
  console.log('retirement section status:', retirementSection?.sectionStatus, retirementSection?.limitationText);
} finally {
  if (userId) await sb(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
}
