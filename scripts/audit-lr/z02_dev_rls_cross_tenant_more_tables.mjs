// Z02 — 2026-09-21 checkpoint: same live, two-real-authenticated-user
// cross-tenant RLS re-test as z01, extended to two more LR-relevant tables:
// business_entities (LR-11) and ii_source_documents (the ungated Investment
// Intelligence upload surface named in the P1-3 finding — if RLS on THIS
// table were also leaky, the "no gate, no malware scan" finding would
// compound into an actual cross-tenant data leak, which would be far more
// severe). Native fetch only, no npm packages. Disposable users, deleted at
// the end regardless of outcome.

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
  created.push(r.json.id);
  return { uid: r.json.id, email, password };
}
async function signIn(email, password) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
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

async function testTable(table, seedBody, selectCols) {
  console.log(`\n\n########## TABLE: ${table} ##########`);
  const a = await makeUser(`${table.slice(0, 6)}A`);
  const b = await makeUser(`${table.slice(0, 6)}B`);
  const ins = await admin(`/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: { user_id: a.uid, ...seedBody } });
  if (ins.status >= 300) { console.log(`SEED FAILED: ${ins.status} ${ins.text}`); await cleanup(); return; }
  const rowId = ins.json[0].id;
  console.log(`seeded ${table}.id=${rowId} for user A=${a.uid}`);

  const tokenB = await signIn(b.email, b.password);
  const readAsB = await asUser(tokenB, `/rest/v1/${table}?id=eq.${rowId}&select=${selectCols}`);
  const readLeak = Array.isArray(readAsB.json) && readAsB.json.length > 0;
  console.log(`READ as B   -> status=${readAsB.status} rows=${Array.isArray(readAsB.json) ? readAsB.json.length : 'n/a'}  ${readLeak ? 'FAIL - LEAK: ' + JSON.stringify(readAsB.json) : 'PASS (blocked)'}`);

  const delAsB = await asUser(tokenB, `/rest/v1/${table}?id=eq.${rowId}`, { method: 'DELETE', prefer: 'return=representation' });
  const deleteLeak = Array.isArray(delAsB.json) && delAsB.json.length > 0;
  console.log(`DELETE as B -> status=${delAsB.status}  ${deleteLeak ? 'FAIL - LEAK' : 'PASS (blocked)'}`);

  const tokenA = await signIn(a.email, a.password);
  const readAsA = await asUser(tokenA, `/rest/v1/${table}?id=eq.${rowId}&select=id`);
  const positiveControlOk = Array.isArray(readAsA.json) && readAsA.json.length === 1;
  console.log(`READ as A (positive control) -> ${positiveControlOk ? 'PASS' : 'FAIL - owner cannot read own row'}`);

  await cleanup();
}

async function main() {
  await testTable('business_entities', { entity_type: 'company', name: 'RLS audit probe Pty Ltd', currency_code: 'AUD', ownership_percentage: 100, valuation_mode: 'summary', is_active: true }, 'id,user_id,name');
  await testTable('ii_source_documents', { country_code: 'IN', status: 'uploaded', storage_path: 'audit-probe/does-not-exist.pdf', original_filename: 'audit-probe.pdf', mime_type: 'application/pdf', file_size: 1 }, 'id,user_id,original_filename');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
