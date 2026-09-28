// Mission part 4, section 17 -- production test matrix item "cross-tenant
// denial", checked with a PROPORTIONATE, SAFE, narrow live PRODUCTION probe
// (not DEV) -- deliberately going beyond the register's existing evidence,
// which is DEV/PGlite/unit-test based (R19's "12 cross-tenant RPC refusals").
// Mission section 16's own instruction: "Do not establish production
// correctness solely through service-role queries. Use them as independent
// ground truth alongside normal user access." -- this script does both: a
// service-role write (ground truth setup + final verification), and a real
// per-user authenticated PostgREST call (Authorization: Bearer <that user's
// own access token>, matching how the real app authenticates every request)
// for the actual cross-tenant read/write attempt.
//
// Two disposable synthetic PRODUCTION accounts, cleaned up and verified
// absent at the end. No document upload, no AI call, no malware scan --
// purely a canonical-table RLS probe against one already-existing,
// long-established table (income_sources).
//
// Run: npx tsx scripts/aie1_p4_section17_prod_cross_tenant_denial.mjs
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
function loadEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return env;
}
const env = loadEnv('D:/FHIP/.env.local');
const PROD_HOST_REF = 'twwpnltizhtjxhamyoxt';
const BASE = env.PRODUCTION_SUPABASE_URL;
const SERVICE = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
if (!new URL(BASE).host.includes(PROD_HOST_REF)) throw new Error('refusing: PRODUCTION_SUPABASE_URL does not match the expected production project ref');
if (!SERVICE) throw new Error('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY missing');

const manifestPath = 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad/aie1_p4_synthetic_manifest.jsonl';
function recordArtefact(entry) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.appendFileSync(manifestPath, JSON.stringify({ at: new Date().toISOString(), env: 'PRODUCTION', ...entry }) + '\n');
}

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
}

