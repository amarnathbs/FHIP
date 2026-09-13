// G8 Final Verification-Only Closure Pass -- Point 4: real live-DEV HTTP
// evidence for the G8.055 rollout-cohort primitive and its kill switch,
// composed inside requireModuleCapability() for the G5B_GENERIC_WRITE key
// (Income/Expenses/Insurance CREATE/UPDATE only -- see appCapability.ts's
// OPERATIONS_G5B_WRITE_CERTIFIED, the only 3 modules this key touches; FDH
// apply routes use a different, unrelated ModuleKey and are NOT gated by
// this rollout key at all -- confirmed by direct source search, not assumed).
//
// Uses an ISOLATED local dev server instance (never the shared hosted DEV
// deployment) pointed at real DEV Supabase, run across several short-lived
// server configurations (percentage/kill-switch/malformed-config), because
// resolveRolloutDecision() reads process.env directly and this session has
// no live env-mutation channel into an already-running Node process.
//
// Run per phase: npx tsx (this is plain .mjs) node scripts/g8_verify_live_dev_cohort_killswitch.mjs <phase> <baseUrl>
// Phases: setup | p50 | p100 | p0 | poff | pmalformed | cleanup
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const repoRoot = path.resolve(import.meta.dirname, '..');
const STATE_FILE = path.join(repoRoot, '.g8_verify_cohort_state.json');

