// G5 (Existing-Module Realignment) — LIVE DEV certification for the two
// AU-default country defects fixed in commit 2bff056:
//
//   G5-D1: lib/services/retirementMemberData.ts's loadRetirementPlanningContext()
//   G5-D2: the FDH-11 investment-statement upload + account-match routes
//
// Runs for real against hosted DEV Postgres (vqycarelcoijzwlpkpcz) + a real
// running `next dev` instance started explicitly from this worktree. Pattern
// established by scripts/fdh11_live_dev_certification.mjs and
// scripts/fdh12_live_dev_certification.mjs: service-role REST for fixtures +
// real signup + cookie-based session for HTTP calls against the app's own
// API routes + service-role reads to inspect what actually got persisted.
//
// Every user/document/statement created here is tagged
// `g5-livedev-*@fhip-test.invalid` and deleted at the end via the
// service-role admin API; deletion is independently re-verified by re-query,
// never merely assumed.
//
// Run: node scripts/g5_livedev_certification.mjs

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e?.stack || e)); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.env.G5_APP ?? 'http://localhost:3418';

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
const PROJECT_REF = new URL(URL_).host.split('.')[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;
const TAG = 'g5-livedev';

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label} ${detail}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

async function rest(pathAndQuery, opts = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...opts.headers };
  const r = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

const createdUsers = [];

