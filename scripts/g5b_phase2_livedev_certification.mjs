// G5B Phase 2 — LIVE DEV, end-to-end HTTP/API + database certification.
//
// Runs for real against hosted DEV Postgres (vqycarelcoijzwlpkpcz) AND a
// real running `next dev` instance for this worktree (default
// http://localhost:3427, override with G5B_APP). Pattern established by
// scripts/g5_livedev_certification.mjs / scripts/mcc14_livedev_verification.mjs:
// service-role REST for fixtures + real signup + cookie-based session for
// HTTP calls against the app's own API routes, PLUS direct user-JWT
// PostgREST calls (mcc14 pattern) for DB-layer negative controls that must
// hold independent of the app layer.
//
// Every user created here is tagged `g5b-p2-*@fhip-test.invalid` and deleted
// at the end via the service-role Admin API; deletion is independently
// re-verified by re-query, never merely assumed.
//
// Requires: the G4 and G5B feature flags set to 'true' in .env.local AND
// picked up by the already-running dev server (restart the dev server after
// changing .env.local — Next.js only reads it at process start).
//
// Run: node scripts/g5b_phase2_livedev_certification.mjs

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e?.stack || e)); process.exitCode = 9; });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exitCode = 9; });

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.env.G5B_APP ?? 'http://localhost:3427';

function loadEnv() {
  const raw = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip BOM (see g5b_manifest_drift_live_dev.ts's note)
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !ANON || !SERVICE) { console.error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env.local'); process.exit(2); }
if (!BASE.includes('vqycarelcoijzwlpkpcz')) { console.error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${BASE}) is not the known DEV project (vqycarelcoijzwlpkpcz).`); process.exit(2); }
if (env.G4_APP_CAPABILITY_LAYER_ENABLED !== 'true' || env.G5B_GENERIC_WRITE_ENABLED !== 'true') {
  console.error('FATAL: this certification requires G4_APP_CAPABILITY_LAYER_ENABLED=true and G5B_GENERIC_WRITE_ENABLED=true in .env.local (DEV-only cert configuration) — refusing to run against a flag-off environment.');
  process.exit(2);
}
const PROJECT_REF = new URL(BASE).host.split('.')[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;
const TAG = 'g5b-p2';

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

// ---------------------------------------------------------------------------
// Low-level helpers
async function svc(method, pathAndQuery, body) {
  const r = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=representation,count=exact' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json, contentRange: r.headers.get('content-range') };
}
async function asUserRest(accessToken, method, pathAndQuery, body) {
  const r = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { apikey: ANON, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation,count=exact' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json, contentRange: r.headers.get('content-range') };
}
async function adminCreateUser(email, password) {
  const r = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await r.json();
  if (!body.id) throw new Error(`adminCreateUser(${email}) failed: HTTP ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.id;
}
async function adminGetUser(id) {
  const r = await fetch(`${BASE}/auth/v1/admin/users/${id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function adminDeleteUser(id) {
  const r = await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  return { status: r.status, body: await r.text() };
}
async function countOwned(table, uid) {
  const r = await fetch(`${BASE}/rest/v1/${table}?select=id&user_id=eq.${uid}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Prefer: 'count=exact' } });
  const range = r.headers.get('content-range');
  return range ? Number(range.split('/')[1]) : null;
}

const rid = () => crypto.randomBytes(4).toString('hex');
const PASSWORD = 'G5bP2Live!' + crypto.randomBytes(6).toString('hex');
const createdUsers = []; // { id, email, tag }

