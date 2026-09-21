// Z01 — 2026-09-21 checkpoint: real, live, two-authenticated-user cross-tenant
// RLS re-test against the real DEV database, using ONLY native fetch (no npm
// packages — this worktree's node_modules could not be reliably installed in
// this session, so this avoids depending on it). Creates two disposable
// synthetic DEV users, gives user A a liability row, obtains a REAL user B
// access token via password grant, and tries to read/update/delete user A's
// row AS user B. Deletes both users at the end regardless of outcome.
//
// This directly re-exercises Section 31's own standard: "Use two
// authenticated users where possible; anon-denied is not equivalent to
// authenticated cross-tenant isolation" — this uses two real authenticated
// users, not anon.

import fs from 'fs';
import path from 'path';

function loadEnv() {
  const p = path.resolve(process.cwd(), '.env.local');
  const env = {};
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '').replace(/\r/g, '');
    const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SR = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !ANON || !SR) throw new Error('Missing required DEV env vars in .env.local');
if (BASE.includes('twwpnltizhtjxhamyoxt')) throw new Error('REFUSING: this looks like the production project ref, not DEV.');

async function admin(pathAndQuery, opts = {}) {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method: opts.method || 'GET',
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const created = [];
async function makeUser(tag) {
  const email = `lr-audit-${tag}-${Date.now()}@example.com`;
  const password = `Aud!t${Date.now()}xZ9`;
  const r = await admin('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  if (r.status >= 300) throw new Error(`createUser ${tag}: ${r.status} ${r.text}`);
  const uid = r.json.id;
  created.push(uid);
  return { uid, email, password };
}
async function signIn(email, password) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`signIn: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}
async function asUser(token, pathAndQuery, opts = {}) {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method: opts.method || 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: opts.prefer || '', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function cleanup() {
  for (const uid of created) await admin(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' });
  console.log(`cleanup: deleted ${created.length} synthetic DEV users`);
}

async function main() {
  const a = await makeUser('rlsA');
  const b = await makeUser('rlsB');
  console.log(`created user A=${a.uid} user B=${b.uid}`);

  // A liability row owned by user A (service role insert, as if A created it via the app).
  const insA = await admin('/rest/v1/liabilities', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: { user_id: a.uid, liability_name: 'RLS audit probe', debt_type: 'personal_loan', balance: 12345, currency_code: 'AUD', country_code: 'AU', owner: 'self', is_active: true },
  });
  if (insA.status >= 300) throw new Error(`seed liability: ${insA.status} ${insA.text}`);
  const rowId = insA.json[0].id;
  console.log(`seeded liabilities.id=${rowId} for user A`);

  const tokenB = await signIn(b.email, b.password);
  console.log('user B signed in, got a real access token');

  // 1) Can B READ A's row by id?
  const readAsB = await asUser(tokenB, `/rest/v1/liabilities?id=eq.${rowId}&select=id,user_id,balance`);
  console.log(`READ as B  -> status=${readAsB.status} rows=${Array.isArray(readAsB.json) ? readAsB.json.length : 'n/a'}`);
  const readLeak = Array.isArray(readAsB.json) && readAsB.json.length > 0;

  // 2) Can B UPDATE A's row?
  const updAsB = await asUser(tokenB, `/rest/v1/liabilities?id=eq.${rowId}`, { method: 'PATCH', prefer: 'return=representation', body: { balance: 999999 } });
  console.log(`UPDATE as B -> status=${updAsB.status} body=${JSON.stringify(updAsB.json).slice(0, 200)}`);
  const updateLeak = Array.isArray(updAsB.json) && updAsB.json.length > 0;

  // 3) Can B DELETE A's row?
  const delAsB = await asUser(tokenB, `/rest/v1/liabilities?id=eq.${rowId}`, { method: 'DELETE', prefer: 'return=representation' });
  console.log(`DELETE as B -> status=${delAsB.status} body=${JSON.stringify(delAsB.json).slice(0, 200)}`);
  const deleteLeak = Array.isArray(delAsB.json) && delAsB.json.length > 0;

  // Positive control: can A read A's own row (proves RLS is enforcing something, not just always-denying)?
  const tokenA = await signIn(a.email, a.password);
  const readAsA = await asUser(tokenA, `/rest/v1/liabilities?id=eq.${rowId}&select=id,balance`);
  const positiveControlOk = Array.isArray(readAsA.json) && readAsA.json.length === 1;
  console.log(`READ as A (positive control) -> status=${readAsA.status} rows=${Array.isArray(readAsA.json) ? readAsA.json.length : 'n/a'}`);

  console.log('\n=== RESULT ===');
  console.log(`Cross-tenant READ blocked:   ${!readLeak ? 'PASS' : 'FAIL - LEAK'}`);
  console.log(`Cross-tenant UPDATE blocked: ${!updateLeak ? 'PASS' : 'FAIL - LEAK'}`);
  console.log(`Cross-tenant DELETE blocked: ${!deleteLeak ? 'PASS' : 'FAIL - LEAK'}`);
  console.log(`Positive control (A reads own row): ${positiveControlOk ? 'PASS' : 'FAIL - even the owner cannot read, RLS may be mis-set'}`);

  await cleanup();
}

main().catch(async (e) => { console.error('FATAL', e); await cleanup(); process.exit(1); });