async function createUser(tag, { country, currency, confirmed = true }) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${TAG}-${tag}-${stamp}@fhip-test.invalid`;
  const password = `G5Live!${stamp}`;
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
    full_name: `G5 Live ${tag}`,
    country_of_residence: country,
    // G3 migration 0127: preferred_currency (the REPORTING currency) may
    // only ever be AUD or INR (lib/engines/fx.ts's SupportedCurrency).
    preferred_currency: ['AU', 'IN'].includes(country) ? currency : 'AUD',
    onboarding_completed: true,
    employment_status: 'full_time_employed',
    profile_completion_percentage: 100,
  };
  if (confirmed) {
    Object.assign(profilePatch, { country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
    if (!['AU', 'IN'].includes(country)) {
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password }),
  })).json();
  if (!tok.access_token) throw new Error(`sign-in failed for ${tag}: ${JSON.stringify(tok).slice(0, 300)}`);
  const session = {
    access_token: tok.access_token, token_type: tok.token_type, expires_in: tok.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + tok.expires_in,
    refresh_token: tok.refresh_token, user: tok.user,
  };
  const cookie = `${COOKIE_NAME}=base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`;
  return { id: j.id, email, password, cookie, country, currency };
}

async function app(user, pathName, opts = {}) {
  const r = await fetch(`${APP}${pathName}`, { ...opts, headers: { Cookie: user.cookie, ...opts.headers } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

function csvBytes(text) { return Buffer.from(text, 'utf8'); }

async function uploadCsv(user, extra = {}) {
  const params = new URLSearchParams({ csv_kind: 'transaction', currency_code: extra.currency_code ?? 'AUD', institution_name: 'G5LiveCertBroker', ...extra });
  const csv = ['Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount', '10/03/2026,BUY,CBA,AU000000CBA7,Commonwealth Bank,10,110.00,1100.00'].join('\n');
  return app(user, `/api/financial-data-hub/investment-statement/upload?${params.toString()}`, {
    method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csvBytes(csv),
  });
}

// ---------------------------------------------------------------------------
// Phase 0: confirm this dev server is serving THIS worktree/branch.
// ---------------------------------------------------------------------------
async function phase0Preflight() {
  console.log('\n=== Phase 0: preflight — dev server identity ===');
  const probe = await fetch(`${APP}/api/financial-data-hub/investment-statement/upload`, { method: 'POST' });
  check('Dev server on this port serves a build with this route (401, not 404)', probe.status === 401, `status=${probe.status}`);
}

// ---------------------------------------------------------------------------
// Phase 1: Retirement — AU / IN / GENERIC / unconfirmed (G5-D1)
// ---------------------------------------------------------------------------
async function phase1Retirement() {
  console.log('\n=== Phase 1: Retirement members route — AU/IN/GENERIC/unconfirmed (G5-D1) ===');

  const au = await createUser('rm-au', { country: 'AU', currency: 'AUD' });
  const inUser = await createUser('rm-in', { country: 'IN', currency: 'INR' });
  const generic = await createUser('rm-generic', { country: 'GB', currency: 'GBP' });
  const unconfirmed = await createUser('rm-unconfirmed', { country: 'AU', currency: 'AUD', confirmed: false });

  const auGet = await app(au, '/api/retirement/members');
  check('AU: GET /api/retirement/members succeeds', auGet.status === 200, `status=${auGet.status}`);
  check('AU: countryCode resolves to AU (unchanged behaviour)', auGet.json?.data?.countryCode === 'AU', JSON.stringify(auGet.json?.data?.countryCode));
  check('AU: countryDefaultRetirementAge is a number', typeof auGet.json?.data?.countryDefaultRetirementAge === 'number');

  const inGet = await app(inUser, '/api/retirement/members');
  check('IN: GET /api/retirement/members succeeds', inGet.status === 200, `status=${inGet.status}`);
  check('IN: countryCode resolves to IN (unchanged behaviour)', inGet.json?.data?.countryCode === 'IN', JSON.stringify(inGet.json?.data?.countryCode));

  const genericGet = await app(generic, '/api/retirement/members');
  check('GENERIC (GB): GET /api/retirement/members is refused (403)', genericGet.status === 403, `status=${genericGet.status}`);
  check('GENERIC (GB): refused with GENERIC_EXPERIENCE_RESTRICTED, never the inner fail-closed 400 (route gate wins first)', genericGet.json?.error === 'GENERIC_EXPERIENCE_RESTRICTED', JSON.stringify(genericGet.json));

  const unconfirmedGet = await app(unconfirmed, '/api/retirement/members');
  check('Unconfirmed AU: GET /api/retirement/members is refused (403 COUNTRY_CONFIRMATION_REQUIRED)', unconfirmedGet.status === 403 && unconfirmedGet.json?.error === 'COUNTRY_CONFIRMATION_REQUIRED', JSON.stringify(unconfirmedGet.json));

  // Existing AU/IN PATCH behaviour unchanged — round-trip a target age.
  const auPatch = await app(au, '/api/retirement/members', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_type: 'self', target_retirement_age: 68 }),
  });
  check('AU: PATCH target_retirement_age succeeds', auPatch.status === 200, `status=${auPatch.status} body=${auPatch.text.slice(0, 200)}`);
  const auGet2 = await app(au, '/api/retirement/members');
  check('AU: PATCH persisted (self.target_retirement_age === 68)', auGet2.json?.data?.self?.target_retirement_age === 68, JSON.stringify(auGet2.json?.data?.self));

  const inPatch = await app(inUser, '/api/retirement/members', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_type: 'self', target_retirement_age: 58 }),
  });
  check('IN: PATCH target_retirement_age succeeds', inPatch.status === 200, `status=${inPatch.status} body=${inPatch.text.slice(0, 200)}`);
  const inGet2 = await app(inUser, '/api/retirement/members');
  check('IN: PATCH persisted (self.target_retirement_age === 58)', inGet2.json?.data?.self?.target_retirement_age === 58, JSON.stringify(inGet2.json?.data?.self));

  return { au, inUser, generic, unconfirmed };
}

// ---------------------------------------------------------------------------
// Phase 2: Investment-statement upload + account-match — AU/IN/GENERIC (G5-D2)
// ---------------------------------------------------------------------------
async function phase2InvestmentStatement() {
  console.log('\n=== Phase 2: Investment-statement upload/account-match — AU/IN/GENERIC (G5-D2) ===');

  const au = await createUser('is-au', { country: 'AU', currency: 'AUD' });
  const inUser = await createUser('is-in', { country: 'IN', currency: 'INR' });
  const generic = await createUser('is-generic', { country: 'US', currency: 'USD' });

  // --- IN: FULL experience, but NOT AU -- must be refused by the AU-only bridge
  const inUpload = await uploadCsv(inUser, { currency_code: 'INR' });
  check('IN (FULL, not AU): upload is refused (403), never silently treated as AU', inUpload.status === 403, `status=${inUpload.status} body=${inUpload.text.slice(0, 200)}`);
  check('IN: refusal message names Australia/manual-review path, not a raw error', /Australia|CAS-based/i.test(inUpload.text), inUpload.text.slice(0, 200));

  // --- GENERIC: refused at the route-level gate BEFORE the AU-only check even runs
  const genericUpload = await uploadCsv(generic, { currency_code: 'USD' });
  check('GENERIC (US): upload is refused (403 GENERIC_EXPERIENCE_RESTRICTED) at the route gate', genericUpload.status === 403 && genericUpload.json?.error === 'GENERIC_EXPERIENCE_RESTRICTED', JSON.stringify(genericUpload.json ?? genericUpload.text.slice(0, 200)));

  // --- AU: real, unchanged happy path
  const auUpload = await uploadCsv(au, { currency_code: 'AUD' });
  check('AU: upload succeeds', auUpload.status === 200, `status=${auUpload.status} body=${auUpload.text.slice(0, 300)}`);
  const documentId = auUpload.json?.data?.document_id;
  check('AU: upload returns a document_id', !!documentId, documentId);

  let auAccountRow = null;
  if (documentId) {
    const acctMatch = await app(au, `/api/financial-data-hub/investment-statement/${documentId}/account-match`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // Forged-field probe: inject a `country_code` the schema does not
      // declare, and set currency_code to a MISMATCHED (non-AUD) value —
      // proving neither can influence the resolved jurisdiction (PO
      // requirement: "forged country and mismatched currency cannot
      // influence jurisdiction").
      body: JSON.stringify({ action: 'confirm_new', institution_name: 'G5LiveCertBroker', masked_account_identifier: '****1234', currency_code: 'INR', country_code: 'IN' }),
    });
    check('AU: account-match (confirm_new) succeeds despite forged country_code + mismatched currency_code in the body', acctMatch.status === 200, `status=${acctMatch.status} body=${acctMatch.text.slice(0, 300)}`);

    const acctId = acctMatch.json?.data?.account_id ?? acctMatch.json?.data?.id;
    if (acctId) {
      const acctRow = await rest(`ii_accounts?id=eq.${acctId}&select=id,country_code,currency_code,user_id`);
      auAccountRow = acctRow.json?.[0] ?? null;
      check('AU: resulting ii_accounts row is country_code=AU regardless of forged body field', auAccountRow?.country_code === 'AU', JSON.stringify(auAccountRow));
      check('AU: resulting ii_accounts row currency_code reflects the (client-supplied, non-jurisdiction) currency_code field as designed — INR here, proving currency is NOT used to derive country', auAccountRow?.currency_code === 'INR', JSON.stringify(auAccountRow));
    } else {
      check('AU: account-match response contains an account id to verify', false, JSON.stringify(acctMatch.json));
    }

    // Document lineage / audit trail unchanged: an audit event exists for
    // this document (upload event at minimum).
    const audit = await rest(`fdh_document_audit_events?document_id=eq.${documentId}&select=id,event_type,user_id&order=created_at.asc`);
    check('AU: document audit trail recorded at least one event (lineage unaffected by the fix)', Array.isArray(audit.json) && audit.json.length > 0, JSON.stringify(audit.json));
  }

  // --- IN account-match entry point directly (bypassing upload) also refused
  // Confirms the SECOND fixed entry point (account-match route itself, not
  // just its paired upload route) independently blocks a non-AU FULL user
  // even if they somehow obtained a documentId (defence in depth — never
  // trust upload's gate alone).
  const inFakeDocProbe = await app(inUser, `/api/financial-data-hub/investment-statement/00000000-0000-0000-0000-000000000000/account-match`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resolve', account_type: 'broker', currency_code: 'INR' }),
  });
  check('IN: account-match route itself refuses a non-AU caller before even checking the statement (403)', inFakeDocProbe.status === 403, `status=${inFakeDocProbe.status} body=${inFakeDocProbe.text.slice(0, 200)}`);

  return { au, inUser, generic, documentId, auAccountRow };
}

// ---------------------------------------------------------------------------
// Phase 3: Cleanup — remove all synthetic residue, independently re-verify.
// ---------------------------------------------------------------------------
async function phaseCleanup() {
  console.log('\n=== Phase 3: cleanup + residue re-verification ===');
  for (const id of createdUsers) {
    await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  }
  // Re-verify: no residue tagged g5-livedev remains in auth.users or any
  // table this run could have written to.
  const usersLeft = await fetch(`${URL_}/auth/v1/admin/users?page=1&per_page=200`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).then((r) => r.json());
  const stillThere = (usersLeft.users ?? []).filter((u) => u.email?.includes(TAG));
  check('Cleanup: zero synthetic g5-livedev users remain after deletion', stillThere.length === 0, JSON.stringify(stillThere.map((u) => u.email)));

  for (const table of ['retirement_members', 'fdh_investment_statements', 'ii_accounts', 'fdh_document_audit_events']) {
    const orphanCheck = await rest(`${table}?user_id=in.(${createdUsers.map((id) => `"${id}"`).join(',') || '"00000000-0000-0000-0000-000000000000"'})&select=id`);
    const rows = Array.isArray(orphanCheck.json) ? orphanCheck.json : [];
    check(`Cleanup: no residue rows left in ${table} for deleted synthetic users`, rows.length === 0, JSON.stringify(rows).slice(0, 200));
  }
}

async function main() {
  console.log(`G5 LIVE DEV CERTIFICATION — retirement (G5-D1) + investment-statement (G5-D2)`);
  console.log(`  DEV project : ${new URL(URL_).host}`);
  console.log(`  App server  : ${APP}`);

  try {
    await phase0Preflight();
    await phase1Retirement();
    await phase2InvestmentStatement();
  } finally {
    if (!process.argv.includes('--no-cleanup')) await phaseCleanup();
  }

  console.log(`\n=== RESULT: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) { console.log('FAILURES:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
}

main();
