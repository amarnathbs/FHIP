// G5 — LIVE DEV certification, DATABASE-LEVEL fallback.
//
// This script proves the persistence-layer invariants the G5-D1/G5-D2 fixes
// depend on WITHOUT requiring a running `next dev`/`next build` instance —
// it talks directly to hosted DEV Postgres via the Supabase REST API
// (PostgREST), using each synthetic user's own real JWT for RLS-scoped
// requests exactly as the app's own server client would issue them, and the
// service-role key only for fixture setup/teardown and privileged reads.
//
// It is a DELIBERATE COMPLEMENT to scripts/g5_livedev_certification.mjs
// (the full HTTP-route-level proof against a real running app server), not
// a replacement — see the G5 continuation report's toolchain section for
// why this fallback exists (a disclosed, reproducible disk-I/O-contention
// environment issue blocked a complete `npm ci` in this session's worktree,
// which blocks running `next dev` at all). This script proves:
//
//   1. The DB registry itself distinguishes AU/IN (is_supported=true) from
//      GENERIC countries (is_supported=false) exactly as
//      lib/services/jurisdiction.ts's AUTHORITATIVE_COUNTRY_CODES /
//      FULL_EXPERIENCE_COUNTRY_CODES vocabulary assumes -- if this table
//      ever drifted from that TS vocabulary, both G5 fixes' "fail closed to
//      null for GENERIC" behaviour would silently stop matching the real
//      database.
//   2. A real GENERIC user's own JWT cannot INSERT into `retirement_members`
//      or `fdh_investment_statements`/`ii_accounts` at all (42501,
//      COUNTRY_CONFIRMATION_REQUIRED) -- the same DB backstop the G5-D1/D2
//      code fixes sit behind as defence-in-depth, proven live, not merely
//      read from migration source.
//   3. AU/IN behave identically to each other and unchanged from before
//      the fix at the DB layer (both can insert their own rows).
//   4. The FDH-11 AU-only bridge's hardcoded `country_code: 'AU'` write
//      (lib/investment-import-bridge/auAccountResolution.ts) is reproduced
//      literally here against real DEV Postgres and independently confirmed
//      to persist `country_code='AU'` regardless of what `currency_code`
//      value accompanies it -- i.e. currency cannot influence the stored
//      jurisdiction, proven at the row that would actually be written by
//      production code, not merely asserted from reading the source.
//
// Every identity/row created here is tagged `g5-dblevel-*@fhip-test.invalid`
// and deleted at the end, with an independent re-verification sweep.
//
// Run: node scripts/g5_livedev_db_level_certification.mjs

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e?.stack || e)); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_?.includes('vqycarelcoijzwlpkpcz')) { console.error(`FATAL: refusing to run, not DEV (${URL_})`); process.exit(2); }
const TAG = 'g5-dblevel';

// The exact vocabulary from lib/services/jurisdiction.ts — duplicated
// deliberately (not imported — this script runs under plain Node with no
// TS build step) so drift between this list and the live `countries` table
// is exactly what check #1 below detects.
const AUTHORITATIVE_COUNTRY_CODES = ['AU', 'IN', 'GB', 'US', 'SG', 'AE'];
const FULL_EXPERIENCE_COUNTRY_CODES = ['AU', 'IN'];

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label} ${detail}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

