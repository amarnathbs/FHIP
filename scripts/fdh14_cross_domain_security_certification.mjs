// FDH-14 — fresh, live-DEV cross-domain security proof.
// Two synthetic tenants (A, B). For income_sources / liabilities /
// retirement_accounts: (1) same-tenant provenance-column forgery is BLOCKED,
// (2) legitimate own-field edit still succeeds (positive control),
// (3) cross-tenant read returns 0 rows, (4) cross-tenant write is blocked,
// (5) cross-tenant impersonating INSERT (user_id = victim) is blocked.
// Every row + both auth users are deleted at the end; deletion is
// independently re-verified by re-query. NO existing DEV data is touched.
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const TAG = 'fdh14-cert';

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' ' + detail : ''}`); }
};

async function rest(p, opts = {}, key = SERVICE) {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: opts.prefer ?? 'return=representation', ...opts.headers };
  const r = await fetch(`${URL_}/rest/v1/${p}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
/** PostgREST as a real authenticated end user: apikey is always the ANON
 * project key; the user's own access token carries identity/role via
 * Authorization. Passing the user token as `key` (as an earlier revision of
 * this script did) breaks the `apikey` header and produces a blanket 401 that
 * looks like — but is NOT — an RLS denial. */
async function userRest(token, p, opts = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: opts.prefer ?? 'return=representation', ...opts.headers };
  const r = await fetch(`${URL_}/rest/v1/${p}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function createUser(tag) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const slug = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const email = `${TAG}-${slug}-${stamp}@fhip-test.invalid`;
  const password = `Fdh14Live!${stamp}`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser ${tag} failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await rest(`user_profiles?user_id=eq.${j.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      full_name: `FDH14 Cert ${tag}`, country_of_residence: 'AU', preferred_currency: 'AUD',
      onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100,
      country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now,
    }),
  });
  const signIn = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const sj = await signIn.json();
  if (!sj.access_token) throw new Error(`sign-in ${tag} failed: ${JSON.stringify(sj).slice(0, 300)}`);
  return { id: j.id, email, token: sj.access_token };
}

async function deleteUser(id) {
  await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
}

const state = { seeded: {}, users: [] };

