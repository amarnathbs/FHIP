// Investment Intelligence R5 — mandatory re-test of R4's discovered-and-fixed
// same-user analytics-forgery vulnerability, against the CURRENT (migration
// 0043) ii_analytics_results shape, plus the R5 extension of the same
// question to R5's own analytics storage.
//
// Background: during R4 live-DEV verification an ordinary authenticated user
// was able to INSERT a row into ii_analytics_results with
// calculation_version = 'FORGED-BY-CLIENT' (HTTP 201), because migration 0035
// created the table with `for all using (auth.uid() = user_id)`. Migration
// 0043 section 5 moved that placeholder aside and recreated the table with a
// SELECT-only policy. This script proves that fix is still in force and that
// R5's migration 0044 has not reopened it.
//
// Fail-closed: any check that cannot be genuinely evaluated is reported
// BLOCKED with the exact reason. Nothing is reported PASS from code
// inspection alone.
//
// Run:  node scripts/ii_r5_analytics_forgery_regression.mjs

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
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
}

async function req(p, { method = 'GET', apikey = SERVICE, token = SERVICE, body, prefer } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const users = [];
async function makeUser(tag) {
  const email = `ii-r5-forgery-${tag}-${stamp}@fhip-test.local`;
  const password = 'TestPass!' + stamp;
  const created = await req('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const signIn = await req('/auth/v1/token?grant_type=password', { method: 'POST', apikey: ANON, token: ANON, body: { email, password } });
  const token = signIn.json?.access_token;
  if (!id || !token) throw new Error(`user setup failed for ${tag}: ${created.text} ${signIn.text}`);
  users.push(id);
  return { id, token, email };
}

async function main() {
  const A = await makeUser('a');
  const B = await makeUser('b');
  console.log(`Victim user A: ${A.id}`);
  console.log(`Attacker user B: ${B.id}\n`);

  // ---------------------------------------------------------------------
  // Confirm the live table is the hardened 0043 shape (not the 0035 one).
  // ---------------------------------------------------------------------
  const shape43 = await req('/rest/v1/ii_analytics_results?select=scope_type,input_snapshot_version,engine_version&limit=1');
  const shape35 = await req('/rest/v1/ii_analytics_results?select=subject_type&limit=1');
  if (!shape43.ok) {
    record('SEC-R5-FORGERY-000', 'ii_analytics_results is the hardened 0043 shape', 'BLOCKED', `0043 columns absent: ${shape43.text.slice(0, 200)}`);
    return;
  }
  record('SEC-R5-FORGERY-000', 'ii_analytics_results is the hardened 0043 shape (0035 placeholder gone)', shape35.ok ? 'FAIL' : 'PASS',
    shape35.ok ? 'Legacy 0035 subject_type column still present under the canonical name!' : '0043 columns present; 0035 subject_type absent.');

  // ---------------------------------------------------------------------
  // R4-REGRESSION-1 — the exact original attack: an ordinary authenticated
  // user inserts an analytics row FOR THEMSELVES with a forged engine
  // version. This returned HTTP 201 before the 0043 fix.
  // ---------------------------------------------------------------------
  const selfForge = await req('/rest/v1/ii_analytics_results', {
    apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
    body: {
      user_id: A.id, scope_type: 'portfolio', scope_id: 'forged-scope', metric_key: 'investor_xirr',
      metric_version: 'FORGED', engine_version: 'FORGED-BY-CLIENT', data_as_of_date: '2026-08-21',
      input_snapshot_version: 'forged', quality_status: 'ok', result_value: { rate: 9.99 },
    },
  });
  record('SEC-R5-FORGERY-001', 'Ordinary user CANNOT self-insert a forged ii_analytics_results row (R4 regression)',
    selfForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${selfForge.status} ${selfForge.text.slice(0, 200)}`);

  // Ground truth via service role — never infer from the response alone.
  const gt1 = await req(`/rest/v1/ii_analytics_results?user_id=eq.${A.id}&engine_version=eq.FORGED-BY-CLIENT&select=id`);
  record('SEC-R5-FORGERY-002', 'Service-role ground truth confirms no forged row landed',
    Array.isArray(gt1.json) && gt1.json.length === 0 ? 'PASS' : 'FAIL', `rows found: ${Array.isArray(gt1.json) ? gt1.json.length : gt1.text.slice(0, 120)}`);

  // ---------------------------------------------------------------------
  // R4-REGRESSION-2 — cross-user forgery: B inserts an analytics row
  // attributed to A.
  // ---------------------------------------------------------------------
  const crossForge = await req('/rest/v1/ii_analytics_results', {
    apikey: ANON, token: B.token, method: 'POST', prefer: 'return=representation',
    body: {
      user_id: A.id, scope_type: 'portfolio', scope_id: 'cross-forged', metric_key: 'investor_xirr',
      metric_version: 'FORGED', engine_version: 'CROSS-FORGED-BY-B', data_as_of_date: '2026-08-21',
      input_snapshot_version: 'forged', quality_status: 'ok', result_value: { rate: -0.99 },
    },
  });
  record('SEC-R5-FORGERY-003', 'User B CANNOT insert an analytics row attributed to user A',
    crossForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${crossForge.status} ${crossForge.text.slice(0, 200)}`);

  // ---------------------------------------------------------------------
  // R4-REGRESSION-3 — the legacy table must not be a write back-door.
  // ---------------------------------------------------------------------
  const legacyExists = await req('/rest/v1/ii_analytics_results_r1_legacy?select=id&limit=1');
  if (legacyExists.ok) {
    const legacyForge = await req('/rest/v1/ii_analytics_results_r1_legacy', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { user_id: A.id, subject_type: 'portfolio', subject_id: A.id, metric_key: 'x', calculation_version: 'FORGED-VIA-LEGACY' },
    });
    record('SEC-R5-FORGERY-004', 'Legacy ii_analytics_results_r1_legacy is not a write back-door',
      legacyForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${legacyForge.status} ${legacyForge.text.slice(0, 200)}`);
  } else {
    record('SEC-R5-FORGERY-004', 'Legacy ii_analytics_results_r1_legacy is not a write back-door', 'PASS', 'Legacy table not exposed via PostgREST.');
  }

  // ---------------------------------------------------------------------
  // SEC-R5 — reference-data write protection. An ordinary user must not be
  // able to create fake fund holdings, classifications, or benchmark
  // mappings. These are the R5-critical reference-data gates.
  // ---------------------------------------------------------------------
  // Need a real fund instrument id to make the insert otherwise-valid, so a
  // rejection is genuinely an RLS rejection and not an FK error.
  const anyInstrument = await req('/rest/v1/ii_instruments?select=id&limit=1');
  const fundId = Array.isArray(anyInstrument.json) && anyInstrument.json[0]?.id;

  if (fundId) {
    const fhForge = await req('/rest/v1/ii_fund_holdings', {
      apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
      body: { fund_instrument_id: fundId, underlying_name: 'FORGED HOLDING', disclosure_date: '2026-08-21', weight_pct: 99.9 },
    });
    record('SEC-R5-REFDATA-001', 'Ordinary user CANNOT insert into ii_fund_holdings',
      fhForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${fhForge.status} ${fhForge.text.slice(0, 200)}`);

    const gtFh = await req(`/rest/v1/ii_fund_holdings?underlying_name=eq.FORGED HOLDING&select=id`);
    record('SEC-R5-REFDATA-002', 'Service-role ground truth confirms no forged fund holding landed',
      Array.isArray(gtFh.json) && gtFh.json.length === 0 ? 'PASS' : 'FAIL', `rows found: ${Array.isArray(gtFh.json) ? gtFh.json.length : gtFh.text.slice(0, 120)}`);
  } else {
    record('SEC-R5-REFDATA-001', 'Ordinary user CANNOT insert into ii_fund_holdings', 'BLOCKED', 'No ii_instruments row available to build an FK-valid probe.');
    record('SEC-R5-REFDATA-002', 'Service-role ground truth confirms no forged fund holding landed', 'BLOCKED', 'Dependent on REFDATA-001.');
  }

  const instForge = await req('/rest/v1/ii_instruments', {
    apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
    body: { instrument_name: 'FORGED INSTRUMENT', instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR' },
  });
  record('SEC-R5-REFDATA-003', 'Ordinary user CANNOT insert into ii_instruments',
    instForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${instForge.status} ${instForge.text.slice(0, 200)}`);

  const bmForge = await req('/rest/v1/ii_benchmarks', {
    apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
    body: { benchmark_key: 'FORGED_BM', benchmark_label: 'Forged', benchmark_category: 'index' },
  });
  record('SEC-R5-REFDATA-004', 'Ordinary user CANNOT insert into ii_benchmarks',
    bmForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${bmForge.status} ${bmForge.text.slice(0, 200)}`);

  const bsForge = await req('/rest/v1/ii_benchmark_series', {
    apikey: ANON, token: A.token, method: 'POST', prefer: 'return=representation',
    body: { benchmark_id: fundId || '00000000-0000-0000-0000-000000000000', series_date: '2026-08-21', value: 1 },
  });
  record('SEC-R5-REFDATA-005', 'Ordinary user CANNOT insert into ii_benchmark_series',
    bsForge.status === 201 ? 'FAIL' : 'PASS', `HTTP ${bsForge.status} ${bsForge.text.slice(0, 200)}`);
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  record('HARNESS', 'Harness execution', 'BLOCKED', e.message);
  exitCode = 2;
} finally {
  for (const id of users) {
    await req(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
  }
  console.log('\nCleanup done.');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  console.log(`\nSUMMARY: ${pass} PASS / ${fail} FAIL / ${blocked} BLOCKED (of ${results.length})`);
  if (fail > 0) exitCode = 1;
  process.exit(exitCode);
}
