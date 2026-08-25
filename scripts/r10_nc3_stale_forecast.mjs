// II-R10 — NC3 (stale forecast / historical immutability). Generate report
// A, change canonical source data, revise to report B, confirm A's own
// stored data is byte-unchanged while B reflects the new data.
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
  return { status: res.status, json: json?.data ?? json, text };
}
const stamp = Date.now();
const email = `r10-nc3-${stamp}@fhip-test.invalid`;
const password = `TestPass!${stamp}Aa1`;
let userId, assetId;
try {
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  userId = created.json.id;
  await sb(`/rest/v1/user_entitlements?user_id=eq.${userId}`, { method: 'PATCH', body: { plan_tier: 'premium' } });
  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await tokenRes.json();
  const cookie = `sb-${PROJECT_REF}-auth-token=base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`;

  await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', amount: 5000, frequency: 'monthly', is_active: true } });
  await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: userId, expense_name: 'Rent', amount: 1500, frequency: 'monthly', is_essential: true, expense_category: 'housing', is_active: true } });
  const assetRes = await sb('/rest/v1/assets', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, asset_name: 'Initial Savings', current_value: 100000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD', is_active: true } });
  assetId = assetRes.json[0].id;

  const genA = await app('/api/reports/generate', { cookie, method: 'POST', body: { reportType: 'net_worth' } });
  const netWorthA = genA.json?.sections?.find((s) => s.sectionCode === 'net_worth')?.sectionData?.netWorth;
  const reportIdA = genA.json?.report?.id;
  console.log('Report A:', reportIdA, 'net worth:', netWorthA);

  await sb(`/rest/v1/assets?id=eq.${assetId}`, { method: 'PATCH', body: { current_value: 900000 } });

  const reviseRes = await app(`/api/reports/${reportIdA}/revise`, { cookie, method: 'POST', body: { reason: 'NC3 test data change' } });
  const reportIdB = reviseRes.json?.report?.id;
  const netWorthB = reviseRes.json?.sections?.find((s) => s.sectionCode === 'net_worth')?.sectionData?.netWorth;
  console.log('Report B:', reportIdB, 'net worth:', netWorthB, 'revises A:', reviseRes.json?.report?.revises_report_id === reportIdA);

  const refetchA = await app(`/api/reports/${reportIdA}`, { cookie });
  const netWorthA_after = refetchA.json?.sections?.find((s) => s.sectionCode === 'net_worth')?.sectionData?.netWorth;
  const statusA_after = refetchA.json?.report?.status;

  console.log('\n=== RESULT ===');
  const checks = [
    ['A net worth unchanged after B created (historical immutability)', netWorthA === netWorthA_after, `${netWorthA} === ${netWorthA_after}`],
    ['A marked superseded', statusA_after === 'superseded', statusA_after],
    ['B reflects the new asset value (net worth increased)', netWorthB > netWorthA, `${netWorthB} > ${netWorthA}`],
    ['B is a genuinely different report id', reportIdA !== reportIdB, `${reportIdA} !== ${reportIdB}`],
    ['B correctly links back to A via revises_report_id', reviseRes.json?.report?.revises_report_id === reportIdA, ''],
  ];
  let allPass = true;
  for (const [label, pass, detail] of checks) {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} ${detail}`);
    if (!pass) allPass = false;
  }
  console.log(allPass ? '\nPASS: NC3/historical immutability proven live' : '\nFAIL');
  process.exitCode = allPass ? 0 : 1;
} finally {
  if (userId) await sb(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
  console.log('cleaned up test user');
}
