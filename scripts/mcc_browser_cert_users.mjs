#!/usr/bin/env node
// MCC terminal certification — synthetic DEV identity provisioning/teardown
// for the live browser certification (§9 of the PO brief).
//
// DEV ONLY. Refuses to run against anything but vqycarelcoijzwlpkpcz.
// Never reads PRODUCTION_SUPABASE_SERVICE_ROLE_KEY.
//
//   node scripts/mcc_browser_cert_users.mjs setup
//   node scripts/mcc_browser_cert_users.mjs teardown
//   node scripts/mcc_browser_cert_users.mjs state <label>            # print gate-relevant profile row
//   node scripts/mcc_browser_cert_users.mjs set <label> <json>       # patch user_profiles
//   node scripts/mcc_browser_cert_users.mjs goals <label>            # list that user's goals

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(ROOT, '.mcc-cert-users.json'); // gitignored scratch, holds ids only

function env() {
  const t = readFileSync(join(ROOT, '.env.local'), 'utf8');
  const e = {};
  for (const l of t.split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2].trim(); }
  return e;
}
const E = env();
const BASE = E.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = E.SUPABASE_SERVICE_ROLE_KEY;
const ANON = E.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!BASE?.includes('vqycarelcoijzwlpkpcz')) { console.error(`FATAL: not DEV (${BASE})`); process.exit(2); }
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

// Fixed password so the browser session can sign in repeatedly. Synthetic
// accounts on an .invalid domain in DEV only; never a real credential.
export const PASSWORD = 'MccCertBrowser!2026';
const email = (label) => `mcc-cert-${label}@fhip-test.invalid`;

const LABELS = ['ux01', 'ux02', 'ux03', 'ux04', 'ux07', 'ux08', 'ux09'];

async function adminCreate(label) {
  const r = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: 'POST', headers: SH,
    body: JSON.stringify({ email: email(label), password: PASSWORD, email_confirm: true }),
  });
  const b = await r.json();
  if (r.status >= 300) throw new Error(`create ${label}: ${r.status} ${JSON.stringify(b)}`);
  return b.id;
}
async function adminDelete(id) {
  const r = await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH });
  return r.status;
}
async function patchProfile(uid, patch) {
  const r = await fetch(`${BASE}/rest/v1/user_profiles?user_id=eq.${uid}`, {
    method: 'PATCH', headers: { ...SH, Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function getProfile(uid) {
  const r = await fetch(`${BASE}/rest/v1/user_profiles?user_id=eq.${uid}&select=user_id,onboarding_completed,country_of_residence,country_confirmed_at,country_source,preferred_currency`, { headers: SH });
  return r.json();
}
async function deleteProfile(uid) {
  const r = await fetch(`${BASE}/rest/v1/user_profiles?user_id=eq.${uid}`, { method: 'DELETE', headers: SH });
  return r.status;
}
async function listUsers() {
  const r = await fetch(`${BASE}/auth/v1/admin/users?per_page=1000`, { headers: SH });
  const b = await r.json();
  return b.users || [];
}

const CONFIRMED = (c) => ({ onboarding_completed: true, country_of_residence: c, country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED' });
const UNCONFIRMED_ONBOARDED = { onboarding_completed: true, country_of_residence: null, country_confirmed_at: null, country_source: null };
const UNCONFIRMED_NOT_ONBOARDED = { onboarding_completed: false, country_of_residence: null, country_confirmed_at: null, country_source: null };

const cmd = process.argv[2];

if (cmd === 'setup') {
  const ids = {};
  for (const label of LABELS) ids[label] = await adminCreate(label);
  await patchProfile(ids.ux01, CONFIRMED('AU'));
  await patchProfile(ids.ux02, CONFIRMED('IN'));
  await patchProfile(ids.ux03, UNCONFIRMED_ONBOARDED);
  await patchProfile(ids.ux07, UNCONFIRMED_ONBOARDED);
  await patchProfile(ids.ux08, CONFIRMED('AU'));
  // UX-09: authenticated, country unconfirmed, onboarding NOT completed —
  // the state proxy.ts is meant to confine to /onboarding.
  await patchProfile(ids.ux09, UNCONFIRMED_NOT_ONBOARDED);
  // UX-04: missing user_profiles row entirely (PROFILE_INCOMPLETE).
  const st = await deleteProfile(ids.ux04);
  console.log(`ux04 user_profiles row deleted -> HTTP ${st}`);
  writeFileSync(STATE_FILE, JSON.stringify(ids, null, 2));
  for (const [k, v] of Object.entries(ids)) console.log(`${k}\t${email(k)}\t${v}`);
  console.log(`\nProfiles:`);
  for (const [k, v] of Object.entries(ids)) console.log(k, JSON.stringify(await getProfile(v)));
} else if (cmd === 'teardown') {
  const ids = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  for (const [k, v] of Object.entries(ids)) console.log(`delete ${k} ${v} -> HTTP ${await adminDelete(v)}`);
  // Belt-and-braces sweep by the distinctive synthetic email pattern.
  const leftover = (await listUsers()).filter((u) => /^mcc-cert-.*@fhip-test\.invalid$/.test(u.email || ''));
  for (const u of leftover) console.log(`sweep-delete ${u.email} ${u.id} -> HTTP ${await adminDelete(u.id)}`);
  const after = (await listUsers()).filter((u) => /^mcc-cert-.*@fhip-test\.invalid$/.test(u.email || ''));
  console.log(`RESIDUAL synthetic auth.users matching mcc-cert-*@fhip-test.invalid: ${after.length}`);
  // Independent residue sweep over the tables these identities could touch.
  const TABLES = ['user_profiles', 'user_goals', 'households', 'income_sources', 'expense_items', 'assets', 'liabilities', 'investments', 'retirement_accounts', 'insurance_policies'];
  let residue = 0;
  for (const [k, v] of Object.entries(ids)) {
    for (const t of TABLES) {
      const r = await fetch(`${BASE}/rest/v1/${t}?select=user_id&user_id=eq.${v}`, { headers: { ...SH, Prefer: 'count=exact' } });
      const n = Number((r.headers.get('content-range') || '/0').split('/')[1]);
      if (n > 0) { residue += n; console.log(`  RESIDUE ${t} ${k} n=${n}`); }
    }
  }
  console.log(`RESIDUAL rows across ${TABLES.length} tables for all synthetic ids: ${residue}`);
  process.exit(after.length === 0 && residue === 0 ? 0 : 1);
} else if (cmd === 'state') {
  const ids = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const label = process.argv[3];
  console.log(JSON.stringify(await getProfile(ids[label]), null, 1));
} else if (cmd === 'set') {
  const ids = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const label = process.argv[3];
  const patch = JSON.parse(process.argv[4]);
  console.log(JSON.stringify(await patchProfile(ids[label], patch)));
} else if (cmd === 'goals') {
  const ids = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const label = process.argv[3];
  const r = await fetch(`${BASE}/rest/v1/user_goals?select=id,goal_name,target_amount,created_at&user_id=eq.${ids[label]}`, { headers: SH });
  console.log(JSON.stringify(await r.json(), null, 1));
} else if (cmd === 'emails') {
  const ids = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  for (const k of Object.keys(ids)) console.log(`${k}\t${email(k)}\t${PASSWORD}`);
} else {
  console.error('usage: setup | teardown | state <label> | set <label> <json> | goals <label> | emails');
  process.exit(1);
}
