// AIE-1 final production completion (2026-09-25) -- shared DEV harness.
//
// Every DEV write goes through `devFetch`, which asserts the DEV host before
// EVERY request and refuses to run against anything else. Synthetic users are
// labelled `aie1-final-<tag>-<stamp>@fhip-test.invalid` and every artefact is
// appended to a manifest file so cleanup is complete and auditable.
import fs from 'node:fs';
import path from 'node:path';

export const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';

export function loadEnv(file = 'D:/FHIP/.env.local') {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return env;
}

export const env = loadEnv();
export const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
export const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

export function assertDev(url) {
  const host = new URL(url).host;
  if (host !== DEV_HOST) throw new Error(`DEV HOST ASSERTION FAILED: refusing to touch ${host}`);
}
assertDev(BASE);

export async function devFetch(p, { method = 'GET', body, token, prefer, headers: extra } = {}) {
  assertDev(BASE);
  const headers = {
    apikey: token ? ANON : SERVICE,
    Authorization: `Bearer ${token ?? SERVICE}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {}),
    ...(extra ?? {}),
  };
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

export const MANIFEST = process.env.AIE1_MANIFEST
  ?? 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad/aie1_dev_manifest.jsonl';

export function recordArtefact(entry) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.appendFileSync(MANIFEST, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export async function makeSyntheticUser(tag, { country = 'AU' } = {}) {
  const stamp = Date.now();
  const email = `aie1-final-${tag}-${stamp}@fhip-test.invalid`;
  const password = `Aie1Final!${stamp}Zz9`;
  const created = await devFetch('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  if (!id) throw new Error(`could not create synthetic user ${tag}: ${created.text.slice(0, 200)}`);
  recordArtefact({ kind: 'auth_user', id, email, tag });
  const prof = await devFetch(`/rest/v1/user_profiles?user_id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { country_of_residence: country, country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true },
  });
  if (!prof.ok || !Array.isArray(prof.json) || prof.json.length !== 1) {
    throw new Error(`could not confirm country for ${tag}: ${prof.status} ${prof.text.slice(0, 200)}`);
  }
  const token = await signIn(email, password);
  return { id, email, password, token };
}

export async function signIn(email, password) {
  assertDev(BASE);
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`sign-in failed for ${email}`);
  return j.access_token;
}

export function makeChecker(prefix) {
  let pass = 0, fail = 0, seq = 0;
  const failures = [];
  const check = (label, cond, detail = '') => {
    seq++;
    const id = `${prefix}-${String(seq).padStart(2, '0')}`;
    if (cond) { pass++; console.log(`  PASS  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
    else { fail++; failures.push(id); console.log(`  FAIL  ${id}  ${label}${detail ? '\n        ' + detail : ''}`); }
  };
  const summary = () => { console.log(`\n${pass} passed, ${fail} failed${failures.length ? ' (' + failures.join(', ') + ')' : ''}`); return fail; };
  return { check, summary };
}
