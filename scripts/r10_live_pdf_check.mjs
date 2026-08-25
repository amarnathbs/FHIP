import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3219';
function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
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
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}
async function app(pathname, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(`${APP}${pathname}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const stamp = Date.now();
let userId;
try {
  const email = `r10-pdfcheck-${stamp}@fhip-test.invalid`;
  const password = 'TestPass!' + stamp + 'Aa1';
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  userId = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await res2.json();
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  const cookie = `sb-${PROJECT_REF}-auth-token=${cookieValue}`;

  await sb(`/rest/v1/user_entitlements?user_id=eq.${userId}`, { method: 'PATCH', body: { plan_tier: 'premium' } });
  await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', amount: 8000, frequency: 'monthly', is_active: true } });
  await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: userId, expense_name: 'Rent', amount: 2000, frequency: 'monthly', is_essential: true, expense_category: 'housing', is_active: true } });
  await sb('/rest/v1/assets', { method: 'POST', body: { user_id: userId, asset_name: 'Savings', current_value: 50000, asset_class: 'cash', country_code: 'AU', is_active: true } });

  console.log('warming the print route shell (unauthenticated 401 is fine, just needs Turbopack to compile it once)...');
  await fetch(`${APP}/reports/00000000-0000-0000-0000-000000000000/print`, { method: 'GET' }).catch(() => {});
  console.log('warmed.');

  const genRes = await app('/api/reports/generate', { cookie, method: 'POST', body: { reportType: 'net_worth' } });
  const reportId = genRes.json?.data?.report?.id;
  console.log('report:', reportId, genRes.status);

  console.log('requesting PDF export (this compiles the print route for real on first navigation if not already warm)...');
  const exportRes = await app(`/api/reports/${reportId}/exports`, { cookie, method: 'POST', body: { format: 'pdf' } });
  const exportData = exportRes.json?.data ?? exportRes.json;
  console.log('export result:', exportRes.status, JSON.stringify(exportData).slice(0, 400));

  if (exportData?.status === 'ready') {
    const downloadRes = await app(`/api/report-exports/${exportData.id}/download`, { cookie });
    console.log('download status:', downloadRes.status);
    console.log(`RESULT: PDF generated, ${exportData.file_size_bytes} bytes, download ${downloadRes.status < 400 ? 'OK' : 'FAILED'}`);
  } else {
    console.log('RESULT: PDF generation did not reach ready state.');
  }
} finally {
  if (userId) {
    await sb(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
    console.log('cleaned up test user', userId);
  }
}
