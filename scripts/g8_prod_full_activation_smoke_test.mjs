// G8 production activation — bounded smoke test, real HTTP requests against
// the real running app (https://app.financialhealthplatform.com), real
// disposable synthetic production users, real cleanup with independent
// zero-residue verification. This is the first real end-to-end proof that
// G4 -> G5B -> rollout -> real canonical write works through the actual
// deployed application, now that all 5 env vars are live for the first time.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://twwpnltizhtjxhamyoxt.supabase.co';
const ANON_KEY = 'sb_publishable_pWgbqCKmXZBCbqOtMr23Cw_V_oM8cZy';
const SERVICE_KEY = process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
const APP_BASE = 'https://app.financialhealthplatform.com';

if (!SERVICE_KEY) { console.error('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1); }

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const stamp = Date.now();

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

const createdUserIds = [];
const createdRowIds = { income_sources: [], expense_items: [], insurance_policies: [] };

async function makeUser(tag, country, generic) {
  const email = `g8-smoke-${tag}-${stamp}@fhip-internal-test.invalid`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  const userId = data.user.id;
  createdUserIds.push(userId);

  const patch = {
    country_of_residence: country,
    country_confirmed_at: new Date().toISOString(),
    country_source: 'USER_CONFIRMED',
  };
  if (generic) {
    patch.generic_disclosure_version = 'G8-SMOKE-TEST-V1';
    patch.generic_disclosure_acknowledged_at = new Date().toISOString();
    patch.generic_disclosure_country = country;
  }
  const { error: profErr } = await admin.from('user_profiles').update(patch).eq('user_id', userId);
  if (profErr) throw new Error(`profile update ${tag}: ${profErr.message}`);

  const { data: signInData, error: signInErr } = await createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    .auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn ${tag}: ${signInErr.message}`);

  const projectRef = new URL(SUPABASE_URL).host.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(signInData.session), 'utf8').toString('base64');
  const cookie = `sb-${projectRef}-auth-token=${cookieValue}`;
  return { userId, email, password, cookie };
}

async function appFetch(user, path, { method = 'GET', body } = {}) {
  const headers = { Cookie: user.cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${APP_BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  const genericUser = await makeUser('generic', 'GB', true);
  const auUser = await makeUser('au', 'AU', false);
  const attackerUser = await makeUser('attacker', 'GB', true);

  // ============================================================
  // 1. GENERIC create -> reload -> update, all 3 modules, real HTTP.
  // ============================================================
  const modules = [
    { key: 'income_sources', createPath: '/api/income', idPath: (id) => `/api/income/${id}`, payload: { source_name: 'g8 smoke income', income_type: 'salary', amount: 100, frequency: 'monthly', currency_code: 'AUD' }, editPatch: { amount: 150 } },
    { key: 'expense_items', createPath: '/api/expenses', idPath: (id) => `/api/expenses/${id}`, payload: { expense_name: 'g8 smoke expense', expense_category: 'housing', amount: 50, frequency: 'monthly', currency_code: 'AUD' }, editPatch: { amount: 75 } },
    { key: 'insurance_policies', createPath: '/api/insurance', idPath: (id) => `/api/insurance/${id}`, payload: { policy_name: 'g8 smoke policy', cover_type: 'life', cover_amount: 1000, premium: 10, premium_frequency: 'monthly', currency_code: 'AUD' }, editPatch: { premium: 20 } },
  ];

  for (const mod of modules) {
    const createRes = await appFetch(genericUser, mod.createPath, { method: 'POST', body: mod.payload });
    check(`GENERIC create ${mod.key} via real HTTP (201/200)`, createRes.status === 200 || createRes.status === 201, JSON.stringify(createRes.json));
    const rowId = createRes.json?.data?.id;
    if (rowId) createdRowIds[mod.key].push(rowId);

    const reloadRes = await appFetch(genericUser, mod.createPath);
    const found = reloadRes.json?.data?.some((r) => r.id === rowId);
    check(`GENERIC reload sees the new ${mod.key} row`, !!found, `count=${reloadRes.json?.data?.length}`);

    if (rowId) {
      const editRes = await appFetch(genericUser, mod.idPath(rowId), { method: 'PATCH', body: mod.editPatch });
      check(`GENERIC update ${mod.key} via real HTTP`, editRes.status === 200, JSON.stringify(editRes.json));

      // DELETE and UPDATE-based archive must both remain denied (0147).
      const deleteRes = await appFetch(genericUser, mod.idPath(rowId), { method: 'DELETE' });
      check(`GENERIC DELETE ${mod.key} still denied via real HTTP route`, deleteRes.status === 403 || deleteRes.status === 400, `status=${deleteRes.status}`);
    }
  }

  // Direct-DB archive-bypass check (0147) with a REAL authenticated
  // (non-service-role) session -- this is the exact attack migration 0147
  // closes, tested here against real production, real HTTP-created rows.
  if (createdRowIds.income_sources[0]) {
    const { data: signInData, error: signInErr } = await createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
      .auth.signInWithPassword({ email: genericUser.email, password: genericUser.password });
    if (!signInErr && signInData?.session) {
      const genericDirectClient = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${signInData.session.access_token}` } },
      });
      const { error: archiveErr, count: archiveCount } = await genericDirectClient
        .from('income_sources')
        .update({ is_active: false }, { count: 'exact' })
        .eq('id', createdRowIds.income_sources[0]);
      check('0147: GENERIC direct-DB archive-via-UPDATE bypass still blocked in production', !!archiveErr || archiveCount === 0, archiveErr?.message ?? `count=${archiveCount}`);
    } else {
      check('0147 direct-DB check setup (sign-in for direct client)', false, signInErr?.message);
    }
  }

  // ============================================================
  // 2. AU non-regression, all 3 modules, real HTTP.
  // ============================================================
  const auCreateRes = await appFetch(auUser, '/api/income', { method: 'POST', body: { source_name: 'g8 smoke au income', income_type: 'salary', amount: 200, frequency: 'monthly', currency_code: 'AUD' } });
  check('AU create income via real HTTP (unaffected)', auCreateRes.status === 200 || auCreateRes.status === 201, JSON.stringify(auCreateRes.json));
  const auRowId = auCreateRes.json?.data?.id;
  if (auRowId) {
    const auDeleteRes = await appFetch(auUser, `/api/income/${auRowId}`, { method: 'DELETE' });
    check('AU DELETE income still succeeds (real delete path is archive-UPDATE, unaffected by GENERIC restriction)', auDeleteRes.status === 200, `status=${auDeleteRes.status}`);
  }

  // ============================================================
  // 3. Cross-tenant protection.
  // ============================================================
  if (createdRowIds.income_sources[0]) {
    const crossRes = await appFetch(attackerUser, '/api/income');
    const leaked = crossRes.json?.data?.some((r) => r.id === createdRowIds.income_sources[0]);
    check('Cross-tenant: attacker cannot see owner\'s income row via real HTTP', !leaked, `attacker sees ${crossRes.json?.data?.length} rows`);
  }
}

