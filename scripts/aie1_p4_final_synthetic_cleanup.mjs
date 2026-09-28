// Mission part 4, section 18 -- final synthetic-manifest cleanup + verified-
// absent checks (not just issuing DELETE and trusting it) for every
// synthetic account/record THIS dispatch (part 4) created on DEV. (The
// section 17 production cross-tenant probe already cleaned up and verified
// its own two production users in-script -- re-verified again here too for
// belt-and-braces.)
import fs from 'node:fs';

function loadEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return env;
}
const env = loadEnv('D:/FHIP/.env.local');
const DEV = { url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY };
const PROD = { url: env.PRODUCTION_SUPABASE_URL, key: env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY };

async function call(target, p, { method = 'GET', headers: extra } = {}) {
  const res = await fetch(`${target.url}${p}`, { method, headers: { apikey: target.key, Authorization: `Bearer ${target.key}`, 'Content-Type': 'application/json', ...(extra ?? {}) } });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: res.status, json, text };
}

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
}

// DEV: 4 synthetic auth users from the section-15 eligibility proof
// (2 aborted attempts during script debugging that never got past 401 --
// b72e1d54, 4df9cf35 -- and 2 that succeeded and each created one
// fdh_statement_uploads + one fdh_financial_accounts row -- f3bb86e6 ->
// document a78775aa / account 97074905, and dfcb0092 -> document 5db9f164 /
// account f66be530, per this run's own console output and manifest).
const DEV_USERS = ['b72e1d54-ceda-4263-80b2-0ab61ee6a705', '4df9cf35-8539-4133-8435-7ee7e2ddb2fa', 'f3bb86e6-31e6-4a8c-8273-73f6b5ad714d', 'dfcb0092-5622-4dea-a9f2-b2b466455966'];
const DEV_UPLOADS = ['a78775aa-84a3-4da5-9d8e-529abb562d64', '5db9f164-81d8-45e3-832c-f32df2882636'];
const DEV_ACCOUNTS = ['97074905-945f-4206-8851-27d32337ac2c', 'f66be530-0881-4def-bcdf-6edb69f4eeaf'];
// The two review-inbox-a11y users (5a9ae027, 9a085cfa) already self-cleaned
// in-script -- re-verify absence below, no delete needed.
const DEV_ALREADY_SELF_CLEANED = ['5a9ae027-aff5-4905-8414-3f9d629d5f6c', '9a085cfa-23ed-4c36-a932-349ee819af45'];
// PRODUCTION: the two cross-tenant-denial users, already deleted +
// verified in-script -- re-verify again here.
const PROD_USERS_ALREADY_CLEANED = ['3b0045cc-6bf0-4316-bc6f-92ef49aad08d', 'b238bea8-c967-45c1-aa70-3a5d97178bd6'];

async function main() {
  console.log('--- DEV cleanup ---');
  for (const id of DEV_UPLOADS) {
    const del = await call(DEV, `/rest/v1/fdh_statement_uploads?id=eq.${id}`, { method: 'DELETE' });
    console.log(`  delete fdh_statement_uploads ${id}: HTTP ${del.status}`);
  }
  for (const id of DEV_ACCOUNTS) {
    const del = await call(DEV, `/rest/v1/fdh_financial_accounts?id=eq.${id}`, { method: 'DELETE' });
    console.log(`  delete fdh_financial_accounts ${id}: HTTP ${del.status}`);
  }
  for (const id of DEV_USERS) {
    const del = await call(DEV, `/auth/v1/admin/users/${id}`, { method: 'DELETE' });
    console.log(`  delete auth user ${id}: HTTP ${del.status}`);
  }

  console.log('\n--- DEV verified-absent checks ---');
  for (const id of DEV_UPLOADS) {
    const r = await call(DEV, `/rest/v1/fdh_statement_uploads?id=eq.${id}&select=id`);
    check(`fdh_statement_uploads ${id} absent`, Array.isArray(r.json) && r.json.length === 0, JSON.stringify(r.json));
  }
  for (const id of DEV_ACCOUNTS) {
    const r = await call(DEV, `/rest/v1/fdh_financial_accounts?id=eq.${id}&select=id`);
    check(`fdh_financial_accounts ${id} absent`, Array.isArray(r.json) && r.json.length === 0, JSON.stringify(r.json));
  }
  for (const id of [...DEV_USERS, ...DEV_ALREADY_SELF_CLEANED]) {
    const r = await call(DEV, `/auth/v1/admin/users/${id}`);
    check(`DEV auth user ${id} absent (404)`, r.status === 404, `HTTP ${r.status}`);
  }

  console.log('\n--- PRODUCTION re-verified-absent checks ---');
  for (const id of PROD_USERS_ALREADY_CLEANED) {
    const r = await call(PROD, `/auth/v1/admin/users/${id}`);
    check(`PRODUCTION auth user ${id} absent (404)`, r.status === 404, `HTTP ${r.status}`);
  }
  const prodProbeRow = await call(PROD, `/rest/v1/income_sources?source_name=eq.section17-cross-tenant-probe&select=id`);
  check('PRODUCTION: zero income_sources rows named section17-cross-tenant-probe remain', Array.isArray(prodProbeRow.json) && prodProbeRow.json.length === 0, JSON.stringify(prodProbeRow.json));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