function loadEnv() {
  const raw = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').replace(/^﻿/, '');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(SUPA_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const ROLLOUT_KEY = 'G5B_GENERIC_WRITE';
const VERSION = 'g8-verify-2026-09-13-v1';

function bucketFor(key, version, subjectId) {
  const digest = createHash('sha256').update(`rollout|${key}|${version}|${subjectId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = '') {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`;
  console.log(line);
  results.push(line);
  if (cond) pass++; else fail++;
}

function loadState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function makeUser(tag, { country, generic, confirmCountry = true }) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const email = `g8cohort-${tag}-${stamp}@example.com`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  const userId = data.user.id;

  if (confirmCountry) {
    const patch = { country_of_residence: country, country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED' };
    if (generic) {
      patch.generic_disclosure_version = 'G8-VERIFY-COHORT-V1';
      patch.generic_disclosure_acknowledged_at = new Date().toISOString();
      patch.generic_disclosure_country = country;
    }
    const { error: profErr } = await admin.from('user_profiles').update(patch).eq('user_id', userId);
    if (profErr) throw new Error(`profile update ${tag}: ${profErr.message}`);
  }
  // else: leave country fields untouched -- genuinely unconfirmed subject.

  const { data: signInData, error: signInErr } = await createClient(SUPA_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    .auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn ${tag}: ${signInErr.message}`);
  const projectRef = new URL(SUPA_URL).host.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(signInData.session), 'utf8').toString('base64');
  const cookie = `sb-${projectRef}-auth-token=${cookieValue}`;
  return { tag, userId, email, password, cookie };
}

async function appFetch(baseUrl, user, path_, { method = 'GET', body, extraHeaders = {} } = {}) {
  const headers = { Cookie: user.cookie, ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path_}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text };
}

const MODULES = {
  income: { createPath: '/api/income', idPath: (id) => `/api/income/${id}`, table: 'income_sources', payload: { source_name: 'g8 cohort income', income_type: 'salary', amount: 111, frequency: 'monthly', currency_code: 'AUD' } },
  expenses: { createPath: '/api/expenses', idPath: (id) => `/api/expenses/${id}`, table: 'expense_items', payload: { expense_name: 'g8 cohort expense', expense_category: 'housing', amount: 22, frequency: 'monthly', currency_code: 'AUD' } },
  insurance: { createPath: '/api/insurance', idPath: (id) => `/api/insurance/${id}`, table: 'insurance_policies', payload: { policy_name: 'g8 cohort policy', cover_type: 'life', cover_amount: 500, premium: 5, premium_frequency: 'monthly', currency_code: 'AUD' } },
};

async function rowCount(table, userId) {
  const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
  return count ?? 0;
}

async function phaseSetup() {
  console.log('=== SETUP: creating synthetic DEV users, computing buckets ===');
  const candidates = [];
  for (let i = 0; i < 6; i++) {
    candidates.push(await makeUser(`cand${i}`, { country: 'GB', generic: true }));
  }
  const buckets = candidates.map((u) => ({ ...u, bucket: bucketFor(ROLLOUT_KEY, VERSION, u.userId) }));
  buckets.sort((a, b) => a.bucket - b.bucket);
  console.log('Computed buckets:', buckets.map((u) => `${u.tag}=${u.bucket}`).join(', '));

  const included50 = buckets.find((u) => u.bucket < 50);
  const excluded50 = buckets.find((u) => u.bucket >= 50);
  if (!included50 || !excluded50) throw new Error('Could not find both an included and excluded candidate at 50% among 6 users -- extremely unlikely, but fail loudly rather than silently reuse a wrong one.');

  const auUser = await makeUser('au', { country: 'AU', generic: false });
  const unconfirmedUser = await makeUser('unconfirmed', { confirmCountry: false });

  const state = {
    version: VERSION,
    candidates: buckets,
    included50,
    excluded50,
    auUser,
    unconfirmedUser,
    createdRowIds: [], // { table, id }
  };
  saveState(state);
  console.log(`\nincluded50 = ${included50.tag} (bucket ${included50.bucket}, userId ${included50.userId})`);
  console.log(`excluded50 = ${excluded50.tag} (bucket ${excluded50.bucket}, userId ${excluded50.userId})`);
  console.log('State saved. Now start the dev server with the desired ROLLOUT_* config and run the next phase.');
}

async function phase50(baseUrl) {
  console.log('=== PHASE 50%: ROLLOUT_G5B_GENERIC_WRITE_PERCENTAGE=50 ===');
  const state = loadState();
  const { included50, excluded50, auUser, unconfirmedUser } = state;

  // -- included subject: CREATE succeeds on all 3 modules, twice (stability) --
  for (const [key, mod] of Object.entries(MODULES)) {
    const r1 = await appFetch(baseUrl, included50, mod.createPath, { method: 'POST', body: mod.payload });
    check(`[50%] included subject CREATE ${key} succeeds`, r1.status === 200 || r1.status === 201, JSON.stringify(r1.json));
    if (r1.json?.data?.id) state.createdRowIds.push({ table: mod.table, id: r1.json.data.id });
  }
  const repeat1 = await appFetch(baseUrl, included50, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check('[50%] included subject repeated request also succeeds (stable allocation)', repeat1.status === 200 || repeat1.status === 201, JSON.stringify(repeat1.json));
  if (repeat1.json?.data?.id) state.createdRowIds.push({ table: 'income_sources', id: repeat1.json.data.id });

  // -- excluded subject: CREATE denied on all 3 modules, no row created, twice (stability) --
  const beforeCounts = {};
  for (const [key, mod] of Object.entries(MODULES)) beforeCounts[key] = await rowCount(mod.table, excluded50.userId);

  for (const [key, mod] of Object.entries(MODULES)) {
    const r1 = await appFetch(baseUrl, excluded50, mod.createPath, { method: 'POST', body: mod.payload });
    check(`[50%] excluded subject CREATE ${key} denied`, r1.status === 403 || r1.status === 400, `status=${r1.status} body=${JSON.stringify(r1.json)}`);
    const after = await rowCount(mod.table, excluded50.userId);
    check(`[50%] excluded subject CREATE ${key} left stored rows unchanged`, after === beforeCounts[key], `before=${beforeCounts[key]} after=${after}`);
  }
  const repeat2 = await appFetch(baseUrl, excluded50, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check('[50%] excluded subject repeated request also denied (stable exclusion)', repeat2.status === 403 || repeat2.status === 400, `status=${repeat2.status}`);

  // -- forged parameters cannot force inclusion --
  const forged = await appFetch(baseUrl, excluded50, MODULES.income.createPath, {
    method: 'POST',
    body: { ...MODULES.income.payload, _rolloutOverride: true, rolloutPercentage: 100, userId: included50.userId },
    extraHeaders: { 'X-Fhip-Rollout-Percentage': '100', 'X-Fhip-User-Id': included50.userId, 'X-Forwarded-For': '1.2.3.4' },
  });
  check('[50%] forged body/header fields on excluded subject request cannot force inclusion', forged.status === 403 || forged.status === 400, `status=${forged.status}`);

  // -- AU control unaffected by rollout state at all --
  const auRes = await appFetch(baseUrl, auUser, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check('[50%] AU (FULL) user CREATE unaffected by rollout state', auRes.status === 200 || auRes.status === 201, JSON.stringify(auRes.json));
  if (auRes.json?.data?.id) state.createdRowIds.push({ table: 'income_sources', id: auRes.json.data.id });

  // -- unconfirmed subject: denied at MCC, before ever reaching rollout, regardless of bucket --
  const unconfirmedRes = await appFetch(baseUrl, unconfirmedUser, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check(
    '[50%] unconfirmed subject denied at country-confirmation gate (not a rollout-specific denial)',
    unconfirmedRes.status === 403 && unconfirmedRes.json?.error !== 'WRITE_NOT_CERTIFIED_FOR_GENERIC',
    `status=${unconfirmedRes.status} body=${JSON.stringify(unconfirmedRes.json)}`,
  );

  saveState(state);
}

async function phase100(baseUrl) {
  console.log('=== PHASE 100% (same version): monotonic-inclusion + kill-switch-restored narrative ===');
  const state = loadState();
  const { included50, excluded50 } = state;

  // Previously-included subject remains included when percentage rises.
  const r1 = await appFetch(baseUrl, included50, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check('[100%] previously-included subject (raised percentage, unchanged version) remains included', r1.status === 200 || r1.status === 201, JSON.stringify(r1.json));
  if (r1.json?.data?.id) state.createdRowIds.push({ table: 'income_sources', id: r1.json.data.id });

  // Previously-excluded-at-50% subject is now admitted at 100% -- same
  // subject, same version, bucket unchanged, only the threshold moved.
  const r2 = await appFetch(baseUrl, excluded50, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check('[100%] previously-excluded-at-50% subject is now admitted (kill-switch/percentage restored access)', r2.status === 200 || r2.status === 201, JSON.stringify(r2.json));
  if (r2.json?.data?.id) state.createdRowIds.push({ table: 'income_sources', id: r2.json.data.id });

  saveState(state);
}

async function phase0(baseUrl) {
  console.log('=== PHASE 0% (same version): valid config, everyone denied ===');
  const state = loadState();
  const { included50 } = state;
  const before = await rowCount('income_sources', included50.userId);
  const r1 = await appFetch(baseUrl, included50, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check('[0%] a subject who was included at every prior percentage is denied at a genuine 0% config', r1.status === 403 || r1.status === 400, `status=${r1.status}`);
  const after = await rowCount('income_sources', included50.userId);
  check('[0%] denied request left stored rows unchanged', after === before, `before=${before} after=${after}`);
  saveState(state);
}

async function phaseOff(baseUrl) {
  console.log('=== PHASE kill-switch OFF: ROLLOUT_G5B_GENERIC_WRITE_ENABLED unset, G4/G5B still true ===');
  const state = loadState();
  const { included50, excluded50 } = state;
  const r1 = await appFetch(baseUrl, included50, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check('[kill-switch OFF] a subject who would be included at any configured percentage is denied while the kill switch itself is off', r1.status === 403 || r1.status === 400, `status=${r1.status}`);
  const r2 = await appFetch(baseUrl, excluded50, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check('[kill-switch OFF] every subject denied uniformly, not just the ones who would fail the percentage bucket anyway', r2.status === 403 || r2.status === 400, `status=${r2.status}`);
  saveState(state);
}

async function phaseMalformed(baseUrl) {
  console.log('=== PHASE malformed config: ENABLED=true but PERCENTAGE out of range ===');
  const state = loadState();
  const { included50 } = state;
  const before = await rowCount('income_sources', included50.userId);
  const r1 = await appFetch(baseUrl, included50, MODULES.income.createPath, { method: 'POST', body: MODULES.income.payload });
  check('[malformed config] fails closed -- denied, never silently treated as 100%/permit', r1.status === 403 || r1.status === 400, `status=${r1.status}`);
  const after = await rowCount('income_sources', included50.userId);
  check('[malformed config] denied request left stored rows unchanged', after === before, `before=${before} after=${after}`);
  saveState(state);
}

async function phaseCleanup() {
  console.log('\n=== CLEANUP ===');
  const state = loadState();
  const allUsers = [...state.candidates, state.auUser, state.unconfirmedUser];
  for (const row of state.createdRowIds) {
    await admin.from(row.table).delete().eq('id', row.id);
  }
  for (const table of ['income_sources', 'expense_items', 'insurance_policies']) {
    await admin.from(table).delete().in('user_id', allUsers.map((u) => u.userId));
  }
  for (const u of allUsers) {
    const { error } = await admin.auth.admin.deleteUser(u.userId);
    if (error) console.error(`FAILED to delete user ${u.tag}: ${error.message}`);
  }
  let residue = 0;
  for (const u of allUsers) {
    const { data } = await admin.auth.admin.getUserById(u.userId);
    if (data?.user) { residue++; console.error(`RESIDUE: user ${u.tag} (${u.userId}) still exists`); }
  }
  for (const table of ['income_sources', 'expense_items', 'insurance_policies']) {
    const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).in('user_id', allUsers.map((u) => u.userId));
    if (count && count > 0) { residue++; console.error(`RESIDUE: ${count} rows remain in ${table}`); }
  }
  check('ZERO RESIDUE: all synthetic users and rows removed', residue === 0, `${residue} residue items`);
  fs.unlinkSync(STATE_FILE);
  console.log('\nState file removed.');
}

async function main() {
  const phase = process.argv[2];
  const baseUrl = process.argv[3];
  try {
    if (phase === 'setup') await phaseSetup();
    else if (phase === 'p50') await phase50(baseUrl);
    else if (phase === 'p100') await phase100(baseUrl);
    else if (phase === 'p0') await phase0(baseUrl);
    else if (phase === 'poff') await phaseOff(baseUrl);
    else if (phase === 'pmalformed') await phaseMalformed(baseUrl);
    else if (phase === 'cleanup') await phaseCleanup();
    else { console.error('Unknown phase. Use: setup | p50 | p100 | p0 | poff | pmalformed | cleanup'); process.exit(2); }
  } catch (e) {
    console.error('SCRIPT ERROR:', e.stack || e.message);
    fail++;
  }
  console.log(`\n=== SUMMARY (this phase): ${pass}/${pass + fail} checks passed ===`);
  if (fail > 0) process.exitCode = 1;
}

main();
