// Mission part 4, section 15 -- "Verify the effective class flags and
// entitlement rules. Prove access with an eligible synthetic user never on
// the pilot allowlist. Do not activate unsupported/prohibited classes."
//
// Independently established this session (background research + direct code
// read of lib/aie/featureFlags.ts, lib/aie/adapters/shared/fallbackGate.ts,
// lib/financial-data-hub/constants/featureFlags.ts,
// lib/canonical-data/disposition/insurance.ts):
//   - There is no DB-backed pilot-allowlist table anywhere in this schema.
//     Pilot-cohort membership is two independent env-var-only gates
//     (AIE_PILOT_COHORT_* and the separate II_AI_FALLBACK_PILOT_COHORT_*),
//     and BOTH gate only the AI-FALLBACK sub-path, never the base
//     upload/native-extraction flow.
//   - The base FDH upload routes (bank-pdf, bank-csv, liability-statement,
//     investment-statement, retirement-statement, payslip) gate only on
//     auth + country-confirmation + isFdhDocumentUploadEnabled() (env flag
//     AND a hard-coded Supabase-project allowlist) -- no cohort check at all.
//   - insurance is the one class with EVERY disposition-registry entry
//     not_active and no live UI/route path to Apply.
//
// This script proves that behaviourally, live, against DEV, for a synthetic
// user manufactured to be "eligible" (authenticated, country-confirmed,
// on the DEV allowlisted project) and DELIBERATELY NEVER added to any pilot
// list (this session never set AIE_PILOT_COHORT_* / II_AI_FALLBACK_PILOT_
// COHORT_* env vars for this dev process, and no such env var was present in
// D:/FHIP/.env.local to begin with -- confirmed by grep before running):
//   (1) a supported class (bank CSV) upload SUCCEEDS for this never-piloted
//       user -- base access is genuinely open, not silently narrowed;
//   (2) insurance intake is REFUSED regardless -- an unsupported class is
//       never silently activated to produce a favourable verdict.
//
// Run: npx tsx scripts/aie1_p4_section15_pilot_cohort_eligibility_proof.mjs http://localhost:3993
import fs from 'node:fs';
import path from 'node:path';
import { fetchOwnerRequest, resolveSyntheticOwner } from './lib/syntheticOwner.mjs';

const APP = process.argv[2] ?? 'http://localhost:3993';
const repoRoot = path.resolve(import.meta.dirname, '..');

function loadEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return env;
}
const env = loadEnv(path.join(repoRoot, '.env.local'));
const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
function assertDev(url) {
  const host = new URL(url).host;
  if (host !== DEV_HOST) throw new Error(`DEV HOST ASSERTION FAILED: refusing to touch ${host}`);
}
assertDev(BASE);

// Confirm, before doing anything, that no pilot-cohort env var is set for
// THIS process -- i.e. the synthetic user we are about to create genuinely
// cannot be "on the allowlist" because no allowlist is even configured.
const cohortVars = [
  'AIE_PILOT_COHORT_ENFORCED', 'AIE_PILOT_COHORT_EMAILS', 'AIE_PILOT_COHORT_USER_IDS',
  'II_AI_FALLBACK_PILOT_COHORT_ENFORCED', 'II_AI_FALLBACK_PILOT_COHORT_EMAILS', 'II_AI_FALLBACK_PILOT_COHORT_USER_IDS',
];
const cohortState = Object.fromEntries(cohortVars.map((v) => [v, process.env[v] ?? env[v] ?? null]));
console.log('Pilot-cohort env vars for this run (all should be unset/null):', JSON.stringify(cohortState));
const anySet = Object.values(cohortState).some((v) => v !== null);
if (anySet) throw new Error('A pilot-cohort env var is set for this run -- the eligibility proof would not be clean. Aborting.');

