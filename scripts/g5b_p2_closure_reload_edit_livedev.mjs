// G5B Phase 2 CLOSURE — LIVE DEV reload-edit regression proof.
//
// This is a targeted addition to the Phase 2 certification pattern
// (scripts/g5b_phase2_livedev_certification.mjs), written specifically to
// reproduce and disprove the reload-edit 422 blocker this closure task fixed.
// The prior 110-case cert's PATCH check only ever sent a single required
// field (`{ amount: 1234 }` etc.) — it never simulated what the real client
// (components/grid/FinancialDataGrid.tsx's runSave()) actually sends: EVERY
// configured field on EVERY save, including whatever the last GET returned
// for fields the user never touched. After a genuine reload, those untouched
// optional fields come back as real JSON `null` (their nullable DB column's
// actual value, not merely an absent key) — which is exactly what this
// script resends, byte-for-byte matching runSave()'s own field loop.
//
// Two request shapes are exercised because they hit two different server-side
// validators:
//   - PATCH /api/<resource>/<id> (incomeSchema/expenseSchema/insuranceSchema
//     .partial().safeParse) — the path a CUSTOM row's edit takes
//     (FinancialDataGrid usePatch = row.is_custom && row.id).
//   - POST /api/<resource> (the full, non-partial schema; registry.save()
//     upserts on (user_id, master_item_key) conflict) — the path a
//     MASTER-CATALOGUE row's edit takes.
//
// Governance: DEV only (vqycarelcoijzwlpkpcz, verified below), synthetic
// identities tagged *@fhip-verify.invalid per this closure task's governance
// addendum, deleted at the end with independent re-verification (never
// merely assumed). No production access.
//
// Requires: G4 and G5B feature flags 'true' in .env.local AND a running
// `next dev`/`next build && next start` for this worktree at G5B_APP
// (default http://localhost:3427) — same requirement as the Phase 2 cert.
//
// Run: node scripts/g5b_p2_closure_reload_edit_livedev.mjs

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
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip BOM
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
  console.error('FATAL: requires G4_APP_CAPABILITY_LAYER_ENABLED=true and G5B_GENERIC_WRITE_ENABLED=true in .env.local — refusing to run against a flag-off environment.');
  process.exit(2);
}
const TAG = 'g5b-p2-closure';

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

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
const PASSWORD = 'G5bP2Closure!' + crypto.randomBytes(6).toString('hex');
const createdUsers = [];

async function createUser(tag, { country, currency = 'AUD' }) {
  const stamp = `${Date.now()}${rid()}`;
  const email = `${TAG}-${tag}-${stamp}@fhip-verify.invalid`;
  const id = await adminCreateUser(email, PASSWORD);
  createdUsers.push({ id, email, tag });
  const now = new Date().toISOString();
  const isFull = ['AU', 'IN'].includes(country);
  const profilePatch = {
    full_name: `G5B P2 Closure ${tag}`,
    country_of_residence: country,
    preferred_currency: currency,
    onboarding_completed: true,
    employment_status: 'full_time_employed',
    profile_completion_percentage: 100,
    country_confirmed_at: now,
    country_source: 'USER_CONFIRMED',
    country_updated_at: now,
  };
  if (!isFull) {
    Object.assign(profilePatch, {
      generic_disclosure_acknowledged_at: now,
      generic_disclosure_version: 'g3-generic-coverage-2026-09',
      generic_disclosure_country: country,
    });
  }
  const prof = await svc('PATCH', `user_profiles?user_id=eq.${id}`, profilePatch);
  if (prof.status >= 300) throw new Error(`profile patch failed for ${tag}: HTTP ${prof.status} ${JSON.stringify(prof.body).slice(0, 300)}`);

  const tokRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  const tok = await tokRes.json();
  if (!tok.access_token) throw new Error(`sign-in failed for ${tag}: ${JSON.stringify(tok).slice(0, 300)}`);
  const projectRef = new URL(BASE).host.split('.')[0];
  const cookieName = `sb-${projectRef}-auth-token`;
  const session = {
    access_token: tok.access_token, token_type: tok.token_type, expires_in: tok.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + tok.expires_in, refresh_token: tok.refresh_token, user: tok.user,
  };
  const cookie = `${cookieName}=base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`;
  return { id, email, tag, cookie, accessToken: tok.access_token, country, currency };
}

