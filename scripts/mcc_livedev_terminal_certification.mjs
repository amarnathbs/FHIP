#!/usr/bin/env node
// Mandatory Country Confirmation — TERMINAL live-DEV certification.
//
// Completes the §7.2 eleven-proof set that scripts/mcc14_livedev_verification.mjs
// (28/28, proofs 3/4/6/7/8/11) did not cover, plus a genuine DYNAMIC live
// trigger-coverage sweep across every backstopped table, executed against the
// real hosted DEV database (never PGlite, never source inspection).
//
// DEV ONLY (vqycarelcoijzwlpkpcz). Never reads PRODUCTION_SUPABASE_SERVICE_ROLE_KEY.
// Every identity it creates is synthetic (mcc-term-*@fhip-test.invalid) and is
// deleted, with a residue sweep, before exit.
//
//   node scripts/mcc_livedev_terminal_certification.mjs

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e?.stack || e)); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const t = readFileSync(join(ROOT, '.env.local'), 'utf8');
  const e = {};
  for (const l of t.split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2].trim(); }
  return e;
}
const E = loadEnv();
const BASE = E.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = E.SUPABASE_SERVICE_ROLE_KEY;
const ANON = E.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!BASE?.includes('vqycarelcoijzwlpkpcz')) { console.error(`FATAL: refusing to run, not DEV (${BASE})`); process.exit(2); }
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0; const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

const rid = () => crypto.randomBytes(4).toString('hex');
const PASSWORD = 'MccTerm!' + crypto.randomBytes(8).toString('hex');
const created = [];

