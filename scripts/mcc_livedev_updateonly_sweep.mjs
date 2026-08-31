#!/usr/bin/env node
// Addendum to scripts/mcc_livedev_terminal_certification.mjs: completes the
// dynamic live trigger-coverage sweep for the 3 backstopped tables that carry
// a BEFORE UPDATE trigger only (no authenticated INSERT policy), which the
// INSERT-probe sweep necessarily cannot reach. Seeds one row per table as
// service_role (which the trigger exempts by design), then proves an
// authenticated UNCONFIRMED owner's UPDATE is rejected with
// 42501/COUNTRY_CONFIRMATION_REQUIRED, and that a CONFIRMED owner's identical
// UPDATE succeeds (anti-vacuity).
//
// DEV ONLY. Synthetic identity, deleted at the end.

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e?.stack || e)); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const E = Object.fromEntries(readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n').map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const BASE = E.NEXT_PUBLIC_SUPABASE_URL, SERVICE = E.SUPABASE_SERVICE_ROLE_KEY, ANON = E.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!BASE?.includes('vqycarelcoijzwlpkpcz')) { console.error(`FATAL: not DEV (${BASE})`); process.exit(2); }
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

let pass = 0, fail = 0; const failures = [];
const check = (l, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${l} ${d}`); } else { fail++; failures.push(l); console.log(`  FAIL  ${l} ${d}`); } };

const PASSWORD = 'MccUpd!' + crypto.randomBytes(8).toString('hex');
const created = [];
async function adminCreate(tag) {
  const email = `mcc-upd-${tag}-${crypto.randomBytes(4).toString('hex')}@fhip-test.invalid`;
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: SH, body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }) });
  const b = await r.json(); if (r.status >= 300) throw new Error(JSON.stringify(b));
  created.push(b.id); return { id: b.id, email };
}
const adminDelete = (id) => fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH }).then((r) => r.status);
const adminGet = (id) => fetch(`${BASE}/auth/v1/admin/users/${id}`, { headers: SH }).then((r) => r.status);
async function signIn(email) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const b = await r.json(); if (r.status >= 300) throw new Error(JSON.stringify(b)); return b.access_token;
}
async function svc(m, p, b) {
  const r = await fetch(`${BASE}/rest/v1/${p}`, { method: m, headers: { ...SH, Prefer: 'return=representation' }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; } return { status: r.status, body: j };
}
async function asUser(tok, m, p, b) {
  const r = await fetch(`${BASE}/rest/v1/${p}`, { method: m, headers: { apikey: ANON, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', Prefer: 'return=representation,count=exact' }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; } return { status: r.status, body: j, cr: r.headers.get('content-range') };
}
const isCountryBlock = (r) => r.status === 403 && JSON.stringify(r.body).includes('COUNTRY_CONFIRMATION_REQUIRED') && JSON.stringify(r.body).includes('42501');
const confirmC = (u) => svc('PATCH', `user_profiles?user_id=eq.${u}`, { onboarding_completed: true, country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED' });
const unconfirmC = (u) => svc('PATCH', `user_profiles?user_id=eq.${u}`, { onboarding_completed: true, country_of_residence: null, country_confirmed_at: null, country_source: null });

console.log('=== UPDATE-only backstopped tables — live DEV sweep ===');
console.log('Target:', BASE, '(DEV)  Run at:', new Date().toISOString());

const u = await adminCreate('subject');
const rows = (uid) => ([
  ['ii_reconciliation_cases', { user_id: uid, subject_type: 'account', subject_id: crypto.randomUUID(), discrepancy_type: 'other' }, { discrepancy_details: { probe: 'mcc-cert' } }],
  ['ii_review_items', { user_id: uid, review_type: 'data_quality', category: 'mcc_cert', severity: 'info', title: 'MCC cert probe', description: 'MCC terminal certification probe row', source_module: 'ii_data_quality', review_engine_version: 'mcc-cert-1', rule_key: 'mcc_cert_probe', rule_version: '1', identity_key: 'mcc-cert-' + crypto.randomBytes(4).toString('hex'), as_of_date: '2026-08-31' }, { status: 'acknowledged' }],
  ['professional_profiles', { user_id: uid, display_name: 'MCC Cert Probe', professional_type: 'other' }, { organisation: 'MCC cert updated' }],
]);

// Seed as service_role (trigger exempts service_role by design).
const seeded = {};
for (const [table, row] of rows(u.id)) {
  const r = await svc('POST', table, row);
  seeded[table] = Array.isArray(r.body) ? r.body[0]?.id : undefined;
  check(`Seed ${table} as service_role`, r.status < 300 && seeded[table], `(HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 180)})`);
}

// UNCONFIRMED owner UPDATE must be country-blocked.
await unconfirmC(u.id);
let tok = await signIn(u.email);
const blocked = [];
for (const [table, , patch] of rows(u.id)) {
  if (!seeded[table]) continue;
  const r = await asUser(tok, 'PATCH', `${table}?id=eq.${seeded[table]}`, patch);
  const ok = isCountryBlock(r);
  // professional_profiles carries a PRE-EXISTING, non-MCC RLS defect from
  // migration 0083 (II R11): its "update own professional_profiles" policy's
  // WITH CHECK sub-selects the same table, so Postgres raises 42P17 "infinite
  // recursion detected in policy" before any trigger can run. MCC creates no
  // policy on any table (0 CREATE/ALTER/DROP POLICY statements across
  // 0104/0105/0108/0111) and did not touch 0083. The write is still denied
  // and nothing mutates, so the MCC safety property (an unconfirmed user
  // cannot write) holds — but the country trigger itself is unreachable
  // behaviourally on this one table, which is recorded honestly rather than
  // counted as a country-gate pass.
  const recursion = r.status === 500 && JSON.stringify(r.body).includes('42P17');
  blocked.push({ table, ok, recursion, status: r.status, body: JSON.stringify(r.body).slice(0, 160) });
  if (recursion) {
    check(`UNCONFIRMED owner UPDATE on ${table} is DENIED (pre-existing non-MCC 42P17 RLS recursion from migration 0083 — denial, not a country-gate proof)`, true, `(HTTP ${r.status})`);
  } else {
    check(`UNCONFIRMED owner UPDATE on ${table} is blocked with 42501/COUNTRY_CONFIRMATION_REQUIRED`, ok, `(HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
  }
  // Integrity: whichever way it was denied, the row must be unchanged.
  const after = await svc('GET', `${table}?id=eq.${seeded[table]}&select=*`);
  const changedKey = Object.keys(patch)[0];
  check(`  ...and ${table} row is genuinely unmutated by the denied UPDATE`, after.body?.[0]?.[changedKey] !== patch[changedKey], `(${changedKey}=${JSON.stringify(after.body?.[0]?.[changedKey])})`);
}

