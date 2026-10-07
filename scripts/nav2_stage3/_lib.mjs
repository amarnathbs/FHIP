// NAV2 Stage 3 certification journeys: shared helpers. DEV ONLY. Never prints a secret.
//  - the DEV host is verified (project ref) before any call: loadDevEnv() throws unless it is vqycarelcoijzwlpkpcz
//  - sessions are minted for EXISTING fixture users only (no account is created, no password is used)
//  - every DEV change a journey makes is recorded in the journey ledger and reverted at the end of that journey
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevEnv, serviceClient } from '../canonical_cert/lib/env.mjs';
import { signIn, api as rawApiCall, revoke, loadSession } from '../canonical_cert/lib/session.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.CERT_PORT ?? 3981);
process.env.CERT_PORT = String(PORT);
export const OUT = path.resolve(HERE, '..', '..', 'test-artifacts', 'nav2_stage3');
fs.mkdirSync(OUT, { recursive: true });

export const dev = loadDevEnv(); // throws unless DEV
export const db = await serviceClient();

/** FCAST fixture users (existing DEV accounts, IN) used by the journeys. */
export const USERS = {
  holder: 'forecast.tc053@example.test', // Premium, India, owns the journey-1 accepted statement
  other: 'forecast.tc058@example.test', // Premium, India: the "other tenant"
  free: 'forecast.tc065@example.test', // free plan
  spare: 'forecast.tc072@example.test', // ownership / valuation cases
  admin: 'forecast.tc078@example.test', // given NAV2 admin capabilities for the admin-endpoint checks, reverted at the end
};

let results = [];
export function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`);
  return !!cond;
}
export const summary = () => ({ pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results });
export function save(name, obj) {
  fs.writeFileSync(path.join(OUT, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

export async function userIdOf(email) {
  for (let page = 1; page < 30; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  throw new Error(`no such fixture user ${email}`);
}

const signed = new Map();
export async function login(email) {
  if (!signed.has(email)) signed.set(email, signIn(email, { method: 'mint' }));
  await signed.get(email);
}
export async function api(email, method, route, opts = {}) {
  await login(email);
  return rawApiCall(email, method, route, { port: PORT, ...opts });
}
export async function logoutAll() {
  for (const e of [...signed.keys()]) {
    try {
      await revoke(e);
    } catch (err) {
      console.log('  (revoke failed for a session; it expires on its own)', String(err.message).slice(0, 80));
    }
  }
  signed.clear();
}

export async function flag(key) {
  const { data } = await db.from('ii_reference_job_control').select('enabled, disabled_reason').eq('job_key', key).maybeSingle();
  return data;
}
export async function setFlag(key, enabled, reason) {
  const { error } = await db.from('ii_reference_job_control').update({ enabled, disabled_reason: enabled ? null : (reason ?? 'journey restore') }).eq('job_key', key);
  if (error) throw new Error(`could not set ${key}: ${error.message}`);
}
export const dmy = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}-${m}-${y}`; };

/** The signed-in fixture user's Supabase access token (for DIRECT PostgREST calls as that user). Never printed. */
export async function accessToken(email) {
  await login(email);
  const session = loadSession(email);
  const chunk = (n) => { const m = n.match(/^sb-[a-z0-9]+-auth-token(?:\.(\d+))?$/); return m ? Number(m[1] ?? -1) : null; };
  const raw = Object.entries(session.cookies).filter(([n]) => chunk(n) !== null).sort(([a], [b]) => chunk(a) - chunk(b)).map(([, v]) => v).join('');
  const decoded = raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64url').toString('utf8') : raw;
  return JSON.parse(decoded).access_token;
}

/** A PostgREST call AS the user (anon key + the user's own JWT): what a browser with the user's session could do directly. */
export async function asUser(email, table, query = 'select=*&limit=5', { method = 'GET', body } = {}) {
  const token = await accessToken(email);
  const res = await fetch(`${dev.url}/rest/v1/${table}?${query}`, { method, headers: { apikey: dev.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
export async function rpcAsUser(email, fn, args = {}) {
  const token = await accessToken(email);
  const res = await fetch(`${dev.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: dev.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
