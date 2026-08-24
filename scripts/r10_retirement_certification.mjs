// II-R10 — Retirement Readiness terminal certification (risk-based
// closure spec sections 4-8). Live-reproduces the fix, proves R10 raw
// values equal the canonical forecast run's raw values, and tests the
// required edge cases (no data / partial data must still degrade safely).
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
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]));
  return v;
}
const deepEqual = (a, b) => JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
}

async function makeUser(tag) {
  const stamp = Date.now();
  const email = `r10-ret-${tag}-${stamp}@fhip-test.invalid`;
  const password = `TestPass!${stamp}Aa1`;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const userId = created.json.id;
  await sb(`/rest/v1/user_entitlements?user_id=eq.${userId}`, { method: 'PATCH', body: { plan_tier: 'premium' } });
  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await tokenRes.json();
  const cookie = `sb-${PROJECT_REF}-auth-token=base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`;
  return { userId, cookie };
}

const cleanupUsers = [];
try {
  // --- Case A: valid retirement data + a REALISTIC (not degenerate) desired-income target -> must be included AND exact-match canonical ---
  {
    const { userId, cookie } = await makeUser('valid');
    cleanupUsers.push(userId);
    await sb('/rest/v1/user_profiles', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { user_id: userId, date_of_birth: '1985-06-15', country_of_residence: 'IN', preferred_currency: 'INR', onboarding_completed: true } });
    await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', amount: 150000, frequency: 'monthly', is_active: true } });
    await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: userId, expense_name: 'Household', amount: 60000, frequency: 'monthly', is_essential: true, expense_category: 'housing', is_active: true } });
    await sb('/rest/v1/retirement_accounts', { method: 'POST', body: { user_id: userId, account_name: 'NPS', account_type: 'NPS', current_balance: 800000, currency_code: 'INR', country_code: 'IN', is_active: true } });

    const genRes = await app('/api/reports/generate', { cookie, method: 'POST', body: { reportType: 'net_worth' } });
    const sections = (genRes.json?.data ?? genRes.json)?.sections ?? [];
    const retirementSection = sections.find((s) => s.sectionCode === 'retirement_readiness');
    record('RET-A1', 'Case A (valid data, previously degenerate target): report generation succeeds', genRes.status === 200 ? 'PASS' : 'FAIL', `status=${genRes.status}`);
    record('RET-A2', 'Case A: Retirement Readiness chapter reaches included (RED->GREEN proof: this exact scenario returned "unavailable" with a swallowed "numeric field overflow" DB error before this session\'s fix)', retirementSection?.sectionStatus === 'included' ? 'PASS' : 'FAIL', `status=${retirementSection?.sectionStatus}, limitationText=${retirementSection?.limitationText}`);

    const forecastRunId = retirementSection?.sourceReferences?.forecastRunId;
    if (forecastRunId) {
      const canonRes = await app(`/api/forecast/runs/${forecastRunId}`, { cookie });
      const canonResults = canonRes.json?.data?.results;
      const reportResults = retirementSection?.sectionData?.results;
      record('RET-A3 (no-recalculation)', 'Report retirement_readiness.results equals the canonical forecast run detail (exact raw-value equality)', deepEqual(reportResults, canonResults) ? 'PASS' : 'FAIL', `report rows=${reportResults?.length}, canonical rows=${canonResults?.length}`);
      // Every period's variance_percentage must now be a real number or
      // null -- never silently missing the whole row, never an unfittable value.
      const varField = 'variance_percentage' in (canonResults?.[0] ?? {}) ? 'variance_percentage' : 'variancePercentage';
      const allSafe = (canonResults ?? []).every((r) => r[varField] === null || (typeof r[varField] === 'number' && Math.abs(r[varField]) <= 99999.9999));
      record('RET-A4', 'Every period\'s variance_percentage is either null or within the numeric(9,4) column bound (no silent truncation, no crash)', allSafe ? 'PASS' : 'FAIL', `rows=${canonResults?.length}, field=${varField}`);
    } else {
      record('RET-A3 (no-recalculation)', 'forecastRunId present in report provenance', 'FAIL', 'no forecastRunId in sourceReferences');
    }
  }

  // --- Case B: no retirement data at all -> must degrade safely, not crash ---
  {
    const { userId, cookie } = await makeUser('none');
    cleanupUsers.push(userId);
    await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', amount: 5000, frequency: 'monthly', is_active: true } });
    await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: userId, expense_name: 'Rent', amount: 1500, frequency: 'monthly', is_essential: true, expense_category: 'housing', is_active: true } });
    const genRes = await app('/api/reports/generate', { cookie, method: 'POST', body: { reportType: 'net_worth' } });
    const sections = (genRes.json?.data ?? genRes.json)?.sections ?? [];
    const retirementSection = sections.find((s) => s.sectionCode === 'retirement_readiness');
    record('RET-B1', 'Case B (no retirement account at all): report generation still succeeds (no crash)', genRes.status === 200 ? 'PASS' : 'FAIL', `status=${genRes.status}`);
    record('RET-B2', 'Case B: chapter safely unavailable with an explicit reason, no fabricated all-zero projection (RED->GREEN: this exact scenario rendered a 466-row all-$0 trajectory as "included" before this session\'s hasRetirement fix)', retirementSection?.sectionStatus === 'unavailable' && !!retirementSection?.limitationText ? 'PASS' : 'FAIL', retirementSection?.limitationText);
  }

  // --- Case C: retirement account present but no DOB (partial data) -> must degrade safely, not crash ---
  {
    const { userId, cookie } = await makeUser('partial');
    cleanupUsers.push(userId);
    await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', amount: 5000, frequency: 'monthly', is_active: true } });
    await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: userId, expense_name: 'Rent', amount: 1500, frequency: 'monthly', is_essential: true, expense_category: 'housing', is_active: true } });
    await sb('/rest/v1/retirement_accounts', { method: 'POST', body: { user_id: userId, account_name: 'Super', account_type: 'super', current_balance: 50000, currency_code: 'AUD', country_code: 'AU', is_active: true } });
    // deliberately no user_profiles row -> no DOB
    const genRes = await app('/api/reports/generate', { cookie, method: 'POST', body: { reportType: 'net_worth' } });
    const sections = (genRes.json?.data ?? genRes.json)?.sections ?? [];
    const retirementSection = sections.find((s) => s.sectionCode === 'retirement_readiness');
    record('RET-C1', 'Case C (retirement account, no DOB): report generation still succeeds (no crash)', genRes.status === 200 ? 'PASS' : 'FAIL', `status=${genRes.status}`);
    record('RET-C2', 'Case C: chapter reaches a defined state (included with a currentAge-independent timing signal, or safely unavailable) — never a silent crash', retirementSection?.sectionStatus === 'included' || retirementSection?.sectionStatus === 'unavailable' ? 'PASS' : 'FAIL', `status=${retirementSection?.sectionStatus}`);
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log('FAILED:', failed.map((f) => f.id).join(', '));
  fs.writeFileSync(path.join(repoRoot, 'scripts', 'r10-retirement-certification-results.json'), JSON.stringify(results, null, 2));
  process.exitCode = failed.length > 0 ? 1 : 0;
} finally {
  console.log('\n--- cleanup ---');
  for (const userId of cleanupUsers) {
    await sb(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
  }
  let leftover = 0;
  for (const userId of cleanupUsers) {
    const check = await sb(`/auth/v1/admin/users/${userId}`);
    if (check.status !== 404) leftover++;
  }
  console.log(`independently re-verified: ${leftover} leftover users (expected 0)`);
}