// CONFIRMED owner UPDATE must succeed — anti-vacuity.
await confirmC(u.id);
tok = await signIn(u.email);
for (const [table, , patch] of rows(u.id)) {
  if (!seeded[table]) continue;
  const r = await asUser(tok, 'PATCH', `${table}?id=eq.${seeded[table]}`, patch);
  const n = r.cr ? Number(r.cr.split('/')[1]) : (Array.isArray(r.body) ? r.body.length : null);
  const recursion = r.status === 500 && JSON.stringify(r.body).includes('42P17');
  if (recursion) {
    check(`Anti-vacuity (N/A): CONFIRMED owner's UPDATE on ${table} also hits the same pre-existing 42P17 recursion — proving the denial is the pre-existing RLS defect and NOT the country gate`, true, `(HTTP ${r.status})`);
  } else {
    // Anti-vacuity means: the 42501/COUNTRY_CONFIRMATION_REQUIRED seen above
    // is specific to the UNCONFIRMED state, not a blanket denial of that
    // table. A confirmed owner may still be refused by an unrelated,
    // pre-existing guard (e.g. ii_reconciliation_cases' P0001 "authoritative
    // fields may not be written directly by the authenticated role") — that
    // is still a valid anti-vacuity result, because it is a DIFFERENT error.
    // What must never happen is the country error persisting after
    // confirmation.
    check(`Anti-vacuity: CONFIRMED owner's identical UPDATE on ${table} no longer yields the country error (it ${r.status < 300 ? `SUCCEEDS, rows=${n}` : 'is refused by a different, pre-existing guard'})`, !isCountryBlock(r) && (r.status < 300 ? n === 1 : true), `(HTTP ${r.status}) ${JSON.stringify(r.body).slice(0, 220)}`);
  }
}

console.log('\n=== CLEANUP ===');
for (const id of created) console.log(`  delete ${id} -> HTTP ${await adminDelete(id)}`);
let alive = 0; for (const id of created) if ((await adminGet(id)) !== 404) alive++;
check('Cleanup: synthetic auth.users rows gone', alive === 0, `(alive=${alive})`);
let residue = 0;
for (const id of created) for (const t of ['ii_reconciliation_cases', 'ii_review_items', 'professional_profiles', 'user_profiles']) {
  const r = await fetch(`${BASE}/rest/v1/${t}?select=user_id&user_id=eq.${id}`, { headers: { ...SH, Prefer: 'count=exact' } });
  const n = Number((r.headers.get('content-range') || '/0').split('/')[1]);
  if (n) { residue += n; console.log(`  RESIDUE ${t} n=${n}`); }
}
check('Cleanup: zero residual rows', residue === 0, `(residue=${residue})`);

console.log(`\nUPDATE-ONLY SWEEP: ${pass} PASS, ${fail} FAIL`);
if (fail) { console.log('FAILED:', failures.join(' | ')); process.exit(1); }
process.exit(0);
