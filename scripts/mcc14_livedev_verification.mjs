#!/usr/bin/env node
// MCC-14 fix (migration 0111) — LIVE DEV behavioral re-verification, real
// hosted Supabase (vqycarelcoijzwlpkpcz), NOT PGlite. Follow-up to the
// already-complete PGlite certification (scripts/mcc14_delete_cascade_certification.mjs,
// 31/31). Proves the same 6 required behaviors against real Postgres via
// real PostgREST + the real Supabase Auth Admin API, using ONLY synthetic
// test users (email pattern mcc14-livedev-*@fhip-test.invalid), fully
// cleaned up at the end.
//
// Restrictions honoured: DEV only (vqycarelcoijzwlpkpcz, via
// NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — NEVER
// PRODUCTION_SUPABASE_SERVICE_ROLE_KEY). No migrations applied. No writes to
// any table outside rows this script itself created for its own synthetic
// users. Read-only for everything else.
//
// Run: node scripts/mcc14_livedev_verification.mjs

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e?.stack || e)); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvLocal() {
  const text = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnvLocal();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY; // DEV service role — NEVER PRODUCTION_SUPABASE_SERVICE_ROLE_KEY
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!BASE || !SERVICE || !ANON) { console.error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local'); process.exit(2); }
if (!BASE.includes('vqycarelcoijzwlpkpcz')) { console.error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${BASE}) is not the known DEV project (vqycarelcoijzwlpkpcz). This script must only ever target DEV.`); process.exit(2); }

const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

var pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

// ---------------------------------------------------------------------------
// Admin API helpers
async function adminCreateUser(email, password) {
  const r = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: 'POST', headers: SH,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await r.json();
  if (r.status >= 300) throw new Error(`adminCreateUser(${email}) failed: HTTP ${r.status} ${JSON.stringify(body)}`);
  return body.id;
}
async function adminGetUser(id) {
  const r = await fetch(`${BASE}/auth/v1/admin/users/${id}`, { headers: SH });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function adminDeleteUser(id) {
  const r = await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH });
  const body = await r.text();
  return { status: r.status, body };
}
async function signIn(email, password) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json();
  if (r.status >= 300) throw new Error(`signIn(${email}) failed: HTTP ${r.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

// PostgREST helpers
async function svc(method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method, headers: { ...SH, Prefer: 'return=representation' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json };
}
async function asUser(accessToken, method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: { apikey: ANON, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation,count=exact' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json, contentRange: r.headers.get('content-range') };
}

const rid = () => crypto.randomBytes(4).toString('hex');
const PASSWORD = 'Mcc14LiveDev!' + crypto.randomBytes(6).toString('hex');
const createdUserIds = []; // for cleanup + final residue check

console.log('=== MCC-14 (migration 0111) LIVE DEV verification ===');
console.log('Target:', BASE);
console.log('Run at:', new Date().toISOString());

// ---------------------------------------------------------------------------
console.log('\n=== 0. Reference data (read-only) ===');
const countriesRes = await fetch(`${BASE}/rest/v1/countries?select=country_code&is_supported=eq.true&limit=1`, { headers: SH });
const countries = await countriesRes.json();
const COUNTRY = countries[0]?.country_code;
const currenciesRes = await fetch(`${BASE}/rest/v1/currencies?select=currency_code&currency_code=eq.AUD&limit=1`, { headers: SH });
const currencies = await currenciesRes.json();
const CURRENCY = currencies[0]?.currency_code || 'AUD';
check('Resolved a real supported country_code from live DEV', !!COUNTRY, `(${COUNTRY})`);
check('Resolved a real currency_code from live DEV', !!CURRENCY, `(${CURRENCY})`);
if (!COUNTRY || !CURRENCY) { console.error('FATAL: cannot proceed without reference data'); process.exit(3); }

// Representative sample of the ~85 backstopped tables (already proven as the
// full 85-table sweep in PGlite) — spans both foundational modules (0001:
// user_goals, 0003: the other 7), all governed by the same generic
// enforce_country_confirmed() trigger + "own rows ... for all" RLS policy.
const SAMPLE_TABLES = [
  { table: 'income_sources', row: (uid) => ({ user_id: uid, source_name: 'MCC14 livedev income', income_type: 'salary', amount: 100, frequency: 'monthly', currency_code: CURRENCY }) },
  { table: 'expense_items', row: (uid) => ({ user_id: uid, expense_name: 'MCC14 livedev expense', expense_category: 'other', amount: 50, frequency: 'monthly', currency_code: CURRENCY }) },
  { table: 'assets', row: (uid) => ({ user_id: uid, asset_name: 'MCC14 livedev asset', asset_class: 'cash', current_value: 1000, currency_code: CURRENCY }) },
  { table: 'liabilities', row: (uid) => ({ user_id: uid, liability_name: 'MCC14 livedev liability', debt_type: 'other', balance: 200, currency_code: CURRENCY }) },
  { table: 'investments', row: (uid) => ({ user_id: uid, investment_name: 'MCC14 livedev investment', investment_type: 'shares', current_value: 500, currency_code: CURRENCY }) },
  { table: 'retirement_accounts', row: (uid) => ({ user_id: uid, account_name: 'MCC14 livedev retirement', account_type: 'other', current_balance: 300, currency_code: CURRENCY }) },
  { table: 'insurance_policies', row: (uid) => ({ user_id: uid, policy_name: 'MCC14 livedev insurance', cover_type: 'life', cover_amount: 10000, premium: 20, premium_frequency: 'monthly', currency_code: CURRENCY }) },
  { table: 'user_goals', row: (uid) => ({ user_id: uid, goal_name: 'MCC14 livedev goal', goal_type: 'savings', target_amount: 5000, currency_code: CURRENCY }) },
];
console.log(`Representative sample: ${SAMPLE_TABLES.length} tables (${SAMPLE_TABLES.map((t) => t.table).join(', ')})`);

async function seedSample(uid) {
  const results = {};
  for (const { table, row } of SAMPLE_TABLES) {
    const { status, body } = await svc('POST', table, row(uid));
    results[table] = { status, id: Array.isArray(body) ? body[0]?.id : undefined, body };
  }
  return results;
}
async function countOwned(table, uid) {
  const r = await fetch(`${BASE}/rest/v1/${table}?select=id&user_id=eq.${uid}`, { headers: { ...SH, Prefer: 'count=exact' } });
  const range = r.headers.get('content-range');
  return range ? Number(range.split('/')[1]) : null;
}
async function confirmCountry(uid) {
  const { status, body } = await svc('PATCH', `user_profiles?user_id=eq.${uid}`, {
    onboarding_completed: true, country_of_residence: COUNTRY, country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED',
  });
  return { status, body };
}
async function setUnconfirmed(uid) {
  // Onboarded, country never confirmed (country_confirmed_at null) — the
  // realistic "unconfirmed" state, distinct from "never touched country".
  const { status, body } = await svc('PATCH', `user_profiles?user_id=eq.${uid}`, {
    onboarding_completed: true, country_of_residence: COUNTRY, country_confirmed_at: null, country_source: null,
  });
  return { status, body };
}

// ===========================================================================
console.log('\n=== PROOF 1: confirmed-user account deletion succeeds ===');
const email1 = `mcc14-livedev-confirmed-${rid()}@fhip-test.invalid`;
const uid1 = await adminCreateUser(email1, PASSWORD);
createdUserIds.push(uid1);
console.log(`  created ${email1} -> ${uid1}`);
const conf1 = await confirmCountry(uid1);
check('Proof 1 setup: user_profiles PATCH to confirm country succeeded', conf1.status < 300, `(HTTP ${conf1.status})`);
const seed1 = await seedSample(uid1);
const seed1Ok = Object.values(seed1).every((r) => r.status < 300 && r.id);
check('Proof 1 setup: seeded a real row in every one of the 8 sample tables', seed1Ok, JSON.stringify(Object.fromEntries(Object.entries(seed1).map(([t, r]) => [t, r.status]))));
{
  const before = {};
  for (const { table } of SAMPLE_TABLES) before[table] = await countOwned(table, uid1);
  console.log('  pre-delete row counts:', JSON.stringify(before));
}
const del1 = await adminDeleteUser(uid1);
check('Proof 1: DELETE /auth/v1/admin/users/:id for the CONFIRMED user succeeds with no error', del1.status >= 200 && del1.status < 300, `(HTTP ${del1.status} ${del1.body.slice(0, 200)})`);
const get1 = await adminGetUser(uid1);
check('Proof 1: auth.users row for the confirmed user is actually gone (Admin API 404s)', get1.status === 404, `(HTTP ${get1.status})`);

// ===========================================================================
console.log('\n=== PROOF 2: unconfirmed-user account deletion succeeds (the actual MCC-14 bug) ===');
const email2 = `mcc14-livedev-unconfirmed-${rid()}@fhip-test.invalid`;
const uid2 = await adminCreateUser(email2, PASSWORD);
createdUserIds.push(uid2);
console.log(`  created ${email2} -> ${uid2}`);
const unconf2 = await setUnconfirmed(uid2);
check('Proof 2 setup: user_profiles PATCH to set unconfirmed state succeeded', unconf2.status < 300, `(HTTP ${unconf2.status})`);
const profCheck2 = await fetch(`${BASE}/rest/v1/user_profiles?select=country_confirmed_at,onboarding_completed&user_id=eq.${uid2}`, { headers: SH }).then((r) => r.json());
check('Proof 2 setup: confirmed genuinely unconfirmed (country_confirmed_at is null, onboarding_completed true)', profCheck2[0]?.country_confirmed_at === null && profCheck2[0]?.onboarding_completed === true, JSON.stringify(profCheck2[0]));
const seed2 = await seedSample(uid2);
const seed2Ok = Object.values(seed2).every((r) => r.status < 300 && r.id);
check('Proof 2 setup: seeded a real row in every one of the 8 sample tables for the UNCONFIRMED user', seed2Ok, JSON.stringify(Object.fromEntries(Object.entries(seed2).map(([t, r]) => [t, r.status]))));
const del2 = await adminDeleteUser(uid2);
check('Proof 2: DELETE /auth/v1/admin/users/:id for the UNCONFIRMED user succeeds with no error (this is the MCC-14 fix)', del2.status >= 200 && del2.status < 300, `(HTTP ${del2.status} ${del2.body.slice(0, 200)})`);
const get2 = await adminGetUser(uid2);
check('Proof 2: auth.users row for the unconfirmed user is actually gone (Admin API 404s)', get2.status === 404, `(HTTP ${get2.status})`);

// ===========================================================================
console.log('\n=== PROOF 6: no orphaned rows remain after Proof 1 + Proof 2 deletions ===');
const orphans = [];
for (const { table } of SAMPLE_TABLES) {
  const n1 = await countOwned(table, uid1);
  const n2 = await countOwned(table, uid2);
  if (n1 > 0) orphans.push({ table, user: 'confirmed(uid1)', n: n1 });
  if (n2 > 0) orphans.push({ table, user: 'unconfirmed(uid2)', n: n2 });
}
check('Proof 6: zero orphaned rows across all 8 sample tables for BOTH deleted users', orphans.length === 0, JSON.stringify(orphans));

// ===========================================================================
console.log('\n=== PROOF 3: direct DELETE by an UNCONFIRMED user (account still exists) remains BLOCKED ===');
const email3 = `mcc14-livedev-directunconf-${rid()}@fhip-test.invalid`;
const uid3 = await adminCreateUser(email3, PASSWORD);
createdUserIds.push(uid3);
console.log(`  created ${email3} -> ${uid3}`);
await setUnconfirmed(uid3);
const seed3 = await svc('POST', 'assets', { user_id: uid3, asset_name: 'MCC14 direct-blocked asset', asset_class: 'cash', current_value: 111, currency_code: CURRENCY });
check('Proof 3 setup: seeded one assets row for the still-unconfirmed direct-delete test user', seed3.status < 300 && seed3.body[0]?.id, `(HTTP ${seed3.status})`);
const assetId3 = seed3.body[0]?.id;
const token3 = await signIn(email3, PASSWORD);
const directDel3 = await asUser(token3, 'DELETE', `assets?id=eq.${assetId3}`);
check(
  "Proof 3: direct DELETE via the user's own authenticated client is REJECTED with COUNTRY_CONFIRMATION_REQUIRED / 42501",
  directDel3.status === 403 && JSON.stringify(directDel3.body).includes('COUNTRY_CONFIRMATION_REQUIRED') && JSON.stringify(directDel3.body).includes('42501'),
  `(HTTP ${directDel3.status} ${JSON.stringify(directDel3.body).slice(0, 220)})`
);
const stillThere3 = await countOwned('assets', uid3);
check('Proof 3: the row was NOT deleted — still present after the blocked attempt', stillThere3 === 1, `(count=${stillThere3})`);

// ===========================================================================
console.log('\n=== PROOF 4: direct DELETE by a CONFIRMED owner remains allowed where RLS permits ===');
const email4 = `mcc14-livedev-directconf-${rid()}@fhip-test.invalid`;
const uid4 = await adminCreateUser(email4, PASSWORD);
createdUserIds.push(uid4);
console.log(`  created ${email4} -> ${uid4}`);
await confirmCountry(uid4);
const seed4 = await svc('POST', 'assets', { user_id: uid4, asset_name: 'MCC14 direct-allowed asset', asset_class: 'cash', current_value: 222, currency_code: CURRENCY });
check('Proof 4 setup: seeded one assets row for the confirmed direct-delete test user', seed4.status < 300 && seed4.body[0]?.id, `(HTTP ${seed4.status})`);
const assetId4 = seed4.body[0]?.id;
const token4 = await signIn(email4, PASSWORD);
const directDel4 = await asUser(token4, 'DELETE', `assets?id=eq.${assetId4}`);
check("Proof 4: direct DELETE via the confirmed owner's own authenticated client SUCCEEDS", directDel4.status >= 200 && directDel4.status < 300, `(HTTP ${directDel4.status})`);
const stillThere4 = await countOwned('assets', uid4);
check('Proof 4: the row is genuinely gone', stillThere4 === 0, `(count=${stillThere4})`);

// ===========================================================================
console.log('\n=== PROOF 5: cross-tenant DELETE remains blocked regardless of confirmation state ===');
const emailOwner = `mcc14-livedev-crossowner-${rid()}@fhip-test.invalid`;
const emailAttacker = `mcc14-livedev-crossattacker-${rid()}@fhip-test.invalid`;
const uidOwner = await adminCreateUser(emailOwner, PASSWORD);
const uidAttacker = await adminCreateUser(emailAttacker, PASSWORD);
createdUserIds.push(uidOwner, uidAttacker);
console.log(`  created owner ${emailOwner} -> ${uidOwner}`);
console.log(`  created attacker ${emailAttacker} -> ${uidAttacker}`);
await confirmCountry(uidOwner);       // owner: confirmed
await setUnconfirmed(uidAttacker);    // attacker: deliberately UNCONFIRMED — proves RLS blocks it independent of the trigger
const seedOwner = await svc('POST', 'assets', { user_id: uidOwner, asset_name: 'MCC14 cross-tenant target asset', asset_class: 'cash', current_value: 333, currency_code: CURRENCY });
check('Proof 5 setup: seeded a real row owned by the (confirmed) owner user', seedOwner.status < 300 && seedOwner.body[0]?.id, `(HTTP ${seedOwner.status})`);
const ownerAssetId = seedOwner.body[0]?.id;
const attackerToken = await signIn(emailAttacker, PASSWORD);
const crossDel = await asUser(attackerToken, 'DELETE', `assets?id=eq.${ownerAssetId}`);
// RLS silently filters out rows the caller doesn't own — PostgREST returns
// 200/204 with 0 rows affected (via count=exact Content-Range), NOT a 403.
// This is the correct signature of "RLS, not the trigger, blocked it".
const crossCount = crossDel.contentRange ? Number(crossDel.contentRange.split('/')[1]) : (Array.isArray(crossDel.body) ? crossDel.body.length : null);
check("Proof 5: the attacker's cross-tenant DELETE affects 0 rows (RLS-blocked, not trigger-blocked)", crossCount === 0, `(HTTP ${crossDel.status}, rows affected=${crossCount})`);
const ownerRowStill = await countOwned('assets', uidOwner);
check("Proof 5: the owner's row is completely untouched", ownerRowStill === 1, `(count=${ownerRowStill})`);

// ===========================================================================
console.log('\n=== CLEANUP: delete every synthetic user + independently re-confirm zero residue ===');
// uid1/uid2 already deleted (Proofs 1/2). uid3/uid4/uidOwner/uidAttacker
// still exist and must be deleted now via the Admin API (itself another
// live instance of the exact MCC-14 cascade this migration fixes — uid3 in
// particular is STILL unconfirmed at this point).
const stillAlive = [
  ['directunconf(uid3)', uid3], ['directconf(uid4)', uid4], ['crossowner', uidOwner], ['crossattacker', uidAttacker],
];
for (const [label, id] of stillAlive) {
  const d = await adminDeleteUser(id);
  check(`Cleanup: account deletion for ${label} succeeds`, d.status >= 200 && d.status < 300, `(HTTP ${d.status})`);
}

console.log('\n  Independently re-querying every sample table for every synthetic user id created in this run...');
const residue = [];
for (const uid of createdUserIds) {
  for (const { table } of SAMPLE_TABLES) {
    const n = await countOwned(table, uid);
    if (n > 0) residue.push({ table, uid, n });
  }
}
check('Cleanup: zero residual rows across all 8 sample tables for all 6 synthetic users', residue.length === 0, JSON.stringify(residue));

console.log('\n  Independently re-confirming every synthetic auth.users id is gone...');
let allGone = true;
for (const uid of createdUserIds) {
  const g = await adminGetUser(uid);
  if (g.status !== 404) { allGone = false; console.log(`    STILL PRESENT: ${uid} (HTTP ${g.status})`); }
}
check('Cleanup: every synthetic auth.users row (all 6) is confirmed gone via the Admin API', allGone);

// Belt-and-braces: sweep by email pattern too, in case any id above was
// somehow wrong — list users matching the distinctive test pattern.
const listRes = await fetch(`${BASE}/auth/v1/admin/users?per_page=1000`, { headers: SH });
const listBody = await listRes.json();
const leftoverByEmail = (listBody.users || []).filter((u) => /^mcc14-livedev-.*@fhip-test\.invalid$/.test(u.email || ''));
check('Cleanup: no leftover auth.users match the mcc14-livedev-*@fhip-test.invalid pattern', leftoverByEmail.length === 0, JSON.stringify(leftoverByEmail.map((u) => u.email)));

// ===========================================================================
console.log(`\n${'='.repeat(78)}\nMCC-14 LIVE DEV VERIFICATION: ${pass} PASS, ${fail} FAIL\n${'='.repeat(78)}`);
if (fail) { console.log('FAILED CHECKS:', failures.join(' | ')); process.exit(1); }
process.exit(0);