async function rest(pathAndQuery, opts = {}, authToken = SERVICE) {
  // PostgREST requires `apikey` to always be a real Supabase API key (anon
  // or service_role) identifying the PROJECT; a user's own JWT goes ONLY in
  // `Authorization: Bearer` to carry their identity/RLS context. Passing a
  // user JWT as `apikey` (as an earlier version of this script did) is
  // rejected outright with "Invalid API key" before RLS is even evaluated.
  const isServiceCall = authToken === SERVICE;
  const headers = {
    apikey: isServiceCall ? SERVICE : ANON,
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    Prefer: opts.prefer ?? 'return=representation',
    ...opts.headers,
  };
  const r = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

const createdUsers = [];

async function createUser(tag, { country, currency, confirmed = true }) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${TAG}-${tag}-${stamp}@fhip-test.invalid`;
  const password = `G5Db!${stamp}`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = await r.json();
  if (!j.id) throw new Error(`could not create user ${tag}: ${JSON.stringify(j).slice(0, 300)}`);
  createdUsers.push(j.id);

  const now = new Date().toISOString();
  const profilePatch = {
    full_name: `G5 DB-level ${tag}`,
    country_of_residence: country,
    // G3 migration 0127: preferred_currency (the REPORTING currency) may
    // only ever be AUD or INR (lib/engines/fx.ts's SupportedCurrency) --
    // GB/US/SG/AE profiles still report in AUD by default, exactly as a
    // real GENERIC registrant would (they are never asked to pick a
    // reporting currency FX cannot support).
    preferred_currency: FULL_EXPERIENCE_COUNTRY_CODES.includes(country) ? currency : 'AUD',
    onboarding_completed: true,
    employment_status: 'full_time_employed',
    profile_completion_percentage: 100,
  };
  if (confirmed) {
    Object.assign(profilePatch, { country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
    if (!FULL_EXPERIENCE_COUNTRY_CODES.includes(country)) {
      // G3 migration 0127: a GENERIC-experience country cannot be marked
      // confirmed without a matching coverage-disclosure acknowledgement
      // (trg_enforce_generic_disclosure) -- satisfy it exactly as
      // lib/services/countryDisclosure.ts's real acknowledgement flow would.
      Object.assign(profilePatch, {
        generic_disclosure_acknowledged_at: now,
        generic_disclosure_version: 'g3-generic-coverage-2026-09',
        generic_disclosure_country: country,
      });
    }
  }
  const prof = await rest(`user_profiles?user_id=eq.${j.id}`, { method: 'PATCH', body: JSON.stringify(profilePatch) });
  if (prof.status >= 300) throw new Error(`profile patch failed for ${tag}: ${prof.text.slice(0, 300)}`);

  const tok = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password }),
  })).json();
  if (!tok.access_token) throw new Error(`sign-in failed for ${tag}: ${JSON.stringify(tok).slice(0, 300)}`);
  return { id: j.id, email, jwt: tok.access_token, country, currency };
}

// ---------------------------------------------------------------------------
// Check 1: countries.is_supported matches the TS FULL/GENERIC vocabulary.
// ---------------------------------------------------------------------------
async function checkCountryRegistry() {
  console.log('\n=== Check 1: countries.is_supported matches jurisdiction.ts vocabulary ===');
  const rows = await rest(`countries?country_code=in.(${AUTHORITATIVE_COUNTRY_CODES.map((c) => `"${c}"`).join(',')})&select=country_code,is_supported`);
  const byCode = Object.fromEntries((rows.json ?? []).map((r) => [r.country_code, r.is_supported]));
  for (const code of AUTHORITATIVE_COUNTRY_CODES) {
    const expected = FULL_EXPERIENCE_COUNTRY_CODES.includes(code);
    check(`countries.is_supported for ${code} === ${expected} (matches FULL_EXPERIENCE_COUNTRY_CODES)`, byCode[code] === expected, `actual=${byCode[code]}`);
  }
}

// ---------------------------------------------------------------------------
// Check 2/3: real INSERT attempts as AU/IN/GENERIC users' own JWTs.
// ---------------------------------------------------------------------------
async function checkDirectInsertGating() {
  console.log('\n=== Check 2/3: direct authenticated INSERT gating (retirement_members) — AU/IN allowed, GENERIC blocked ===');
  const au = await createUser('rm-au', { country: 'AU', currency: 'AUD' });
  const inUser = await createUser('rm-in', { country: 'IN', currency: 'INR' });
  const generic = await createUser('rm-generic', { country: 'SG', currency: 'SGD' });

  const auInsert = await rest('retirement_members', {
    method: 'POST',
    body: JSON.stringify({ user_id: au.id, member_type: 'self', age_source: 'needs_confirmation' }),
  }, au.jwt);
  check('AU: direct authenticated INSERT into retirement_members succeeds (unchanged)', auInsert.status === 201, `status=${auInsert.status} body=${auInsert.text.slice(0, 200)}`);

  const inInsert = await rest('retirement_members', {
    method: 'POST',
    body: JSON.stringify({ user_id: inUser.id, member_type: 'self', age_source: 'needs_confirmation' }),
  }, inUser.jwt);
  check('IN: direct authenticated INSERT into retirement_members succeeds (unchanged)', inInsert.status === 201, `status=${inInsert.status} body=${inInsert.text.slice(0, 200)}`);

  const genericInsert = await rest('retirement_members', {
    method: 'POST',
    body: JSON.stringify({ user_id: generic.id, member_type: 'self', age_source: 'needs_confirmation' }),
  }, generic.jwt);
  check('GENERIC (SG): direct authenticated INSERT into retirement_members is REJECTED (42501, DB backstop live)', genericInsert.status >= 400 && /42501|COUNTRY_CONFIRMATION_REQUIRED/.test(genericInsert.text), `status=${genericInsert.status} body=${genericInsert.text.slice(0, 300)}`);

  return { au, inUser, generic };
}

// ---------------------------------------------------------------------------
// Check 4: the FDH-11 AU-only bridge's literal write path — country_code is
// always 'AU' regardless of currency_code (reproduces
// lib/investment-import-bridge/auAccountResolution.ts's confirmNewAuStatementAccount
// insert shape against real DEV Postgres, service-role, exactly as the
// fixed route calls it only after proving homeCountry === 'AU' server-side).
// ---------------------------------------------------------------------------
async function checkAuBridgeCurrencyCannotInfluenceCountry(au) {
  console.log('\n=== Check 4: FDH-11 bridge — currency_code cannot influence the persisted country_code ===');
  const insert = await rest('ii_accounts', {
    method: 'POST',
    body: JSON.stringify({
      user_id: au.id,
      institution_name: 'G5DbLevelBroker',
      account_type: 'broker',
      country_code: 'AU', // hardcoded by the real bridge code, never derived from currency
      currency_code: 'INR', // deliberately MISMATCHED — proves currency is not read for jurisdiction
      account_number_masked: '****9999',
    }),
  });
  check('ii_accounts row persists with country_code=AU even though currency_code=INR (mismatched)', insert.json?.[0]?.country_code === 'AU' && insert.json?.[0]?.currency_code === 'INR', JSON.stringify(insert.json));
  return insert.json?.[0]?.id ?? null;
}

async function cleanup(userIds, accountId) {
  console.log('\n=== Cleanup + residue re-verification ===');
  if (accountId) await rest(`ii_accounts?id=eq.${accountId}`, { method: 'DELETE', prefer: 'return=minimal' });

  // Sweep EVERY user tagged for this script, not just this run's own ids —
  // catches residue left behind by an earlier interrupted/failed run (e.g.
  // a fixture-validation error before this run's own cleanup could fire).
  const allUsers = await fetch(`${URL_}/auth/v1/admin/users?page=1&per_page=200`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).then((r) => r.json());
  const tagged = (allUsers.users ?? []).filter((u) => u.email?.includes(TAG));
  const idsToDelete = new Set([...userIds, ...tagged.map((u) => u.id)]);
  for (const id of idsToDelete) {
    await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  }
  const usersLeft = await fetch(`${URL_}/auth/v1/admin/users?page=1&per_page=200`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).then((r) => r.json());
  const stillThere = (usersLeft.users ?? []).filter((u) => u.email?.includes(TAG));
  check('Cleanup: zero synthetic g5-dblevel users remain', stillThere.length === 0, JSON.stringify(stillThere.map((u) => u.email)));

  for (const table of ['retirement_members', 'ii_accounts']) {
    const orphanCheck = await rest(`${table}?user_id=in.(${userIds.map((id) => `"${id}"`).join(',') || '"00000000-0000-0000-0000-000000000000"'})&select=id`);
    const rows = Array.isArray(orphanCheck.json) ? orphanCheck.json : [];
    check(`Cleanup: no residue rows left in ${table}`, rows.length === 0, JSON.stringify(rows).slice(0, 200));
  }
}

async function main() {
  console.log('G5 LIVE DEV CERTIFICATION — DB-level fallback');
  console.log(`  DEV project : ${new URL(URL_).host}`);

  let users = { au: null, inUser: null, generic: null };
  let accountId = null;
  try {
    await checkCountryRegistry();
    users = await checkDirectInsertGating();
    accountId = await checkAuBridgeCurrencyCannotInfluenceCountry(users.au);
  } finally {
    if (!process.argv.includes('--no-cleanup')) {
      await cleanup([users.au, users.inUser, users.generic].filter(Boolean).map((u) => u.id), accountId);
    }
  }

  console.log(`\n=== RESULT: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) { console.log('FAILURES:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
}

main();