async function testDomain(domain, table, seedBody, sourceTypeCurrent, sourceTypeForged, ownFieldPatch, ownFieldCheck) {
  console.log(`\n=== ${domain} (${table}) — fresh FDH-14 live-DEV cross-tenant + authority proof ===`);
  const A = await createUser(`${domain}-a`);
  const B = await createUser(`${domain}-b`);
  state.users.push(A.id, B.id);

  const seed = await rest(table, { method: 'POST', body: JSON.stringify({ user_id: A.id, ...seedBody }) });
  const row = seed.json?.[0];
  if (!row) { check(`${domain}: setup seed insert succeeded`, false, seed.text.slice(0, 200)); return; }
  state.seeded[table] = [...(state.seeded[table] ?? []), row.id];
  check(`${domain}: setup — seeded row exists with expected default source_type`, row.source_type === sourceTypeCurrent || (sourceTypeCurrent === null && (row.source_type === null || row.source_type === undefined)), `source_type=${row.source_type}`);

  // --- Same-tenant authority forgery ---------------------------------
  const forge1 = await userRest(A.token, `${table}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ source_type: sourceTypeForged }) });
  const after1 = (await rest(`${table}?id=eq.${row.id}&select=source_type`)).json?.[0];
  check(`${domain}: owner FORGES source_type -> BLOCKED`, after1?.source_type !== sourceTypeForged, `patch_status=${forge1.status} now=${after1?.source_type} text=${forge1.text.slice(0, 120)}`);

  const fakeAppId = '00000000-0000-0000-0000-000000000001';
  const forge2 = await userRest(A.token, `${table}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ last_import_application_id: fakeAppId }) });
  const after2 = (await rest(`${table}?id=eq.${row.id}&select=last_import_application_id`)).json?.[0];
  check(`${domain}: owner FORGES last_import_application_id -> BLOCKED`, after2?.last_import_application_id !== fakeAppId, `patch_status=${forge2.status} now=${after2?.last_import_application_id}`);

  const forge3 = await userRest(A.token, `${table}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ last_imported_at: '2001-09-09T01:46:40+00:00' }) });
  const after3 = (await rest(`${table}?id=eq.${row.id}&select=last_imported_at`)).json?.[0];
  check(`${domain}: owner FORGES last_imported_at -> BLOCKED`, !after3?.last_imported_at || !after3.last_imported_at.startsWith('2001-09-09'), `patch_status=${forge3.status} now=${after3?.last_imported_at}`);

  // --- Positive control: legit own-field edit still works ---
  const ok = await userRest(A.token, `${table}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(ownFieldPatch) });
  const okRow = ok.json?.[0];
  check(`${domain}: POSITIVE CONTROL — owner's legitimate own-field edit still succeeds`, ok.status < 300 && okRow && ownFieldCheck(okRow), `status=${ok.status} ${ok.text.slice(0, 150)}`);

  // --- Cross-tenant READ ---
  const bRead = await userRest(B.token, `${table}?id=eq.${row.id}`);
  check(`${domain}: cross-tenant READ returns 0 rows (B reading A's row)`, Array.isArray(bRead.json) && bRead.json.length === 0, `status=${bRead.status} rows=${bRead.json?.length}`);

  // --- Cross-tenant WRITE ---
  const bWrite = await userRest(B.token, `${table}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
  const stillActive = (await rest(`${table}?id=eq.${row.id}&select=is_active`)).json?.[0];
  check(`${domain}: cross-tenant WRITE BLOCKED (B patching A's row leaves it unchanged)`, stillActive?.is_active !== false, `status=${bWrite.status} rows_returned=${bWrite.json?.length ?? 0} is_active_now=${stillActive?.is_active}`);

  // --- Cross-tenant impersonating INSERT (B inserts a row claiming user_id=A) ---
  const impersonate = await userRest(B.token, table, { method: 'POST', body: JSON.stringify({ user_id: A.id, ...seedBody }) });
  const impersonateBlocked = impersonate.status >= 400 || !impersonate.json?.[0];
  check(`${domain}: cross-tenant IMPERSONATING INSERT BLOCKED (B cannot create a row claiming user_id=A)`, impersonateBlocked, `status=${impersonate.status} ${impersonate.text.slice(0, 150)}`);
  if (impersonate.json?.[0]?.id) state.seeded[table].push(impersonate.json[0].id);

  // --- Cross-tenant DELETE ---
  const bDelete = await userRest(B.token, `${table}?id=eq.${row.id}`, { method: 'DELETE' });
  const stillThere = (await rest(`${table}?id=eq.${row.id}&select=id`)).json?.[0];
  check(`${domain}: cross-tenant DELETE BLOCKED (B cannot delete A's row)`, Boolean(stillThere), `status=${bDelete.status} rows_returned=${bDelete.json?.length ?? 0}`);
}

async function main() {
  await testDomain('Income (FDH-9 canonical)', 'income_sources',
    { source_name: 'FDH14 cert salary', income_type: 'salary', amount: '5000.00', frequency: 'monthly', currency_code: 'AUD', is_active: true },
    'manual', 'payslip_import',
    { source_name: 'FDH14 cert salary (renamed)' }, (r) => r.source_name === 'FDH14 cert salary (renamed)');

  await testDomain('Liabilities (FDH-10 canonical)', 'liabilities',
    { liability_name: 'FDH14 cert mortgage', debt_type: 'mortgage', balance: '400000.00', currency_code: 'AUD', is_active: true },
    null, 'retirement_statement_import' /* wrong-domain value on purpose; any non-current value proves the guard */,
    { liability_name: 'FDH14 cert mortgage (renamed)' }, (r) => r.liability_name === 'FDH14 cert mortgage (renamed)');

  await testDomain('Retirement (FDH-12 canonical)', 'retirement_accounts',
    { account_name: 'FDH14 cert super', account_type: 'super', current_balance: '200000.00', currency_code: 'AUD', is_active: true },
    'manual', 'retirement_statement_import',
    { account_name: 'FDH14 cert super (renamed)' }, (r) => r.account_name === 'FDH14 cert super (renamed)');

  // --- Cleanup ---------------------------------------------------------
  console.log('\n=== CLEANUP ===');
  for (const [table, ids] of Object.entries(state.seeded)) {
    for (const id of ids) {
      await rest(`${table}?id=eq.${id}`, { method: 'DELETE' });
    }
  }
  for (const id of state.users) await deleteUser(id);

  // --- Independent re-verification of cleanup ---------------------------
  let residue = 0;
  for (const [table, ids] of Object.entries(state.seeded)) {
    for (const id of ids) {
      const r = await rest(`${table}?id=eq.${id}&select=id`);
      if (r.json?.length) residue++;
    }
  }
  for (const id of state.users) {
    const r = await fetch(`${URL_}/auth/v1/admin/users/${id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    if (r.status === 200) residue++;
  }
  check('CLEANUP: independent re-query confirms zero synthetic residue', residue === 0, `residue=${residue}`);

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