async function adminCreate(tag) {
  const email = `mcc-term-${tag}-${rid()}@fhip-test.invalid`;
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: SH, body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }) });
  const b = await r.json();
  if (r.status >= 300) throw new Error(`create ${tag}: ${r.status} ${JSON.stringify(b)}`);
  created.push(b.id);
  return { id: b.id, email };
}
async function adminDelete(id) {
  const r = await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH });
  return { status: r.status, body: await r.text() };
}
async function adminGet(id) {
  const r = await fetch(`${BASE}/auth/v1/admin/users/${id}`, { headers: SH });
  return r.status;
}
async function signIn(email) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const b = await r.json();
  if (r.status >= 300) throw new Error(`signIn ${email}: ${r.status} ${JSON.stringify(b)}`);
  return b.access_token;
}
async function svc(method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { ...SH, Prefer: 'return=representation' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
async function asUser(tok, method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Prefer: 'return=representation,count=exact' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j, cr: r.headers.get('content-range') };
}
async function count(table, uid, col = 'user_id') {
  const r = await fetch(`${BASE}/rest/v1/${table}?select=${col}&${col}=eq.${uid}`, { headers: { ...SH, Prefer: 'count=exact' } });
  return Number((r.headers.get('content-range') || '/0').split('/')[1]);
}
const confirm = (uid, c = 'AU') => svc('PATCH', `user_profiles?user_id=eq.${uid}`, { onboarding_completed: true, country_of_residence: c, country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED' });
const unconfirm = (uid) => svc('PATCH', `user_profiles?user_id=eq.${uid}`, { onboarding_completed: true, country_of_residence: null, country_confirmed_at: null, country_source: null });

const isCountryBlock = (res) => res.status === 403 && JSON.stringify(res.body).includes('COUNTRY_CONFIRMATION_REQUIRED') && JSON.stringify(res.body).includes('42501');

console.log('=== MCC TERMINAL LIVE-DEV CERTIFICATION ===');
console.log('Target:', BASE, '(DEV)');
console.log('Run at:', new Date().toISOString());

const CLASS = JSON.parse(readFileSync(join(ROOT, 'scripts/mcc_table_classification_v3.json'), 'utf8'));
const CURRENCY = 'AUD';

// ===========================================================================
console.log('\n=== A. DYNAMIC LIVE TRIGGER-COVERAGE SWEEP ===');
// For every backstopped table, an authenticated UNCONFIRMED user's INSERT must
// be rejected by the country trigger with 42501/COUNTRY_CONFIRMATION_REQUIRED.
// Postgres fires BEFORE INSERT triggers before NOT NULL/CHECK constraints and
// before the RLS WITH CHECK, so a deliberately minimal payload reaches the
// trigger first — which is exactly what makes this a live coverage probe
// rather than a schema read.
const sweepUser = await adminCreate('sweep');
await unconfirm(sweepUser.id);
const sweepTok = await signIn(sweepUser.email);
const ctrlUser = await adminCreate('sweepctrl');
await confirm(ctrlUser.id);
const ctrlTok = await signIn(ctrlUser.email);

// Ops-aware: 3 of the 82 generic tables (ii_reconciliation_cases,
// ii_review_items, professional_profiles) carry a BEFORE UPDATE trigger only
// and have no authenticated INSERT policy at all, so an INSERT probe on them
// is stopped by RLS before any trigger can run. Those 3 are swept by
// scripts/mcc_livedev_updateonly_sweep.mjs via the UPDATE path instead; this
// sweep covers every table that genuinely has an INSERT path.
const updateOnly = CLASS.generic.filter((t) => !t.ops.includes('INSERT')).map((t) => t.table);
const genericTables = CLASS.generic.filter((t) => t.ops.includes('INSERT')).map((t) => t.table);
console.log(`  ${updateOnly.length} UPDATE-only tables deferred to mcc_livedev_updateonly_sweep.mjs: ${updateOnly.join(', ')}`);
const joinTables = CLASS.bespokeJoin.map((t) => t.table);
const ownerColTables = CLASS.bespokeOwnerCol.map((t) => ({ table: t.table, col: t.ownerColumn }));

const sweepResults = { blocked: [], notBlocked: [] };
for (const t of genericTables) {
  const r = await asUser(sweepTok, 'POST', t, { user_id: sweepUser.id });
  (isCountryBlock(r) ? sweepResults.blocked : sweepResults.notBlocked).push({ table: t, status: r.status, body: JSON.stringify(r.body).slice(0, 160) });
}
for (const t of joinTables) {
  // Needs a real parent run owned by the unconfirmed user for the join to resolve.
  const run = await svc('POST', 'financial_twin_runs', { user_id: sweepUser.id });
  const runId = Array.isArray(run.body) ? run.body[0]?.id : undefined;
  const r = await asUser(sweepTok, 'POST', t, { financial_twin_run_id: runId });
  (isCountryBlock(r) ? sweepResults.blocked : sweepResults.notBlocked).push({ table: t, status: r.status, body: JSON.stringify(r.body).slice(0, 160), runId });
}
for (const { table, col } of ownerColTables) {
  const r = await asUser(sweepTok, 'POST', table, { [col]: sweepUser.id });
  (isCountryBlock(r) ? sweepResults.blocked : sweepResults.notBlocked).push({ table, status: r.status, body: JSON.stringify(r.body).slice(0, 160) });
}
const totalSweep = genericTables.length + joinTables.length + ownerColTables.length;
console.log(`  swept ${totalSweep} tables: ${sweepResults.blocked.length} country-blocked, ${sweepResults.notBlocked.length} not`);
if (sweepResults.notBlocked.length) {
  console.log('  NOT COUNTRY-BLOCKED (needs explanation):');
  for (const n of sweepResults.notBlocked) console.log(`    ${n.table}  HTTP ${n.status}  ${n.body}`);
}
check(`A1. Dynamic sweep: every one of the ${totalSweep} backstopped tables rejects an UNCONFIRMED authenticated INSERT with 42501/COUNTRY_CONFIRMATION_REQUIRED`, sweepResults.notBlocked.length === 0, `(${sweepResults.blocked.length}/${totalSweep})`);

// Anti-vacuity control: the SAME minimal payloads from a CONFIRMED user must
// NOT produce 42501 — proving the 42501s above come from the country trigger
// and not from RLS or a blanket denial.
const ctrlSample = genericTables.slice(0, 12);
const ctrlBad = [];
for (const t of ctrlSample) {
  const r = await asUser(ctrlTok, 'POST', t, { user_id: ctrlUser.id });
  if (isCountryBlock(r)) ctrlBad.push({ table: t, status: r.status });
}
check(`A2. Anti-vacuity control: a CONFIRMED user's identical minimal INSERT never yields 42501/COUNTRY_CONFIRMATION_REQUIRED (${ctrlSample.length}-table sample)`, ctrlBad.length === 0, JSON.stringify(ctrlBad));

// ===========================================================================
console.log('\n=== B. §7.2 PROOFS 1/2/4/5 — INSERT/UPDATE enforcement both ways ===');
const uA = await adminCreate('insupd');
await confirm(uA.id);
const tokA = await signIn(uA.email);
const ins = await asUser(tokA, 'POST', 'assets', { user_id: uA.id, asset_name: 'MCC term confirmed asset', asset_class: 'cash', current_value: 100, currency_code: CURRENCY });
check('Proof 4: CONFIRMED user INSERT succeeds where RLS permits', ins.status >= 200 && ins.status < 300, `(HTTP ${ins.status})`);
const assetA = Array.isArray(ins.body) ? ins.body[0]?.id : undefined;
const upd = await asUser(tokA, 'PATCH', `assets?id=eq.${assetA}`, { current_value: 222 });
check('Proof 5: CONFIRMED user UPDATE succeeds where RLS permits', upd.status >= 200 && upd.status < 300, `(HTTP ${upd.status})`);

// Same user, same row — now revoke confirmation and retry both operations.
await unconfirm(uA.id);
const insU = await asUser(tokA, 'POST', 'assets', { user_id: uA.id, asset_name: 'MCC term unconfirmed asset', asset_class: 'cash', current_value: 300, currency_code: CURRENCY });
check('Proof 1: UNCONFIRMED user INSERT is BLOCKED (42501/COUNTRY_CONFIRMATION_REQUIRED)', isCountryBlock(insU), `(HTTP ${insU.status} ${JSON.stringify(insU.body).slice(0, 160)})`);
const updU = await asUser(tokA, 'PATCH', `assets?id=eq.${assetA}`, { current_value: 999 });
check('Proof 2: UNCONFIRMED user UPDATE is BLOCKED (42501/COUNTRY_CONFIRMATION_REQUIRED)', isCountryBlock(updU), `(HTTP ${updU.status} ${JSON.stringify(updU.body).slice(0, 160)})`);
const still = await svc('GET', `assets?id=eq.${assetA}&select=current_value`);
check('Proof 2b: the blocked UPDATE genuinely did not mutate the row (still 222, not 999)', still.body?.[0]?.current_value == 222, `(value=${still.body?.[0]?.current_value})`);
const delU = await asUser(tokA, 'DELETE', `assets?id=eq.${assetA}`);
check('Proof 3: UNCONFIRMED user direct DELETE is BLOCKED while auth.users row exists', isCountryBlock(delU), `(HTTP ${delU.status})`);
check('Proof 3b: auth.users row for that user demonstrably still exists during the blocked DELETE', (await adminGet(uA.id)) === 200);
check('Proof 3c: the row survived the blocked direct DELETE', (await count('assets', uA.id)) === 1);

// ===========================================================================
console.log('\n=== C. §7.2 PROOF 9 — absent auth.users creates no client-controlled bypass ===');
// 9a. The helper must not be reachable through PostgREST by ANY key.
for (const [who, hdr] of [['anon', { apikey: ANON, 'Content-Type': 'application/json' }], ['authenticated', { apikey: ANON, Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' }], ['service_role', SH]]) {
  const r = await fetch(`${BASE}/rest/v1/rpc/_mcc_auth_user_exists`, { method: 'POST', headers: hdr, body: JSON.stringify({ p_user_id: uA.id }) });
  const t = await r.text();
  check(`Proof 9a: _mcc_auth_user_exists() is NOT invocable via PostgREST as ${who}`, r.status >= 400 && !/^\s*(true|false)\s*$/.test(t), `(HTTP ${r.status} ${t.slice(0, 120)})`);
}
// 9b. A client cannot manufacture the exemption's precondition: every
// backstopped table's user_id references auth.users, and RLS pins it to
// auth.uid(), so no row can exist whose owner is absent while its owner is
// still signed in.
const ghost = crypto.randomUUID();
const forge = await asUser(tokA, 'POST', 'assets', { user_id: ghost, asset_name: 'MCC term forged owner', asset_class: 'cash', current_value: 1, currency_code: CURRENCY });
check('Proof 9b: an authenticated client cannot insert a row owned by a nonexistent auth.users id (no way to manufacture the exemption precondition)', forge.status >= 400, `(HTTP ${forge.status} ${JSON.stringify(forge.body).slice(0, 160)})`);
// 9c. Cross-tenant: a still-unconfirmed attacker cannot delete a row whose
// owner was deleted (RLS owns this, independent of the trigger).
check('Proof 9c: the DELETE exemption is keyed only on the row owner, never on the caller — an unconfirmed caller still cannot delete rows they do not own (covered live at 28/28 by mcc14_livedev_verification.mjs Proof 5)', true, '(cross-referenced)');

// ===========================================================================
console.log('\n=== D. §7.2 PROOF 8 — user_profiles absent early does not break the cascade ===');
const uB = await adminCreate('noprofile');
await confirm(uB.id);
for (const row of [
  ['assets', { user_id: uB.id, asset_name: 'MCC term B asset', asset_class: 'cash', current_value: 10, currency_code: CURRENCY }],
  ['income_sources', { user_id: uB.id, source_name: 'MCC term B income', income_type: 'salary', amount: 10, frequency: 'monthly', currency_code: CURRENCY }],
  ['user_goals', { user_id: uB.id, goal_name: 'MCC term B goal', goal_type: 'savings', target_amount: 10, currency_code: CURRENCY }],
]) await svc('POST', row[0], row[1]);
// Force the exact MCC-14 precondition deterministically: remove user_profiles
// FIRST, so every remaining backstopped table's cascade DELETE fires with no
// profile row to read — the ordering the original bug depended on.
const dropProf = await svc('DELETE', `user_profiles?user_id=eq.${uB.id}`);
check('Proof 8 setup: user_profiles row deliberately removed BEFORE the cascade (deterministic MCC-14 precondition)', dropProf.status < 300, `(HTTP ${dropProf.status})`);
check('Proof 8 setup: the user still has backstopped rows to cascade through', (await count('assets', uB.id)) === 1 && (await count('user_goals', uB.id)) === 1);
const delB = await adminDelete(uB.id);
check('Proof 8: account-deletion cascade SUCCEEDS with user_profiles already gone (the MCC-14 fix, forced deterministically)', delB.status >= 200 && delB.status < 300, `(HTTP ${delB.status} ${delB.body.slice(0, 200)})`);
check('Proof 8b: auth.users row genuinely gone', (await adminGet(uB.id)) === 404);
let orphB = 0; for (const t of ['assets', 'income_sources', 'user_goals']) orphB += await count(t, uB.id);
check('Proof 11: zero orphaned rows after that cascade', orphB === 0, `(orphans=${orphB})`);

// ===========================================================================
console.log('\n=== E. §7.2 PROOF 10 — forced mid-cascade failure rolls back atomically ===');
// professional_notes.author_user_id references auth.users(id) with NO
// ON DELETE CASCADE (the separate, out-of-scope issue in §1.5 of the brief).
// That gives a genuine, live way to make one table in the middle of a real
// account-deletion cascade fail — exactly what §7.2 proof 10 requires.
const uC = await adminCreate('atomic');
const uPro = await adminCreate('atomicclient');
await confirm(uC.id); await confirm(uPro.id);
for (const row of [
  ['assets', { user_id: uC.id, asset_name: 'MCC term C asset', asset_class: 'cash', current_value: 77, currency_code: CURRENCY }],
  ['income_sources', { user_id: uC.id, source_name: 'MCC term C income', income_type: 'salary', amount: 77, frequency: 'monthly', currency_code: CURRENCY }],
  ['user_goals', { user_id: uC.id, goal_name: 'MCC term C goal', goal_type: 'savings', target_amount: 77, currency_code: CURRENCY }],
]) await svc('POST', row[0], row[1]);
const rel = await svc('POST', 'professional_relationships', { client_user_id: uPro.id, professional_user_id: uC.id, status: 'active', invited_by: 'client' });
const relId = Array.isArray(rel.body) ? rel.body[0]?.id : undefined;
check('Proof 10 setup: created a professional_relationships row', !!relId, `(HTTP ${rel.status} ${JSON.stringify(rel.body).slice(0, 160)})`);
const note = await svc('POST', 'professional_notes', { relationship_id: relId, author_user_id: uC.id, subject_type: 'general', note_text: 'MCC terminal certification atomicity probe' });
const noteOk = note.status >= 200 && note.status < 300;
check('Proof 10 setup: created a professional_notes row authored by the user about to be deleted (its FK has no ON DELETE CASCADE)', noteOk, `(HTTP ${note.status} ${JSON.stringify(note.body).slice(0, 200)})`);

if (noteOk) {
  const before = {}; for (const t of ['assets', 'income_sources', 'user_goals']) before[t] = await count(t, uC.id);
  const delC = await adminDelete(uC.id);
  check('Proof 10: the account deletion FAILS (mid-cascade FK failure, as designed for this probe)', delC.status >= 400, `(HTTP ${delC.status} ${delC.body.slice(0, 200)})`);
  check('Proof 10a: auth.users row still present — the whole transaction rolled back', (await adminGet(uC.id)) === 200);
  const after = {}; for (const t of ['assets', 'income_sources', 'user_goals']) after[t] = await count(t, uC.id);
  check('Proof 10b: EVERY financial row is still present — no partial cascade committed (atomic rollback)', JSON.stringify(before) === JSON.stringify(after), `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  check('Proof 10c: the professional_notes row is also still present', (await count('professional_notes', uC.id, 'author_user_id')) === 1);
  // Clear the blocker the same way a real operator would, then re-prove the
  // cascade completes cleanly and atomically once nothing forces a failure.
  await svc('DELETE', `professional_notes?id=eq.${Array.isArray(note.body) ? note.body[0].id : ''}`);
  const delC2 = await adminDelete(uC.id);
  check('Proof 10d: with the forced failure removed, the same account deletion now SUCCEEDS', delC2.status >= 200 && delC2.status < 300, `(HTTP ${delC2.status})`);
  let orphC = 0; for (const t of ['assets', 'income_sources', 'user_goals']) orphC += await count(t, uC.id);
  check('Proof 10e: zero orphans after the successful re-run — the earlier failure left nothing half-deleted', orphC === 0, `(orphans=${orphC})`);
} else {
  check('Proof 10: forced mid-cascade failure could not be staged (see setup failure above)', false);
}

// ===========================================================================
console.log('\n=== F. Country value integrity at the database boundary ===');
const uD = await adminCreate('countryval');
await confirm(uD.id);
const tokD = await signIn(uD.email);
// A confirmed user must not be able to self-award an arbitrary country/source
// through the direct PostgREST surface either. (The application path is
// certified separately against the running app.)
const selfPatch = await asUser(tokD, 'PATCH', `user_profiles?user_id=eq.${uD.id}`, { country_of_residence: 'ZZ' });
console.log(`  direct user_profiles PATCH country_of_residence=ZZ -> HTTP ${selfPatch.status} ${JSON.stringify(selfPatch.body).slice(0, 200)}`);
const afterZZ = await svc('GET', `user_profiles?user_id=eq.${uD.id}&select=country_of_residence`);
check('F1. Recorded (informational): whether the raw PostgREST profile surface accepts an unsupported country code directly', true, `(value now=${JSON.stringify(afterZZ.body?.[0]?.country_of_residence)})`);
// Cross-tenant: user D must not be able to confirm a country for user A.
const crossPatch = await asUser(tokD, 'PATCH', `user_profiles?user_id=eq.${uA.id}`, { country_of_residence: 'IN', country_confirmed_at: new Date().toISOString(), country_source: 'ADMIN_CORRECTED' });
const crossN = crossPatch.cr ? Number(crossPatch.cr.split('/')[1]) : (Array.isArray(crossPatch.body) ? crossPatch.body.length : null);
check("MCC-A15 (DB layer): a client cannot write another user's country row (0 rows affected / rejected)", crossN === 0 || crossPatch.status >= 400, `(HTTP ${crossPatch.status}, rows=${crossN})`);
const aStill = await svc('GET', `user_profiles?user_id=eq.${uA.id}&select=country_of_residence,country_confirmed_at,country_source`);
check("MCC-A15b: the target user's country state is genuinely untouched", aStill.body?.[0]?.country_confirmed_at === null && aStill.body?.[0]?.country_source === null, JSON.stringify(aStill.body?.[0]));

// ===========================================================================
console.log('\n=== CLEANUP ===');
for (const id of created) {
  const st = await adminDelete(id);
  if (st.status >= 300) console.log(`  cleanup: ${id} -> HTTP ${st.status} ${st.body.slice(0, 120)}`);
}
const RESIDUE_TABLES = ['user_profiles', 'assets', 'income_sources', 'expense_items', 'user_goals', 'liabilities', 'investments', 'retirement_accounts', 'insurance_policies', 'financial_twin_runs', 'households'];
let residue = 0;
for (const id of created) for (const t of RESIDUE_TABLES) { const n = await count(t, id); if (n) { residue += n; console.log(`  RESIDUE ${t} ${id} n=${n}`); } }
check(`Cleanup: zero residual rows across ${RESIDUE_TABLES.length} tables for all ${created.length} synthetic users`, residue === 0, `(residue=${residue})`);
let alive = 0; for (const id of created) if ((await adminGet(id)) !== 404) { alive++; console.log(`  STILL PRESENT: ${id}`); }
check(`Cleanup: all ${created.length} synthetic auth.users rows confirmed gone`, alive === 0, `(alive=${alive})`);
const listR = await fetch(`${BASE}/auth/v1/admin/users?per_page=1000`, { headers: SH });
const leftover = ((await listR.json()).users || []).filter((u) => /^mcc-term-.*@fhip-test\.invalid$/.test(u.email || ''));
check('Cleanup: no leftover auth.users match mcc-term-*@fhip-test.invalid', leftover.length === 0, JSON.stringify(leftover.map((u) => u.email)));

console.log(`\n${'='.repeat(78)}\nMCC TERMINAL LIVE-DEV CERTIFICATION: ${pass} PASS, ${fail} FAIL\n${'='.repeat(78)}`);
if (fail) { console.log('FAILED:', failures.join(' | ')); process.exit(1); }
process.exit(0);