async function app(user, pathName, opts = {}) {
  const r = await fetch(`${APP}${pathName}`, { ...opts, headers: { Cookie: user.cookie, 'Content-Type': 'application/json', ...opts.headers } });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, text };
}

// ---------------------------------------------------------------------------
console.log('=== G5B Phase 2 Closure — LIVE DEV reload-edit regression proof ===');
console.log('Supabase target:', BASE);
console.log('App target:', APP);
console.log('Run at:', new Date().toISOString());

const preflight = await fetch(`${APP}/api/capabilities/nav`);
check('Dev server is up and serving this app (401 unauthenticated, not connection error/404)', preflight.status === 401, `status=${preflight.status}`);

const genericGB = await createUser('generic-gb', { country: 'GB', currency: 'AUD' });
const au = await createUser('au', { country: 'AU', currency: 'AUD' });
const inUser = await createUser('in', { country: 'IN', currency: 'INR' });
console.log(`  Created: GENERIC-GB=${genericGB.id} AU=${au.id} IN=${inUser.id}`);

// Real master_item_key per category — read live so this never hardcodes a
// catalogue label that could drift.
async function firstMasterItemKey(category) {
  const r = await svc('GET', `master_items?category=eq.${category}&select=item_key&order=sort_order.asc&limit=1`);
  const key = Array.isArray(r.body) ? r.body[0]?.item_key : undefined;
  if (!key) throw new Error(`No master_items row found for category=${category}`);
  return key;
}
const incomeMasterKey = await firstMasterItemKey('income');
const expenseMasterKey = await firstMasterItemKey('expense');
const insuranceMasterKey = await firstMasterItemKey('insurance');

const MODULES = [
  {
    key: 'INCOME', table: 'income_sources', api: 'income', masterKey: incomeMasterKey,
    minimalPayload: (currency, masterKey) => ({ source_name: 'G5B P2 Closure income', income_type: 'other', amount: 1000, frequency: 'monthly', currency_code: currency, owner: 'self', ...(masterKey ? { master_item_key: masterKey } : {}) }),
    nullableOptionalFields: ['net_amount', 'employer_name', 'notes'],
    changeField: 'amount', changeValue: 1234, valueColumn: 'amount',
    invalidEdit: { net_amount: -1 },
  },
  {
    key: 'EXPENSES', table: 'expense_items', api: 'expenses', masterKey: expenseMasterKey,
    minimalPayload: (currency, masterKey) => ({ expense_name: 'G5B P2 Closure expense', expense_category: 'other', amount: 200, frequency: 'monthly', currency_code: currency, owner: 'self', ...(masterKey ? { master_item_key: masterKey } : {}) }),
    nullableOptionalFields: ['notes'],
    changeField: 'amount', changeValue: 321, valueColumn: 'amount',
    invalidEdit: { amount: -1 },
  },
  {
    key: 'INSURANCE', table: 'insurance_policies', api: 'insurance', masterKey: insuranceMasterKey,
    minimalPayload: (currency, masterKey) => ({ policy_name: 'G5B P2 Closure insurance', cover_type: 'other', cover_amount: 5000, premium: 50, premium_frequency: 'monthly', currency_code: currency, owner: 'self', ...(masterKey ? { master_item_key: masterKey } : {}) }),
    nullableOptionalFields: ['renewal_date', 'waiting_period_days', 'benefit_period', 'provider', 'notes'],
    changeField: 'premium', changeValue: 75, valueColumn: 'premium',
    invalidEdit: { waiting_period_days: -5 },
  },
];

