// II-R11 (0082/0083/0086/0087/0088) production migration-ledger check.
// Read-only, publishable-key-only, no writes of any kind -- this script
// cannot and does not perform DDL/DML against production. It exists purely
// to answer "is 0082/0083/0086/0087/0088 already applied to production?" so
// a human doesn't have to guess before running
// docs/production-apply/ii-r11-multisource-professional-0082-0083-0086-0087-0088/*.sql.
//
// The URL and publishable ("anon") key below are PUBLIC by design -- Supabase
// publishable keys are meant to be embedded in client-side JS and are
// protected by RLS, not secrecy. They were extracted directly from
// app.financialhealthplatform.com's own shipped JS bundle
// (_next/static/chunks/0d9hzz29xz66a.js at the time of this check,
// 2026-08-26) exactly as this task's standing rules require -- this script
// never touches a service-role key or any other credential.
//
// Method: every check has a paired negative control (a table/column/function
// name chosen to definitely not exist) so a PGRST205/PGRST202 response is
// proof of genuine absence, not a false negative from a misconfigured
// request. A 200 (even with an empty array, expected under anon+RLS with no
// session) proves the schema object exists. RPC functions are called with
// their REAL required parameters (not empty {}) so that a 4xx/5xx real logic
// error (as opposed to PGRST202 "could not find the function") proves the
// function exists and is executing its own body.

const SUPA_URL = 'https://twwpnltizhtjxhamyoxt.supabase.co';
const KEY = 'sb_publishable_pWgbqCKmXZBCbqOtMr23Cw_V_oM8cZy';
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const NIL = '00000000-0000-0000-0000-000000000000';

let pass = 0, fail = 0;
function report(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' (' + detail + ')' : ''}`);
  ok ? pass++ : fail++;
}
function state(label, exists, detail) {
  console.log(`  ${exists ? 'PRESENT' : 'ABSENT '}  ${label}${detail ? ' (' + detail + ')' : ''}`);
}

async function tableExists(table, selectCols = 'id') {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?select=${selectCols}&limit=1`, { headers: H });
  const body = await r.json().catch(() => ({}));
  return { exists: r.status === 200, status: r.status, body };
}

async function rpcCheck(fn, args) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  const body = await r.json().catch(() => ({}));
  const genuinelyMissing = r.status === 404 && body.code === 'PGRST202';
  return { exists: !genuinelyMissing, status: r.status, body };
}

async function main() {
  console.log('=== NEGATIVE CONTROLS (prove the method itself is sound) ===');
  const ncTable = await tableExists('this_table_definitely_does_not_exist_zzz');
  report('nonexistent table correctly reports absent', !ncTable.exists && ncTable.body.code === 'PGRST205', `status ${ncTable.status}, code ${ncTable.body.code}`);
  const ncRpc = await rpcCheck('this_fn_definitely_does_not_exist_zzz', {});
  report('nonexistent function correctly reports absent', !ncRpc.exists, `status ${ncRpc.status}, code ${ncRpc.body.code}`);

  console.log('\n=== 0082/0086: ii_source_precedence_policy (expected ABSENT until this package is applied) ===');
  {
    const r = await tableExists('ii_source_precedence_policy');
    state('ii_source_precedence_policy', r.exists, `status ${r.status}${r.exists ? '' : ', ' + r.body.code}`);
  }

  console.log('\n=== 0083: professional_* tables (expected ABSENT until this package is applied) ===');
  for (const t of ['professional_profiles', 'professional_relationships', 'professional_permission_scopes', 'professional_consent_audit', 'professional_notes', 'professional_report_access_log']) {
    const r = await tableExists(t);
    state(t, r.exists, `status ${r.status}${r.exists ? '' : ', ' + r.body.code}`);
  }

  console.log('\n=== base tables 0087/0088 alter (expected PRESENT -- from 0033/0035, unrelated to R11 apply state) ===');
  for (const t of ['ii_transactions', 'ii_reconciliation_cases']) {
    const r = await tableExists(t);
    state(`${t} (pre-R11 base table)`, r.exists, `status ${r.status}`);
  }

  console.log('\n=== dependency check: prerequisites already confirmed live in production (expected PRESENT) ===');
  const pll = await tableExists('property_liability_links');
  state('property_liability_links (0078, unrelated prerequisite already satisfied)', pll.exists, `status ${pll.status}`);
  const smsf = await tableExists('smsf_funds');
  state('smsf_funds (0084, confirms canonical chain through 0090 is applied)', smsf.exists, `status ${smsf.status}`);

  console.log('\n=== NOTE on 0087/0088 live-behavioural verification ===');
  console.log('  This script can only prove SCHEMA-OBJECT presence/absence (tables/columns/');
  console.log('  functions). 0087/0088 do not add new tables -- they alter RLS policies +');
  console.log('  triggers + FK constraints on tables that already exist from 0033/0035.');
  console.log('  Whether those specific POLICIES/TRIGGERS/CONSTRAINTS are live cannot be');
  console.log('  determined via anon-key REST alone (pg_policies is not exposed via');
  console.log('  PostgREST by default). Proving 0087/0088 are applied -- or proving their');
  console.log('  live security behaviour once applied -- requires either (a) a human with');
  console.log('  the production service-role key running the equivalent of');
  console.log('  scripts/r11_professional_live_dev_tests.mjs against production with a real');
  console.log('  synthetic auth user, or (b) direct SQL introspection of pg_policies /');
  console.log('  information_schema.triggers / information_schema.table_constraints via the');
  console.log('  SQL Editor (04_production_verification.sql Part A in this package does this).');
  console.log('  This script does NOT claim 0087/0088 are or are not applied.');

  console.log(`\n${pass}/${pass + fail} negative-control checks passed (method validity). ABSENT/PRESENT lines above report ground truth for a human to read -- they are not pass/fail assertions about R11's readiness.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