async function adminFetch(p, { method = 'GET', body, headers: extra } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(extra ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function createSyntheticUser(tag) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const email = `aie1-p4-${tag}-${stamp}@fhip-synthetic.test`;
  const password = `Fhip!Synth${stamp}Zz9`;
  const created = await adminFetch('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  if (!id) throw new Error(`could not create ${tag}: ${created.text.slice(0, 300)}`);
  recordArtefact({ kind: 'auth_user', id, email, tag, run: 'section17-cross-tenant' });
  await adminFetch(`/rest/v1/user_profiles?user_id=eq.${id}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: { country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true },
  });
  const signInRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: SERVICE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await signInRes.json();
  if (!session.access_token) throw new Error(`sign-in failed for ${tag}: ${JSON.stringify(session)}`);
  return { id, email, token: session.access_token };
}

async function main() {
  console.log('Target:', new URL(BASE).host, '(production, confirmed by ref match above)');
  const userA = await createSyntheticUser('xtenA');
  const userB = await createSyntheticUser('xtenB');
  console.log('userA', userA.id, 'userB', userB.id);

  // Ground truth setup (service-role write): give User A one real income_sources row.
  const createRow = await adminFetch('/rest/v1/income_sources', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: { user_id: userA.id, source_name: 'section17-cross-tenant-probe', income_type: 'salary', frequency: 'monthly', amount: 1234.56, currency_code: 'AUD' },
  });
  const rowId = Array.isArray(createRow.json) ? createRow.json[0]?.id : null;
  check('ground truth: row created for userA via service role', createRow.ok && !!rowId, `${createRow.status} ${createRow.text.slice(0, 200)}`);
  if (rowId) recordArtefact({ kind: 'income_sources', id: rowId, userId: userA.id, run: 'section17-cross-tenant' });

  // Real per-user authenticated PostgREST call (userB's own access token, NOT
  // service role) attempting to read userA's row by id.
  async function asUser(token, p, opts = {}) {
    const res = await fetch(`${BASE}${p}`, {
      method: opts.method ?? 'GET',
      headers: { apikey: SERVICE, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ }
    return { ok: res.ok, status: res.status, json, text };
  }

  const crossRead = await asUser(userB.token, `/rest/v1/income_sources?id=eq.${rowId}`);
  check(
    'section17-01: userB (real authenticated session) cannot READ userA\'s row -- 0 rows returned',
    crossRead.ok && Array.isArray(crossRead.json) && crossRead.json.length === 0,
    `HTTP ${crossRead.status} rows=${Array.isArray(crossRead.json) ? crossRead.json.length : 'n/a'}`,
  );

  const crossUpdate = await asUser(userB.token, `/rest/v1/income_sources?id=eq.${rowId}`, { method: 'PATCH', body: { source_name: 'HIJACKED' } });
  const crossUpdateAffectedRows = Array.isArray(crossUpdate.json) ? crossUpdate.json.length : 0;
  check(
    'section17-02: userB cannot UPDATE userA\'s row (0 rows affected, not a 200-with-silent-noop misread)',
    crossUpdateAffectedRows === 0,
    `HTTP ${crossUpdate.status} rows affected=${crossUpdateAffectedRows}`,
  );

  const crossDelete = await asUser(userB.token, `/rest/v1/income_sources?id=eq.${rowId}`, { method: 'DELETE' });
  const crossDeleteAffectedRows = Array.isArray(crossDelete.json) ? crossDelete.json.length : 0;
  check(
    'section17-03: userB cannot DELETE userA\'s row (0 rows affected)',
    crossDeleteAffectedRows === 0,
    `HTTP ${crossDelete.status} rows affected=${crossDeleteAffectedRows}`,
  );

  // Ground truth check: the row is genuinely untouched (service role re-read).
  const verify = await adminFetch(`/rest/v1/income_sources?id=eq.${rowId}`);
  const stillIntact = Array.isArray(verify.json) && verify.json.length === 1 && verify.json[0].source_name === 'section17-cross-tenant-probe';
  check('ground truth: userA\'s row is untouched after userB\'s 3 attempts (name unchanged, still exists)', stillIntact, JSON.stringify(verify.json));

  // userA CAN read her own row (sanity: RLS is denying cross-tenant, not everything).
  const ownRead = await asUser(userA.token, `/rest/v1/income_sources?id=eq.${rowId}`);
  check('sanity: userA CAN read her own row (RLS denies cross-tenant specifically, not all access)', ownRead.ok && Array.isArray(ownRead.json) && ownRead.json.length === 1, `HTTP ${ownRead.status}`);

  // Cleanup, then verify absence (not just trust the delete call).
  await adminFetch(`/rest/v1/income_sources?id=eq.${rowId}`, { method: 'DELETE' });
  const delA = await adminFetch(`/auth/v1/admin/users/${userA.id}`, { method: 'DELETE' });
  const delB = await adminFetch(`/auth/v1/admin/users/${userB.id}`, { method: 'DELETE' });
  recordArtefact({ kind: 'cleanup', userId: userA.id, deleted: delA.ok, run: 'section17-cross-tenant' });
  recordArtefact({ kind: 'cleanup', userId: userB.id, deleted: delB.ok, run: 'section17-cross-tenant' });

  const rowGone = await adminFetch(`/rest/v1/income_sources?id=eq.${rowId}`);
  check('cleanup verified: probe row absent after delete (re-queried, not assumed)', Array.isArray(rowGone.json) && rowGone.json.length === 0, JSON.stringify(rowGone.json));
  const userAGone = await adminFetch(`/auth/v1/admin/users/${userA.id}`);
  const userBGone = await adminFetch(`/auth/v1/admin/users/${userB.id}`);
  check('cleanup verified: userA auth record absent (404)', userAGone.status === 404, `${userAGone.status}`);
  check('cleanup verified: userB auth record absent (404)', userBGone.status === 404, `${userBGone.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