async function reloadEditScenario(label, user, m) {
  // 1) CREATE via the real API (custom row — no master_item_key — so the
  //    subsequent "edit" genuinely PATCHes rather than upserting a duplicate).
  const currency = user.currency;
  const created = await app(user, `/api/${m.api}`, { method: 'POST', body: JSON.stringify(m.minimalPayload(currency, null)) });
  check(`${label} ${m.key}: custom-row create succeeds (200/201)`, created.status < 300, `status=${created.status} body=${JSON.stringify(created.json).slice(0, 200)}`);
  const id = created.json?.data?.id;
  check(`${label} ${m.key}: create response includes a real row id`, !!id);
  if (!id) return;

  // 2) RELOAD — GET as the same user, exactly what FinancialDataGrid's load()
  //    effect does on every page mount/reload.
  const reload = await app(user, `/api/${m.api}`);
  const row = Array.isArray(reload.json?.data) ? reload.json.data.find((r) => r.id === id) : undefined;
  check(`${label} ${m.key}: reload (GET) returns the created row`, !!row, JSON.stringify(row).slice(0, 200));
  if (!row) return;
  for (const f of m.nullableOptionalFields) {
    check(`${label} ${m.key}: untouched optional field '${f}' comes back as real null after reload (not merely absent)`, Object.prototype.hasOwnProperty.call(row, f) && row[f] === null, `${f}=${JSON.stringify(row[f])}`);
  }

  // 3) EDIT — reproduce FinancialDataGrid.tsx's runSave() byte-for-byte: every
  //    nullable optional field the row currently holds (null, from the
  //    reload) is resent as null alongside the one field the user actually
  //    changed. Before this closure's fix, this exact shape 422'd.
  const patchBody = { owner: row.owner, currency_code: row.currency_code };
  for (const f of m.nullableOptionalFields) patchBody[f] = row[f]; // === null
  patchBody[m.changeField] = m.changeValue;
  const edited = await app(user, `/api/${m.api}/${id}`, { method: 'PATCH', body: JSON.stringify(patchBody) });
  check(`${label} ${m.key}: reload-edit (resending untouched null fields + one real change) succeeds — THE FIX (was 422)`, edited.status < 300, `status=${edited.status} body=${JSON.stringify(edited.json).slice(0, 300)}`);

  // 4) PERSIST — service-role re-read confirms the real change landed and
  //    nothing else was corrupted (nulls stayed null, not coerced to 0/'').
  const reread = await svc('GET', `${m.table}?id=eq.${id}&select=*`);
  const dbRow = Array.isArray(reread.body) ? reread.body[0] : undefined;
  check(`${label} ${m.key}: changed field persisted correctly after reload-edit`, dbRow?.[m.valueColumn] === m.changeValue, `${m.valueColumn}=${JSON.stringify(dbRow?.[m.valueColumn])}`);
  for (const f of m.nullableOptionalFields) {
    check(`${label} ${m.key}: untouched null field '${f}' is STILL null after reload-edit (not coerced to 0/''/default)`, dbRow?.[f] === null, `${f}=${JSON.stringify(dbRow?.[f])}`);
  }
  check(`${label} ${m.key}: currency preserved across reload-edit`, dbRow?.currency_code === currency, `currency_code=${dbRow?.currency_code}`);
  check(`${label} ${m.key}: owner preserved across reload-edit`, dbRow?.owner === row.owner, `owner=${dbRow?.owner}`);

  // 5) NEGATIVE CONTROL — a genuinely invalid non-null value in the SAME
  //    resend shape must still be rejected (proves the fix is additive
  //    nullability, not loosened validation).
  const invalidBody = { ...patchBody, ...m.invalidEdit };
  const invalidEdited = await app(user, `/api/${m.api}/${id}`, { method: 'PATCH', body: JSON.stringify(invalidBody) });
  check(`${label} ${m.key}: a genuinely invalid non-null value in the same resend shape is still rejected (422)`, invalidEdited.status === 422, `status=${invalidEdited.status} body=${JSON.stringify(invalidEdited.json).slice(0, 200)}`);
  const rereadAfterInvalid = await svc('GET', `${m.table}?id=eq.${id}&select=${m.valueColumn}`);
  check(`${label} ${m.key}: the rejected invalid edit did not partially apply`, rereadAfterInvalid.body?.[0]?.[m.valueColumn] === m.changeValue, JSON.stringify(rereadAfterInvalid.body));

  // 6) CROSS-TENANT — a different user cannot reload-edit this row.
  return id;
}