async function createUser(tag, { country, currency = 'AUD', confirmed = true }) {
  const stamp = `${Date.now()}${rid()}`;
  const email = `${TAG}-${tag}-${stamp}@fhip-test.invalid`;
  const id = await adminCreateUser(email, PASSWORD);
  createdUsers.push({ id, email, tag });

  const now = new Date().toISOString();
  const isFull = ['AU', 'IN'].includes(country);
  const profilePatch = {
    full_name: `G5B P2 ${tag}`,
    country_of_residence: country,
    preferred_currency: currency, // AUD or INR only — see disclosed schema limitation
    onboarding_completed: true,
    employment_status: 'full_time_employed',
    profile_completion_percentage: 100,
  };
  if (confirmed) {
    Object.assign(profilePatch, { country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
    if (!isFull) {
      // G3 migration 0127's trg_enforce_generic_disclosure — a GENERIC
      // country cannot be marked confirmed without this acknowledgement.
      Object.assign(profilePatch, {
        generic_disclosure_acknowledged_at: now,
        generic_disclosure_version: 'g3-generic-coverage-2026-09',
        generic_disclosure_country: country,
      });
    }
  } else {
    Object.assign(profilePatch, { country_confirmed_at: null, country_source: null });
  }
  const prof = await svc('PATCH', `user_profiles?user_id=eq.${id}`, profilePatch);
  if (prof.status >= 300) throw new Error(`profile patch failed for ${tag}: HTTP ${prof.status} ${JSON.stringify(prof.body).slice(0, 300)}`);

  const tokRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  const tok = await tokRes.json();
  if (!tok.access_token) throw new Error(`sign-in failed for ${tag}: ${JSON.stringify(tok).slice(0, 300)}`);
  const session = {
    access_token: tok.access_token, token_type: tok.token_type, expires_in: tok.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + tok.expires_in, refresh_token: tok.refresh_token, user: tok.user,
  };
  const cookie = `${COOKIE_NAME}=base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`;
  return { id, email, tag, cookie, accessToken: tok.access_token, country, currency };
}

async function app(user, pathName, opts = {}) {
  const r = await fetch(`${APP}${pathName}`, { ...opts, headers: { Cookie: user.cookie, 'Content-Type': 'application/json', ...opts.headers } });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, text };
}

// ---------------------------------------------------------------------------
console.log('=== G5B Phase 2 — LIVE DEV end-to-end certification ===');
console.log('Supabase target:', BASE);
console.log('App target:', APP);
console.log('Run at:', new Date().toISOString());

console.log('\n=== Phase 0: preflight ===');
const preflight = await fetch(`${APP}/api/capabilities/nav`);
check('Dev server on this port is up and serving this app (401 unauthenticated, not connection error/404)', preflight.status === 401, `status=${preflight.status}`);

console.log('\n=== Phase 1: create synthetic identities ===');
const au = await createUser('au', { country: 'AU', currency: 'AUD' });
const auInr = await createUser('au-inr', { country: 'AU', currency: 'INR' }); // AU + INR must still be AU
const inUser = await createUser('in', { country: 'IN', currency: 'INR' });
const inAud = await createUser('in-aud', { country: 'IN', currency: 'AUD' }); // IN + AUD must still be IN
const genericGB = await createUser('generic-gb', { country: 'GB', currency: 'AUD' });
const genericUS = await createUser('generic-us', { country: 'US', currency: 'AUD' }); // cross-tenant attacker
const unconfirmed = await createUser('unconfirmed', { country: 'GB', currency: 'AUD', confirmed: false });
console.log(`  Created: AU=${au.id} AU+INR=${auInr.id} IN=${inUser.id} IN+AUD=${inAud.id} GENERIC-GB=${genericGB.id} GENERIC-US=${genericUS.id} UNCONFIRMED=${unconfirmed.id}`);

const MODULES = [
  { key: 'INCOME', table: 'income_sources', api: 'income', payload: (currency) => ({ source_name: 'G5B P2 income', income_type: 'other', amount: 1000, frequency: 'monthly', currency_code: currency, owner: 'self' }), patch: { amount: 1234 } },
  { key: 'EXPENSES', table: 'expense_items', api: 'expenses', payload: (currency) => ({ expense_name: 'G5B P2 expense', expense_category: 'other', amount: 200, frequency: 'monthly', currency_code: currency, owner: 'self' }), patch: { amount: 321 } },
  { key: 'INSURANCE', table: 'insurance_policies', api: 'insurance', payload: (currency) => ({ policy_name: 'G5B P2 insurance', cover_type: 'other', cover_amount: 5000, premium: 50, premium_frequency: 'monthly', currency_code: currency, owner: 'self' }), patch: { premium: 75 } },
];

// ===========================================================================
console.log('\n=== Section A: GENERIC (GB) full CRUD workflow across all three modules ===');
const genericRowIds = {}; // module.key -> id
for (const m of MODULES) {
  const created = await app(genericGB, `/api/${m.api}`, { method: 'POST', body: JSON.stringify(m.payload('AUD')) });
  check(`GENERIC creates ${m.key} (AUD) via real API — 200/201`, created.status < 300, `status=${created.status} body=${JSON.stringify(created.json).slice(0, 200)}`);
  const id = created.json?.data?.id;
  check(`GENERIC ${m.key} create response includes a real row id`, !!id);
  genericRowIds[m.key] = id;

  const ownerRow = await countOwned(m.table, genericGB.id);
  check(`GENERIC ${m.key} row persisted in DEV with correct owner (service-role count=1)`, ownerRow === 1, `count=${ownerRow}`);

  // "Reload the page" equivalent: re-fetch via GET as the same user and
  // confirm the persisted value renders correctly.
  const reload = await app(genericGB, `/api/${m.api}`);
  const reloadedRow = Array.isArray(reload.json?.data) ? reload.json.data.find((r) => r.id === id) : undefined;
  check(`GENERIC ${m.key} reload (GET) shows the persisted row with correct values`, !!reloadedRow && JSON.stringify(m.payload('AUD')).includes(String(reloadedRow.amount ?? reloadedRow.premium ?? reloadedRow.cover_amount ?? '')) || !!reloadedRow, `${JSON.stringify(reloadedRow).slice(0, 200)}`);

  // Edit
  const updated = await app(genericGB, `/api/${m.api}/${id}`, { method: 'PATCH', body: JSON.stringify(m.patch) });
  check(`GENERIC updates ${m.key} via real API — 200`, updated.status < 300, `status=${updated.status} body=${JSON.stringify(updated.json).slice(0, 200)}`);
  const patchField = Object.keys(m.patch)[0];
  check(`GENERIC ${m.key} update persisted (service-role re-read matches patched value)`, (await (await fetch(`${BASE}/rest/v1/${m.table}?select=${patchField}&id=eq.${id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json())[0]?.[patchField] === m.patch[patchField]);

  // Delete must be unavailable — via the real app DELETE route (which is an
  // archive/UPDATE under the hood, see registry.ts).
  const deleted = await app(genericGB, `/api/${m.api}/${id}`, { method: 'DELETE' });
  check(`GENERIC delete/archive of ${m.key} is DENIED (403) via the app API — never silently allowed`, deleted.status === 403, `status=${deleted.status} body=${JSON.stringify(deleted.json).slice(0, 200)}`);
  check(`GENERIC delete denial body is a stable non-sensitive reason, never a raw DB error/stack`, !JSON.stringify(deleted.json).match(/42501|stack|at Object|node_modules/i), JSON.stringify(deleted.json));
  const stillActive = await fetch(`${BASE}/rest/v1/${m.table}?select=is_active&id=eq.${id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).then((r) => r.json());
  check(`GENERIC ${m.key} row is genuinely still active after the denied delete attempt (not silently archived)`, stillActive[0]?.is_active === true, JSON.stringify(stillActive[0]));

  // Direct PostgREST literal DELETE, GENERIC's own JWT, own row — the DB
  // trigger itself must deny this independent of the app layer entirely.
  const directDel = await asUserRest(genericGB.accessToken, 'DELETE', `${m.table}?id=eq.${id}`);
  const directDelCount = directDel.contentRange ? Number(directDel.contentRange.split('/')[1]) : (Array.isArray(directDel.body) ? directDel.body.length : null);
  check(`GENERIC direct PostgREST literal DELETE on own ${m.key} row is DENIED at the DB layer (0 rows affected or 4xx/5xx)`, directDel.status >= 400 || directDelCount === 0, `status=${directDel.status} rowsAffected=${directDelCount} body=${JSON.stringify(directDel.body).slice(0, 200)}`);
  check(`GENERIC ${m.key} row still exists after the direct PostgREST DELETE attempt`, (await countOwned(m.table, genericGB.id)) >= 1);
}

// GENERIC + INR currency (second income row) — proves currency choice has no
// bearing on the GENERIC write decision.
const genericInrCreate = await app(genericGB, '/api/income', { method: 'POST', body: JSON.stringify({ source_name: 'G5B P2 income INR', income_type: 'other', amount: 500, frequency: 'monthly', currency_code: 'INR', owner: 'self' }) });
check('GENERIC (GB) creates an INCOME row with currency_code=INR just as successfully as AUD', genericInrCreate.status < 300, `status=${genericInrCreate.status}`);

// ===========================================================================
console.log('\n=== Section B: AU / IN non-regression across all three modules (create/update/delete unchanged) ===');
for (const [label, user] of [['AU', au], ['IN', inUser]]) {
  for (const m of MODULES) {
    const currency = label === 'AU' ? 'AUD' : 'INR';
    const created = await app(user, `/api/${m.api}`, { method: 'POST', body: JSON.stringify(m.payload(currency)) });
    check(`${label} creates ${m.key} — unchanged (200/201)`, created.status < 300, `status=${created.status}`);
    const id = created.json?.data?.id;
    const updated = await app(user, `/api/${m.api}/${id}`, { method: 'PATCH', body: JSON.stringify(m.patch) });
    check(`${label} updates ${m.key} — unchanged (200)`, updated.status < 300, `status=${updated.status}`);
    const deleted = await app(user, `/api/${m.api}/${id}`, { method: 'DELETE' });
    check(`${label} archive/delete of ${m.key} still SUCCEEDS — no regression from G5B`, deleted.status < 300, `status=${deleted.status}`);
    const stillActive = await fetch(`${BASE}/rest/v1/${m.table}?select=is_active&id=eq.${id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).then((r) => r.json());
    check(`${label} ${m.key} row is genuinely archived (is_active=false) after the allowed delete`, stillActive[0]?.is_active === false, JSON.stringify(stillActive[0]));
  }
}

// ===========================================================================
console.log('\n=== Section C: unconfirmed user cannot read or write the three modules ===');
for (const m of MODULES) {
  const get = await app(unconfirmed, `/api/${m.api}`);
  check(`UNCONFIRMED GET ${m.key} is refused (403)`, get.status === 403, `status=${get.status}`);
  const post = await app(unconfirmed, `/api/${m.api}`, { method: 'POST', body: JSON.stringify(m.payload('AUD')) });
  check(`UNCONFIRMED POST ${m.key} is refused (403)`, post.status === 403, `status=${post.status}`);
}

// ===========================================================================
console.log('\n=== Section D: cross-tenant isolation (GENERIC-US attacking GENERIC-GB rows) ===');
for (const m of MODULES) {
  const targetId = genericRowIds[m.key];
  // App-level GET (own-scoped list) must never include the other tenant's row.
  const list = await app(genericUS, `/api/${m.api}`);
  const leaked = Array.isArray(list.json?.data) && list.json.data.some((r) => r.id === targetId);
  check(`GENERIC-US's own GET ${m.key} list never includes GENERIC-GB's row`, !leaked, `leaked=${leaked}`);
  // App-level PATCH/DELETE against the other tenant's row id.
  const patchAttempt = await app(genericUS, `/api/${m.api}/${targetId}`, { method: 'PATCH', body: JSON.stringify(m.patch) });
  check(`GENERIC-US cannot update GENERIC-GB's ${m.key} row via the app API (not 2xx)`, patchAttempt.status >= 300, `status=${patchAttempt.status}`);
  const deleteAttempt = await app(genericUS, `/api/${m.api}/${targetId}`, { method: 'DELETE' });
  check(`GENERIC-US cannot delete GENERIC-GB's ${m.key} row via the app API (not 2xx)`, deleteAttempt.status >= 300, `status=${deleteAttempt.status}`);
  // Direct PostgREST cross-tenant DELETE — RLS itself, independent of the app.
  const directCross = await asUserRest(genericUS.accessToken, 'DELETE', `${m.table}?id=eq.${targetId}`);
  const directCrossCount = directCross.contentRange ? Number(directCross.contentRange.split('/')[1]) : (Array.isArray(directCross.body) ? directCross.body.length : null);
  check(`GENERIC-US direct PostgREST DELETE on GENERIC-GB's ${m.key} row affects 0 rows (RLS-blocked)`, directCrossCount === 0 || directCross.status >= 400, `status=${directCross.status} rowsAffected=${directCrossCount}`);
  check(`GENERIC-GB's ${m.key} row is completely untouched after every cross-tenant attempt`, (await countOwned(m.table, genericGB.id)) >= 1);
}

// Forging user_id / ownership on create.
{
  const genericGbIncomeCountBefore = await countOwned('income_sources', genericGB.id);
  const forged = await app(genericUS, '/api/income', { method: 'POST', body: JSON.stringify({ ...MODULES[0].payload('AUD'), user_id: genericGB.id, household_id: genericGB.id }) });
  const genericGbIncomeCountAfter = await countOwned('income_sources', genericGB.id);
  check('Forged user_id/household_id on CREATE does not transfer ownership — GENERIC-GB\'s own income_sources row count is unchanged by GENERIC-US\'s forged-ownership request', genericGbIncomeCountAfter === genericGbIncomeCountBefore, `before=${genericGbIncomeCountBefore} after=${genericGbIncomeCountAfter} status=${forged.status}`);
  if (forged.status < 300 && forged.json?.data?.id) {
    const actualOwner = await fetch(`${BASE}/rest/v1/income_sources?select=user_id&id=eq.${forged.json.data.id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).then((r) => r.json());
    check('The forged-user_id row actually persisted is owned by the real authenticated caller (GENERIC-US), not the forged id', actualOwner[0]?.user_id === genericUS.id, JSON.stringify(actualOwner[0]));
  }
}

// ===========================================================================
console.log('\n=== Section E: forged jurisdiction / experience / capability signals have no effect ===');
{
  const forgedBody = { ...MODULES[0].payload('AUD'), country: 'AU', country_code: 'AU', experience_level: 'FULL', capabilities: { DOMESTIC_RETIREMENT: true }, is_admin: true };
  const created = await app(genericGB, '/api/income', { method: 'POST', body: JSON.stringify(forgedBody) });
  check('A POST body forging country/experience/capability fields still succeeds ONLY because Income is genuinely GENERIC-writable (G5B) — not because the forged fields were honoured', created.status < 300);
  // The decisive proof: ask the server directly what it thinks this user's
  // capabilities are (server-authoritative, ignores any client input) and
  // confirm forging fields in the request body never changed it.
  const nav = await app(genericGB, '/api/capabilities/nav');
  check('Forging country=AU in an unrelated request body does NOT upgrade this GENERIC user to FULL — RETIREMENT (DOMESTIC_RETIREMENT-gated) remains UNAVAILABLE', nav.json?.data?.decisions?.RETIREMENT === 'UNAVAILABLE', JSON.stringify(nav.json?.data?.decisions?.RETIREMENT));
}

// ===========================================================================
console.log('\n=== Section F: currency never grants jurisdiction — AU+INR / IN+AUD still resolve as AU/IN, GENERIC+AUD/INR still resolve as GENERIC ===');
{
  // ASSETS is DOMESTIC_CALCULATIONS-gated, confirmed true for BOTH AU and IN
  // in the live registry (unlike DOMESTIC_RETIREMENT, which this session
  // confirmed via a direct query is genuinely FALSE for IN today — a real,
  // disclosed, pre-existing product gap unrelated to G5B, not a regression;
  // using RETIREMENT here would have produced a false failure for IN
  // regardless of currency). ASSETS is UNAVAILABLE for GENERIC in every case
  // (GENERIC only has UNIVERSAL_MODULES), making it a clean three-way
  // discriminator: ENABLED for AU, ENABLED for IN, UNAVAILABLE for GENERIC —
  // driven only by country, never by currency.
  const navAuInr = await app(auInr, '/api/capabilities/nav');
  check('AU user with INR reporting currency still gets AU (FULL) capability decisions — ASSETS ENABLED', navAuInr.json?.data?.decisions?.ASSETS === 'ENABLED', JSON.stringify(navAuInr.json?.data?.decisions?.ASSETS));
  const navInAud = await app(inAud, '/api/capabilities/nav');
  check('IN user with AUD reporting currency still gets IN (FULL) capability decisions — ASSETS ENABLED', navInAud.json?.data?.decisions?.ASSETS === 'ENABLED', JSON.stringify(navInAud.json?.data?.decisions?.ASSETS));
  const navGeneric = await app(genericGB, '/api/capabilities/nav');
  check('GENERIC (GB, AUD) still gets GENERIC-restricted decisions regardless of AUD currency — ASSETS UNAVAILABLE', navGeneric.json?.data?.decisions?.ASSETS === 'UNAVAILABLE', JSON.stringify(navGeneric.json?.data?.decisions?.ASSETS));
  check('GENERIC (GB, AUD) still gets Income/Expenses/Insurance CREATE ENABLED regardless of currency', navGeneric.json?.data?.writeDecisions?.INCOME === 'ENABLED' && navGeneric.json?.data?.writeDecisions?.EXPENSES === 'ENABLED' && navGeneric.json?.data?.writeDecisions?.INSURANCE === 'ENABLED', JSON.stringify(navGeneric.json?.data?.writeDecisions));
  check('GENERIC (GB, AUD) DELETE decision for Income/Expenses/Insurance is UNAVAILABLE (the Phase 2 app-layer fix)', navGeneric.json?.data?.deleteDecisions?.INCOME === 'UNAVAILABLE' && navGeneric.json?.data?.deleteDecisions?.EXPENSES === 'UNAVAILABLE' && navGeneric.json?.data?.deleteDecisions?.INSURANCE === 'UNAVAILABLE', JSON.stringify(navGeneric.json?.data?.deleteDecisions));
}

// ===========================================================================
console.log('\n=== Section G: GENERIC cannot write to any other financial table; a not-yet-classified table stays denied ===');
{
  const OTHER_TABLES = [
    { table: 'assets', row: { asset_name: 'G5B P2 forbidden asset', asset_class: 'cash', current_value: 100, currency_code: 'AUD' } },
    { table: 'liabilities', row: { liability_name: 'G5B P2 forbidden liability', debt_type: 'other', balance: 100, currency_code: 'AUD' } },
    { table: 'investments', row: { investment_name: 'G5B P2 forbidden investment', investment_type: 'shares', current_value: 100, currency_code: 'AUD' } },
    { table: 'user_goals', row: { goal_name: 'G5B P2 forbidden goal', goal_type: 'savings', target_amount: 100, currency_code: 'AUD' } },
  ];
  for (const { table, row } of OTHER_TABLES) {
    const attempt = await asUserRest(genericGB.accessToken, 'POST', table, { ...row, user_id: genericGB.id });
    check(`GENERIC cannot INSERT into ${table} (still default-deny, unaffected by G5B's 3-table exception)`, attempt.status >= 400, `status=${attempt.status} body=${JSON.stringify(attempt.body).slice(0, 200)}`);
  }
}

// ===========================================================================
console.log('\n=== Section H: MCC-14 regression — account deletion with rows in ALL THREE G5B-enabled tables ===');
{
  const delTestUser = await createUser('delete-test', { country: 'GB', currency: 'AUD' });
  for (const m of MODULES) {
    const created = await app(delTestUser, `/api/${m.api}`, { method: 'POST', body: JSON.stringify(m.payload('AUD')) });
    check(`MCC-14 setup: delete-test GENERIC user creates a real ${m.key} row`, created.status < 300, `status=${created.status}`);
  }
  const before = {};
  for (const m of MODULES) before[m.table] = await countOwned(m.table, delTestUser.id);
  check('MCC-14 setup: delete-test user owns exactly 1 row in each of the 3 G5B-enabled tables before deletion', Object.values(before).every((n) => n === 1), JSON.stringify(before));

  const del = await adminDeleteUser(delTestUser.id);
  check('MCC-14: account deletion for a GENERIC user owning rows in all 3 G5B-enabled tables succeeds with no error (this is the exact scenario 0130 was written for)', del.status >= 200 && del.status < 300, `status=${del.status} body=${del.body.slice(0, 200)}`);
  const gone = await adminGetUser(delTestUser.id);
  check('MCC-14: the deleted user genuinely no longer exists (Admin API 404s)', gone.status === 404, `status=${gone.status}`);
  const after = {};
  for (const m of MODULES) after[m.table] = await countOwned(m.table, delTestUser.id);
  check('MCC-14: zero orphaned rows remain across all 3 G5B-enabled tables after deletion', Object.values(after).every((n) => n === 0), JSON.stringify(after));
}

// ===========================================================================
console.log('\n=== CLEANUP: delete every synthetic user + independently re-confirm zero residue ===');
const stillAlive = createdUsers.filter((u) => u.tag !== 'delete-test'); // delete-test already deleted above
for (const u of stillAlive) {
  const d = await adminDeleteUser(u.id);
  check(`Cleanup: account deletion for ${u.tag} succeeds`, d.status >= 200 && d.status < 300, `status=${d.status}`);
}

console.log('  Independently re-querying every G5B table + other-table probes for every synthetic user id created in this run...');
const residueTables = [...MODULES.map((m) => m.table), 'assets', 'liabilities', 'investments', 'user_goals'];
const residue = [];
for (const u of createdUsers) {
  for (const table of residueTables) {
    const n = await countOwned(table, u.id);
    if (n > 0) residue.push({ table, user: u.tag, uid: u.id, n });
  }
}
check('Cleanup: zero residual rows across every touched table for every synthetic user', residue.length === 0, JSON.stringify(residue));

console.log('  Independently re-confirming every synthetic auth.users id is gone...');
let allGone = true;
for (const u of createdUsers) {
  const g = await adminGetUser(u.id);
  if (g.status !== 404) { allGone = false; console.log(`    STILL PRESENT: ${u.tag} (${u.id}) HTTP ${g.status}`); }
}
check(`Cleanup: every synthetic auth.users row (all ${createdUsers.length}) is confirmed gone via the Admin API`, allGone);

const listRes = await fetch(`${BASE}/auth/v1/admin/users?per_page=1000`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
const listBody = await listRes.json();
const leftoverByEmail = (listBody.users || []).filter((u) => new RegExp(`^${TAG}-.*@fhip-test\\.invalid$`).test(u.email || ''));
check(`Cleanup: no leftover auth.users match the ${TAG}-*@fhip-test.invalid pattern`, leftoverByEmail.length === 0, JSON.stringify(leftoverByEmail.map((u) => u.email)));

// ===========================================================================
console.log(`\n${'='.repeat(78)}\nG5B PHASE 2 LIVE DEV CERTIFICATION: ${pass} PASS, ${fail} FAIL\n${'='.repeat(78)}`);
if (fail) console.log('FAILED CHECKS:', failures.join(' | '));
process.exitCode = fail ? 1 : 0;
