// AIE-1 live-DEV verification pass -- cross-tenant RLS METHOD proof.
//
// The AIE-1 tables (aie_document_intake etc., migrations 0140-0145) do not
// exist yet in this DEV project (confirmed separately: no DDL execution
// path is available in this sandbox -- no exec_sql/execute_sql/run_sql/
// admin_exec RPC, no Management API token, no direct Postgres connection
// string, no `supabase login` session -- matching this repo's own repeated
// prior disclosure of the identical limitation, e.g.
// scripts/r11_professional_live_dev_tests.mjs's sibling probes and
// scripts/ii_r5_schema_probe.mjs / scripts/ii_r6p1_schema_probe.mjs).
//
// So this script proves the NEGATIVE-CONTROL METHOD itself is sound
// (real disposable synthetic users, real password sign-in, real PostgREST
// calls with a real user JWT, not the service-role client) against an
// EXISTING RLS-protected table (`households`, migration 0001) that has the
// exact same `auth.uid() = user_id` shape the AIE-1 tables' own policies
// use. It does NOT and cannot prove the AIE-1 tables' policies specifically
// -- those tables don't exist yet.
//
// Full cleanup + independent re-verification at the end (deletes the
// synthetic households row and both synthetic users, then re-queries to
// confirm zero residue).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const CERTIFIED_DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
if (!BASE.includes(CERTIFIED_DEV_PROJECT_REF)) { console.error('REFUSING: not certified DEV project'); process.exit(1); }
if (env.PRODUCTION_SUPABASE_URL || env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY) {
  console.error('REFUSING: PRODUCTION_-prefixed vars must not be present in this script\'s env at all.');
  process.exit(1);
}

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} -- ${description}`);
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 500)}`);
}