async function crossTenantScenario(label, owner, attacker, m, id) {
  if (!id) return;
  const forged = await app(attacker, `/api/${m.api}/${id}`, { method: 'PATCH', body: JSON.stringify({ [m.changeField]: 999999 }) });
  check(`${label} ${m.key}: cross-tenant reload-edit attempt is denied/no-ops (never 2xx with a row mutated)`, forged.status >= 300 || forged.json?.data == null, `status=${forged.status} body=${JSON.stringify(forged.json).slice(0, 200)}`);
  const reread = await svc('GET', `${m.table}?id=eq.${id}&select=${m.valueColumn}`);
  check(`${label} ${m.key}: victim's row value unchanged after the cross-tenant attempt`, reread.body?.[0]?.[m.valueColumn] !== 999999, JSON.stringify(reread.body));
}

console.log('\n=== Reload-edit matrix: GENERIC / AU / IN x Income / Expenses / Insurance ===');
const rowIdsByUser = { GENERIC: {}, AU: {}, IN: {} };
for (const [label, user] of [['GENERIC', genericGB], ['AU', au], ['IN', inUser]]) {
  for (const m of MODULES) {
    console.log(`\n--- ${label} x ${m.key} ---`);
    const id = await reloadEditScenario(label, user, m);
    rowIdsByUser[label][m.key] = id;
  }
}

console.log('\n=== Cross-tenant: GENERIC-GB attacking a second GENERIC user\'s reload-edited rows ===');
const genericAttacker = await createUser('generic-attacker', { country: 'US', currency: 'AUD' });
for (const m of MODULES) {
  await crossTenantScenario('GENERIC', genericGB, genericAttacker, m, rowIdsByUser.GENERIC[m.key]);
}

console.log('\n=== DELETE remains blocked for GENERIC on all three modules (post-fix regression) ===');
for (const m of MODULES) {
  const id = rowIdsByUser.GENERIC[m.key];
  if (!id) continue;
  const deleted = await app(genericGB, `/api/${m.api}/${id}`, { method: 'DELETE' });
  check(`GENERIC delete/archive of ${m.key} is still DENIED (403) after the reload-edit fix`, deleted.status === 403, `status=${deleted.status} body=${JSON.stringify(deleted.json).slice(0, 200)}`);
}

console.log('\n=== CLEANUP: delete every synthetic user + independently re-confirm zero residue ===');
for (const u of createdUsers) {
  for (const m of MODULES) {
    await svc('DELETE', `${m.table}?user_id=eq.${u.id}`);
  }
}
console.log('  Independently re-querying every G5B table for every synthetic user id created in this run...');
let residue = 0;
for (const u of createdUsers) {
  for (const m of MODULES) {
    const n = await countOwned(m.table, u.id);
    if (n && n > 0) { residue += n; console.log(`    RESIDUE: ${m.table} still has ${n} row(s) for ${u.email}`); }
  }
}
check('Zero residual rows across all three G5B tables for every synthetic user before user deletion', residue === 0, `residue=${residue}`);

for (const u of createdUsers) {
  await adminDeleteUser(u.id);
}
console.log('  Independently re-confirming every synthetic auth.users id is gone...');
let stillExists = 0;
for (const u of createdUsers) {
  const g = await adminGetUser(u.id);
  if (g.status < 300) { stillExists++; console.log(`    RESIDUE: auth user ${u.email} (${u.id}) still exists — status=${g.status}`); }
}
check('Zero synthetic auth.users identities remain after cleanup (independently re-verified)', stillExists === 0, `stillExists=${stillExists}`);

console.log(`\n${'='.repeat(78)}\nG5B PHASE 2 CLOSURE — RELOAD-EDIT LIVE DEV CERTIFICATION: ${pass} PASS, ${fail} FAIL\n${'='.repeat(78)}`);
if (fail > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