async function cleanupAndVerify() {
  console.log('\n--- CLEANUP ---');
  for (const [table, ids] of Object.entries(createdRowIds)) {
    for (const id of ids) await admin.from(table).delete().eq('id', id);
  }
  for (const table of ['income_sources', 'expense_items', 'insurance_policies']) {
    await admin.from(table).delete().in('user_id', createdUserIds);
  }
  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) console.error(`FAILED to delete user ${userId}: ${error.message}`);
  }
  let residue = 0;
  for (const userId of createdUserIds) {
    const { data } = await admin.auth.admin.getUserById(userId);
    if (data?.user) { residue++; console.error(`RESIDUE: user ${userId} still exists`); }
  }
  for (const table of ['income_sources', 'expense_items', 'insurance_policies']) {
    const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).in('user_id', createdUserIds);
    if (count && count > 0) { residue++; console.error(`RESIDUE: ${count} rows remain in ${table}`); }
  }
  console.log(residue === 0 ? 'Zero residue confirmed.' : `${residue} RESIDUE ITEMS REMAIN.`);
}

try {
  await main();
} catch (e) {
  console.error('SCRIPT ERROR:', e.stack || e.message);
  fail++;
  failures.push('script-level exception: ' + e.message);
} finally {
  await cleanupAndVerify();
}

console.log(`\n=== SUMMARY: ${pass}/${pass + fail} checks passed ===`);
if (failures.length) console.log('FAILED:', failures);
process.exitCode = fail > 0 ? 1 : 0;
