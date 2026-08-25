// SMSF/Jurisdiction (0084/0089/0090) production migration-ledger check.
// Read-only, anon-key-only, no writes of any kind -- this script cannot and
// does not perform DDL/DML against production. It exists purely to answer
// "is 0084 / 0089 / 0090 already applied to production?" so a human doesn't
// have to guess before running docs/production-apply/smsf-jurisdiction-
// 0084-0089-0090/*.sql.
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
// name chosen to definitely not exist) so a PGRST404/PGRST205/PGRST202/42703
// response is proof of genuine absence, not a false negative from a
// misconfigured request. A 200 (even with an empty array, expected under
// anon+RLS with no session) proves the schema object exists.

const SUPA_URL = 'https://twwpnltizhtjxhamyoxt.supabase.co';
const KEY = 'sb_publishable_pWgbqCKmXZBCbqOtMr23Cw_V_oM8cZy';
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

let pass = 0, fail = 0;
function report(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' (' + detail + ')' : ''}`);
  ok ? pass++ : fail++;
}

async function tableExists(table, selectCols = 'id') {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?select=${selectCols}&limit=1`, { headers: H });
  const body = await r.json().catch(() => ({}));
  return { exists: r.status === 200, status: r.status, body };
}

async function rpcExists(fn) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}',
  });
  const body = await r.json().catch(() => ({}));
  // PGRST202 = "could not find the function" (genuinely absent).
  // Any other code/status (400 bad-args, 401/403 auth, 500, etc.) means the
  // function WAS found and is now rejecting our empty-arg anonymous call.
  const genuinelyMissing = r.status === 404 && body.code === 'PGRST202';
  return { exists: !genuinelyMissing, status: r.status, body };
}

async function main() {
  console.log('=== NEGATIVE CONTROLS (prove the method itself is sound) ===');
  const ncTable = await tableExists('this_table_definitely_does_not_exist_zzz');
  report('nonexistent table correctly reports absent', !ncTable.exists && ncTable.body.code === 'PGRST205', `status ${ncTable.status}, code ${ncTable.body.code}`);
  const ncRpc = await rpcExists('this_fn_definitely_does_not_exist_zzz');
  report('nonexistent function correctly reports absent', !ncRpc.exists, `status ${ncRpc.status}, code ${ncRpc.body.code}`);

  console.log('\n=== 0084: tables ===');
  for (const t of ['smsf_funds', 'smsf_fund_members', 'smsf_holdings']) {
    const r = await tableExists(t);
    report(`${t} exists`, r.exists, `status ${r.status}${r.exists ? '' : ', ' + r.body.code}`);
  }

  console.log('\n=== 0084: master_financial_items.country_applicability column ===');
  const col = await tableExists('master_financial_items', 'item_key,country_applicability');
  report('country_applicability column exists', col.exists, `status ${col.status}${col.exists ? '' : ', ' + col.body.code}`);

  console.log('\n=== 0084/0089/0090: RPC functions ===');
  for (const fn of ['smsf_create_fund', 'smsf_switch_to_detailed', 'smsf_switch_to_summary']) {
    const r = await rpcExists(fn);
    report(`${fn} exists`, r.exists, `status ${r.status}${r.exists ? '' : ', ' + r.body.code}`);
  }

  console.log('\n=== dependency check: 0078 property_liability_links (prerequisite for 0084) ===');
  const pll = await tableExists('property_liability_links');
  report('property_liability_links exists (0084 prerequisite satisfied)', pll.exists, `status ${pll.status}`);

  console.log(`\n${pass} checks confirming state, ${fail} unexpected. This script does not assert pass/fail on 0084/0089/0090 presence itself -- it reports ground truth for a human to read.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