async function svc(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function asUser(accessToken, p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
async function makeUser(tag) {
  const email = `aie1-livedev-${tag}-${stamp}@fhip-test.invalid`;
  const password = `TestPass!${stamp}Aa1${tag}`;
  const created = await svc('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  if (!id) throw new Error(`createUser failed for ${tag}: ${created.text}`);
  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await tokenRes.json();
  if (!session?.access_token) throw new Error(`sign-in failed for ${tag}: ${JSON.stringify(session)}`);
  return { id, email, accessToken: session.access_token };
}

const created = { users: [], households: [] };

try {
  // --- setup: two disposable synthetic tenants, real signup + real password sign-in ---
  const tenantA = await makeUser('A');
  created.users.push(tenantA.id);
  record('SETUP-1', 'Tenant A created via admin.auth.admin createUser + real password sign-in', 'PASS', { id: tenantA.id, email: tenantA.email });

  const tenantB = await makeUser('B');
  created.users.push(tenantB.id);
  record('SETUP-2', 'Tenant B created via admin.auth.admin createUser + real password sign-in', 'PASS', { id: tenantB.id, email: tenantB.email });

  // Tenant A creates their own household row using their OWN user JWT (not service role).
  const insertA = await asUser(tenantA.accessToken, '/rest/v1/households', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: tenantA.id, household_name: `AIE1 livedev RLS proof ${stamp}`, primary_country: 'AU' },
  });
  const householdAId = insertA.json?.[0]?.id;
  if (!householdAId) throw new Error(`Tenant A could not create own household: ${insertA.text}`);
  created.households.push(householdAId);
  record('SETUP-3', 'Tenant A inserts own households row as themself (RLS with-check passes for own user_id)', 'PASS', { status: insertA.status, id: householdAId });

  // --- POSITIVE CONTROL: proves the method itself works (a real, known-good read succeeds) ---
  const ownRead = await asUser(tenantA.accessToken, `/rest/v1/households?id=eq.${householdAId}&select=id,user_id,household_name`);
  const ownReadOk = ownRead.status === 200 && ownRead.json?.length === 1 && ownRead.json[0].id === householdAId;
  record('POSITIVE-CONTROL', 'Tenant A reads their OWN household row via their own JWT -- must return exactly 1 row', ownReadOk ? 'PASS' : 'FAIL', { status: ownRead.status, rows: ownRead.json });
  if (!ownReadOk) throw new Error('Positive control failed -- the read method itself is broken, so a subsequent empty result from Tenant B would be meaningless.');

  // --- NEGATIVE CONTROL: cross-tenant READ must be blocked ---
  const crossRead = await asUser(tenantB.accessToken, `/rest/v1/households?id=eq.${householdAId}&select=id,user_id,household_name`);
  const crossReadBlocked = crossRead.status === 200 && Array.isArray(crossRead.json) && crossRead.json.length === 0;
  record('NEGATIVE-CONTROL-READ', "Tenant B attempts to read Tenant A's household row via Tenant B's own JWT -- must return zero rows (RLS-filtered), not an error and not the row", crossReadBlocked ? 'PASS' : 'FAIL', { status: crossRead.status, rows: crossRead.json });

  // --- NEGATIVE CONTROL: cross-tenant WRITE must be blocked ---
  const crossWrite = await asUser(tenantB.accessToken, `/rest/v1/households?id=eq.${householdAId}`, {
    method: 'PATCH', prefer: 'return=representation', body: { household_name: 'HIJACKED BY TENANT B' },
  });
  const crossWriteBlocked = crossWrite.status === 200 && Array.isArray(crossWrite.json) && crossWrite.json.length === 0;
  record('NEGATIVE-CONTROL-WRITE', "Tenant B attempts to UPDATE Tenant A's household row via Tenant B's own JWT -- must affect zero rows", crossWriteBlocked ? 'PASS' : 'FAIL', { status: crossWrite.status, rows: crossWrite.json });

  // Independently confirm (service role, bypassing RLS) that the row was NOT actually changed by Tenant B's attempt.
  const verifyUnchanged = await svc(`/rest/v1/households?id=eq.${householdAId}&select=household_name`);
  const unchanged = verifyUnchanged.json?.[0]?.household_name === `AIE1 livedev RLS proof ${stamp}`;
  record('NEGATIVE-CONTROL-WRITE-VERIFY', 'Service-role read confirms the row content is unchanged after the blocked cross-tenant write attempt', unchanged ? 'PASS' : 'FAIL', verifyUnchanged.json);

} finally {
  // --- CLEANUP: delete every synthetic row/user, then independently re-verify zero residue ---
  console.log('\n--- cleanup ---');
  for (const hId of created.households) {
    const del = await svc(`/rest/v1/households?id=eq.${hId}`, { method: 'DELETE' });
    record('CLEANUP-HOUSEHOLD', `deleted synthetic household ${hId}`, del.status === 200 || del.status === 204 ? 'PASS' : 'FAIL', del.status);
  }
  for (const uId of created.users) {
    const del = await svc(`/auth/v1/admin/users/${uId}`, { method: 'DELETE' });
    record('CLEANUP-USER', `deleted synthetic user ${uId}`, del.status === 200 || del.status === 204 ? 'PASS' : 'FAIL', del.status);
  }

  console.log('\n--- independent residue re-verification (re-query, do not trust the delete responses) ---');
  for (const hId of created.households) {
    const re = await svc(`/rest/v1/households?id=eq.${hId}`);
    const gone = Array.isArray(re.json) && re.json.length === 0;
    record('RESIDUE-CHECK-HOUSEHOLD', `household ${hId} must be genuinely gone`, gone ? 'PASS' : 'FAIL', re.json);
  }
  for (const uId of created.users) {
    const re = await svc(`/auth/v1/admin/users/${uId}`);
    const gone = re.status === 404 || (re.status === 200 && re.json?.id === undefined) || /user not found/i.test(re.text || '');
    record('RESIDUE-CHECK-USER', `user ${uId} must be genuinely gone (getUserById-equivalent not-found)`, gone ? 'PASS' : 'FAIL', { status: re.status, text: re.text?.slice(0, 200) });
  }

  const failed = results.filter(r => r.status === 'FAIL');
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) { console.log('FAILURES:', failed.map(f => f.id)); process.exit(1); }
}