const MANIFEST = path.join(path.dirname(process.env.AIE1_MANIFEST_DIR || repoRoot), 'aie1_p4_synthetic_manifest.jsonl');
const manifestPath = process.env.AIE1_P4_MANIFEST || 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad/aie1_p4_synthetic_manifest.jsonl';
function recordArtefact(entry) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.appendFileSync(manifestPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

async function devFetch(p, { method = 'GET', body, headers: extra } = {}) {
  assertDev(BASE);
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(extra ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? '\n        ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
}

async function main() {
  const stamp = Date.now();
  const email = `aie1-p4-elig-${stamp}@fhip-synthetic.test`;
  const password = `Fhip!Synth${stamp}Zz9`;
  const created = await devFetch('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const userId = created.json?.id;
  if (!userId) throw new Error(`could not create synthetic user: ${created.text.slice(0, 300)}`);
  recordArtefact({ kind: 'auth_user', id: userId, email, run: 'section15-eligibility' });
  console.log(`Created synthetic user ${email} (${userId}), never added to any pilot list (none exists in this run's env).`);

  const prof = await devFetch(`/rest/v1/user_profiles?user_id=eq.${userId}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: { country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true },
  });
  check('country-confirmed profile set for synthetic user', prof.ok && Array.isArray(prof.json) && prof.json.length === 1, `${prof.status}`);

  const signInRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await signInRes.json();
  const token = session.access_token;
  check('synthetic user can sign in', !!token, signInRes.status.toString());

  // This app's route handlers read the Supabase session from a COOKIE
  // (lib/supabase/server.ts uses @supabase/ssr's createServerClient against
  // next/headers cookies()), not an Authorization header -- a bare bearer
  // token is silently ignored by requireCountryConfirmedUser(), which is
  // exactly the 401 this script hit on its first run. Reproducing the same
  // cookie shape the real browser client sets (sb-<ref>-auth-token, chunked
  // past ~3180 chars, matching scripts/aie1_final_accessibility_live_dev.ts's
  // already-established pattern for this exact app) so a plain fetch can
  // authenticate as this synthetic user without a browser.
  const ref = new URL(BASE).host.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  const CHUNK = 3180;
  const cookieHeader = cookieValue.length <= CHUNK
    ? `sb-${ref}-auth-token=${cookieValue}`
    : Array.from({ length: Math.ceil(cookieValue.length / CHUNK) }, (_, i) => `sb-${ref}-auth-token.${i}=${cookieValue.slice(i * CHUNK, (i + 1) * CHUNK)}`).join('; ');

  // (1) Supported class: bank CSV upload should SUCCEED for this never-piloted user.
  const csv = 'Date,Description,Amount\n2026-08-01,Coffee Shop,-4.50\n2026-08-02,Salary,3000.00\n';
  // Owner-before-upload: the supported-class upload now needs a valid owner; a synthetic Self for this user.
  const ownerSel = await resolveSyntheticOwner(fetchOwnerRequest(APP, cookieHeader), 'self', 'bank');
  const uploadRes = await fetch(`${APP}/api/financial-data-hub/bank-csv/upload?country_code=AU&currency_code=AUD&filename=section15_eligibility.csv&owner=${encodeURIComponent(JSON.stringify(ownerSel))}`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'Content-Type': 'text/csv', 'Content-Length': String(Buffer.byteLength(csv)) },
    body: csv,
  });
  const uploadJson = await uploadRes.json().catch(() => null);
  const uploadData = uploadJson?.data ?? uploadJson; // ok() wraps as {data:...}
  check(
    'section15-01: supported class (bank CSV) upload succeeds for a synthetic user on NO pilot list',
    uploadRes.status === 200 && !!uploadData?.document_id,
    `HTTP ${uploadRes.status} ${JSON.stringify(uploadJson)}`,
  );
  if (uploadData?.document_id) recordArtefact({ kind: 'fdh_statement_uploads', id: uploadData.document_id, userId, run: 'section15-eligibility' });
  if (uploadData?.financial_account_id) recordArtefact({ kind: 'fdh_financial_accounts', id: uploadData.financial_account_id, userId, run: 'section15-eligibility' });

  // (2) Insurance intake should be REFUSED regardless of eligibility (not_active class).
  const insRes = await fetch(`${APP}/api/aie/insurance/intake`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'fake-policy.pdf', mimeType: 'application/pdf' }),
  });
  check(
    'section15-02: insurance intake is refused (not_active class, never silently activated)',
    insRes.status >= 400,
    `HTTP ${insRes.status}`,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`Synthetic manifest: ${manifestPath}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
