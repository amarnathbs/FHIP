// FDH-12 — Retirement Statement Intelligence: LIVE DEV certification.
//
// Spec sections 119-134, 137, 139, 167 (+ 171 cleanup).
//
// Runs for real against hosted DEV Postgres (vqycarelcoijzwlpkpcz) + a real
// running `next dev` instance started explicitly from this worktree
// (D:/fhip-fdh12, port 3212 — confirmed serving THIS codebase by probing
// POST /api/financial-data-hub/retirement-statement/upload, a route that
// exists only on this branch, and receiving 401 rather than 404).
//
// Migration 0112 was applied to DEV by the Product Owner. This script
// re-verifies that structurally (spec 167) before doing anything else.
//
// Pattern established by scripts/fdh11_live_dev_certification.mjs:
// service-role REST for fixtures + real signup + cookie session for HTTP
// calls against the app's own API routes + service-role reads to inspect what
// actually got persisted. Every synthetic user/document/statement/activity/
// proposal/application is tagged `fdh12-livedev-*@fhip-test.invalid` and
// deleted at the end; deletion is independently re-verified by re-query.
//
// Run: node scripts/fdh12_live_dev_certification.mjs [phase ...]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.env.FDH12_APP ?? 'http://localhost:3212';

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
const PROJECT_REF = new URL(URL_).host.split('.')[0];
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`;
const TAG = `fdh12-livedev`;

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label}${detail ? ' ' + detail : ''}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' ' + detail : ''}`); }
};

async function rest(pathAndQuery, opts = {}, key = SERVICE) {
  const headers = {
    apikey: key, Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: opts.prefer ?? 'return=representation',
    ...opts.headers,
  };
  const r = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, { ...opts, headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

/** PostgREST as the ANON role (no JWT beyond the anon key). */
const anonRest = (p, o = {}) => rest(p, o, ANON);

/** PostgREST as a real authenticated end user (role = authenticated). */
async function userRest(user, pathAndQuery, opts = {}) {
  const headers = {
    apikey: ANON, Authorization: `Bearer ${user.accessToken}`,
    'Content-Type': 'application/json',
    Prefer: opts.prefer ?? 'return=representation',
    ...opts.headers,
  };
  const r = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, { ...opts, headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

const createdUsers = [];

async function createUser(tag, { country = 'AU', currency = 'AUD' } = {}) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${TAG}-${tag}-${stamp}@fhip-test.invalid`;
  const password = `Fdh12Live!${stamp}`;
  const r = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = await r.json();
  if (!j.id) throw new Error(`could not create user ${tag}: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  // MCC-14's country-confirmation gate is live on DEV (migration 0111 from the
  // sibling branch). A synthetic user must confirm a country before any FDH
  // document write is permitted — this is the real product rule, satisfied
  // here exactly as a real user would.
  const prof = await rest(`user_profiles?user_id=eq.${j.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      full_name: `FDH12 Live ${tag}`,
      country_of_residence: country,
      preferred_currency: currency,
      onboarding_completed: true,
      employment_status: 'full_time_employed',
      profile_completion_percentage: 100,
      country_confirmed_at: now,
      country_source: 'USER_CONFIRMED',
      country_updated_at: now,
    }),
  });
  if (prof.status >= 300) throw new Error(`profile patch failed for ${tag}: ${prof.text.slice(0, 300)}`);

  const tok = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({ email, password }),
  })).json();
  const session = {
    access_token: tok.access_token, token_type: tok.token_type, expires_in: tok.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + tok.expires_in,
    refresh_token: tok.refresh_token, user: tok.user,
  };
  const cookie = `${COOKIE_NAME}=base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`;
  const user = { id: j.id, email, password, cookie, accessToken: tok.access_token, country, currency };
  createdUsers.push(user);
  return user;
}

async function app(user, pathName, opts = {}) {
  const r = await fetch(`${APP}${pathName}`, {
    ...opts,
    headers: { Cookie: user.cookie, ...opts.headers },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

async function uploadStatement(user, csvText, meta = {}) {
  const params = new URLSearchParams({
    jurisdiction: meta.jurisdiction ?? 'AU',
    currency_code: meta.currency_code ?? 'AUD',
    ...(meta.fund_name ? { fund_name: meta.fund_name } : {}),
    ...(meta.masked_account_identifier ? { masked_account_identifier: meta.masked_account_identifier } : {}),
    ...(meta.statement_date ? { statement_date: meta.statement_date } : {}),
    ...(meta.statement_period_start ? { statement_period_start: meta.statement_period_start } : {}),
    ...(meta.statement_period_end ? { statement_period_end: meta.statement_period_end } : {}),
  });
  return app(user, `/api/financial-data-hub/retirement-statement/upload?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: Buffer.from(csvText, 'utf8'),
  });
}

async function post(user, documentId, suffix, body) {
  return app(user, `/api/financial-data-hub/retirement-statement/${documentId}${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function seedMember(user, memberType = 'self') {
  const r = await rest('retirement_members', {
    method: 'POST',
    body: JSON.stringify({
      user_id: user.id, member_type: memberType, is_active: true,
      age_source: 'suggested_default', country_code: user.country,
    }),
  });
  if (r.status >= 300) throw new Error(`seedMember: ${r.text.slice(0, 200)}`);
  return r.json[0];
}

async function seedAccount(user, { name, balance = '0.00', memberId = null, owner = 'self', masterItemKey = null, accountType = 'super' }) {
  const r = await rest('retirement_accounts', {
    method: 'POST',
    body: JSON.stringify({
      user_id: user.id, account_name: name, account_type: accountType,
      current_balance: balance, currency_code: user.currency, country_code: user.country,
      owner, source_type: 'manual', currency_override: false, is_active: true,
      retirement_member_id: memberId, master_item_key: masterItemKey,
    }),
  });
  if (r.status >= 300) throw new Error(`seedAccount: ${r.text.slice(0, 300)}`);
  return r.json[0];
}

async function seedBankAccount(user) {
  const r = await rest('fdh_financial_accounts', {
    method: 'POST',
    body: JSON.stringify({
      user_id: user.id, account_type: 'transaction', country_code: user.country,
      currency_code: user.currency, display_name: 'LiveCert Everyday', status: 'active',
    }),
  });
  if (r.status >= 300) throw new Error(`seedBankAccount: ${r.text.slice(0, 300)}`);
  return r.json[0];
}

async function seedTransaction(user, accountId, { date, amount, direction, description, economicType = 'transfer' }) {
  const r = await rest('fdh_transactions', {
    method: 'POST',
    body: JSON.stringify({
      user_id: user.id, financial_account_id: accountId, transaction_date: date,
      amount_original: amount, currency_original: user.currency, credit_debit: direction,
      description_raw: description, description_clean: description,
      economic_transaction_type: economicType,
      recurring_flag: false, subscription_flag: false, transfer_flag: true,
      review_status: 'not_required', user_override: false,
      dedup_status: 'unique', transaction_type_hint: 'transfer_candidate',
      approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: user.id,
    }),
  });
  if (r.status >= 300) throw new Error(`seedTransaction: ${r.text.slice(0, 300)}`);
  return r.json[0];
}

async function seedPayrollEvent(user, { employer, periodStart, periodEnd, paymentDate, employerSuper }) {
  const r = await rest('fdh_payroll_events', {
    method: 'POST',
    body: JSON.stringify({
      user_id: user.id, employer_name: employer, country_code: user.country,
      currency_code: user.currency, pay_period_start: periodStart, pay_period_end: periodEnd,
      payment_date: paymentDate, pay_frequency: 'fortnightly', pay_frequency_source: 'stated_on_payslip',
      gross_pay: '5000.0000', employer_retirement_contribution: employerSuper,
      reconciliation_status: 'reconciled', bank_match_status: 'not_attempted',
      review_status: 'not_required', approval_status: 'approved',
      approved_at: new Date().toISOString(), approved_by: user.id,
    }),
  });
  if (r.status >= 300) throw new Error(`seedPayrollEvent: ${r.text.slice(0, 300)}`);
  return r.json[0];
}

/** PostgREST returns `numeric` as a JSON number, so '105675.0000' arrives as
 *  105675. Compare money by exact numeric value, never by string shape. */
const money = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Approve statement evidence through the REAL route, and record what actually
 * happened.
 *
 * DEFECT FDH12-LD-1 (found by this run, 2026-08-30, fixed forward in migration
 * `0113_fdh12_approve_rpc_authoritative_write_fix.sql`, NOT yet applied to
 * DEV): `fdh12_approve_retirement_statement()` is refused by migration 0112
 * PART F's own authoritative-write trigger, because `security definer` does
 * not change `auth.role()`. Until 0113 reaches DEV no caller can approve
 * anything, so the whole downstream chain is unreachable.
 *
 * To keep the REST of the live chain genuinely certified rather than merely
 * blocked, this helper falls back to a SERVICE-ROLE approval — the same stub
 * the PGlite harness used — and returns `{ liveApproval: false }` so every
 * downstream check can be labelled honestly. Nothing here hides the failure:
 * the real call is made first and its real response is asserted on.
 */
async function approveEvidence(user, documentId, statementId, label) {
  const r = await post(user, documentId, '/approve', {});
  if (r.status === 200 && r.json?.data?.approved === true) {
    check(`${label} evidence approved through the real route`, true);
    return { liveApproval: true };
  }
  const blockedByDefect = r.status === 400 && /system-authoritative/.test(r.text);
  check(`${label} evidence approved through the real route`, false,
    blockedByDefect
      ? '[DEFECT FDH12-LD-1: fdh12_approve_retirement_statement is refused by 0112 PART F; fixed forward in migration 0113, which is NOT applied to DEV]'
      : `status=${r.status} ${r.text.slice(0, 160)}`);
  const stub = await rest(`fdh_retirement_statements?id=eq.${statementId}`, {
    method: 'PATCH',
    body: JSON.stringify({ approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: user.id, review_status: 'resolved' }),
  });
  if (stub.status >= 300) throw new Error(`approval stub failed: ${stub.text.slice(0, 200)}`);
  return { liveApproval: false };
}

/** Suffix appended to every check whose chain passed through the stub. */
const STUB = '[approval step stubbed via service role — pending migration 0113 on DEV]';

/** The FULL canonical retirement row, as a stable string. §129's instrument. */
async function snapshotAccount(accountId) {
  const r = await rest(`retirement_accounts?id=eq.${accountId}&select=*`);
  const row = r.json?.[0] ?? null;
  return row ? JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]])) : 'MISSING';
}

async function countRows(table, userId, extra = '') {
  const r = await rest(`${table}?select=id&user_id=eq.${userId}${extra}`, { headers: { Prefer: 'count=exact' } });
  return Array.isArray(r.json) ? r.json.length : -1;
}

// ===========================================================================
// CSV fixtures
// ===========================================================================

/** A fully reconcilable AU member-statement summary.
 *  100000 + 1000 + 5000 - 100 - 75 - 150 = 105675 */
function summaryCsv({ opening = '100000.00', employer = '1000.00', earnings = '5000.00', fee = '100.00', insurance = '75.00', tax = '150.00', closing = '105675.00', extraLines = [] } = {}) {
  const lines = ['Item,Amount,Period'];
  if (opening !== null) lines.push(`Opening Balance,${opening},Statement period`);
  if (employer !== null) lines.push(`Employer Contributions,${employer},Statement period`);
  if (earnings !== null) lines.push(`Investment Earnings,${earnings},Statement period`);
  if (fee !== null) lines.push(`Administration Fee,${fee},Statement period`);
  if (insurance !== null) lines.push(`Insurance Premium,${insurance},Statement period`);
  if (tax !== null) lines.push(`Contributions Tax,${tax},Statement period`);
  lines.push(...extraLines);
  if (closing !== null) lines.push(`Closing Balance,${closing},Statement period`);
  return lines.join('\n') + '\n';
}

function transactionCsv(rows, { withEmployerColumn = true } = {}) {
  const header = withEmployerColumn ? 'Date,Description,Amount,Employer' : 'Date,Description,Amount';
  return [header, ...rows].join('\n') + '\n';
}

// ===========================================================================
// PHASES
// ===========================================================================

const state = {};

async function phaseSchema() {
  console.log('\n=== §167 — LIVE DEV SCHEMA VERIFICATION ===');

  const spec = await (await fetch(`${URL_}/rest/v1/`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  })).json();
  const paths = new Set(Object.keys(spec.paths));
  const defs = spec.definitions;

  const TABLES = ['fdh_retirement_statements', 'fdh_retirement_statement_activities', 'fdh_retirement_statement_positions'];
  for (const t of TABLES) check(`§167 table ${t} exists live`, paths.has('/' + t));
  for (const fn of ['fdh12_approve_retirement_statement', 'fdh12_apply_retirement_proposal']) {
    check(`§167 RPC ${fn} registered live`, paths.has('/rpc/' + fn));
  }
  check('§167 retirement_accounts.last_import_application_id exists live',
    'last_import_application_id' in (defs.retirement_accounts?.properties ?? {}));
  check('§167 retirement_accounts.last_imported_at exists live',
    'last_imported_at' in (defs.retirement_accounts?.properties ?? {}));
  check('§167 fhip_import_proposals.source_retirement_statement_id exists live',
    'source_retirement_statement_id' in (defs.fhip_import_proposals?.properties ?? {}));
  check('§167 fhip_import_applications.source_retirement_statement_id exists live',
    'source_retirement_statement_id' in (defs.fhip_import_applications?.properties ?? {}));

  // Column-by-column comparison against the migration file itself.
  const mig = fs.readFileSync(path.join(repoRoot, 'supabase/migrations/0112_fdh12_retirement_statement_intelligence.sql'), 'utf8');
  for (const t of TABLES) {
    const m = mig.match(new RegExp(`create table ${t} \\(([\\s\\S]*?)\\n\\);`, 'm'));
    if (!m) { check(`§167 could parse migration DDL for ${t}`, false); continue; }
    const declared = new Set();
    for (const raw of m[1].split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('--')) continue;
      const cm = line.match(/^([a-z_][a-z0-9_]*)\s+(uuid|text|char|numeric|jsonb|boolean|date|timestamptz|integer|int|bigint)\b/);
      if (cm) declared.add(cm[1]);
    }
    const live = new Set(Object.keys(defs[t]?.properties ?? {}));
    const missing = [...declared].filter((c) => !live.has(c));
    const extra = [...live].filter((c) => !declared.has(c));
    check(`§167 ${t}: every migration-declared column exists live (${declared.size} declared)`, missing.length === 0, missing.length ? `missing=${missing.join(',')}` : '');
    check(`§167 ${t}: live has no column the migration did not declare`, extra.length === 0, extra.length ? `extra=${extra.join(',')}` : '');
    // Spec 142 — exact decimal money. PostgREST reports numeric as "number"
    // with format "numeric"; a float8 would report format "double precision".
    const floats = Object.entries(defs[t]?.properties ?? {})
      .filter(([, v]) => /double precision|real/.test(String(v.format ?? '')))
      .map(([k]) => k);
    check(`§167 ${t}: no floating-point money column live (spec 142)`, floats.length === 0, floats.join(','));
  }

  // --- RLS ENFORCEMENT, with real negative + positive controls -------------
  const probe = await createUser('schema');
  const stmt = await rest('fdh_retirement_statements', {
    method: 'POST',
    body: JSON.stringify({
      user_id: probe.id, statement_type: 'super_member_statement',
      retirement_jurisdiction: 'AU', account_type: 'industry_super', currency_code: 'AUD',
      fund_name: 'LiveCert RLS Probe Fund', extraction_status: 'extracted',
    }),
  });
  check('§167 service-role can seed a probe statement (positive control)', stmt.status === 201, `status=${stmt.status}`);
  const probeStatementId = stmt.json?.[0]?.id;
  state.schemaProbe = { user: probe, statementId: probeStatementId };

  const act = await rest('fdh_retirement_statement_activities', {
    method: 'POST',
    body: JSON.stringify({
      user_id: probe.id, statement_id: probeStatementId, activity_type: 'FEE',
      amount: '1.00', currency_code: 'AUD', activity_date: '2026-01-01',
    }),
  });
  check('§167 service-role can seed a probe activity (positive control)', act.status === 201, `status=${act.status}`);
  const pos = await rest('fdh_retirement_statement_positions', {
    method: 'POST',
    body: JSON.stringify({
      user_id: probe.id, statement_id: probeStatementId,
      option_name_raw: 'Balanced', market_value: '1.00', currency_code: 'AUD',
    }),
  });
  check('§167 service-role can seed a probe position (positive control)', pos.status === 201, `status=${pos.status}`);

  for (const t of TABLES) {
    const svc = await rest(`${t}?select=id&user_id=eq.${probe.id}`);
    const an = await anonRest(`${t}?select=id&user_id=eq.${probe.id}`);
    check(`§167 RLS ${t}: service role SEES the row (positive control — the anon empty result below is not vacuous)`,
      (svc.json?.length ?? 0) === 1, `rows=${svc.json?.length}`);
    check(`§167 RLS ${t}: ANON read returns 0 rows`, Array.isArray(an.json) && an.json.length === 0,
      `status=${an.status} rows=${Array.isArray(an.json) ? an.json.length : 'n/a'}`);
  }
  const anonWrite = await anonRest('fdh_retirement_statements', {
    method: 'POST',
    body: JSON.stringify({
      user_id: probe.id, statement_type: 'super_member_statement', retirement_jurisdiction: 'AU',
      account_type: 'industry_super', currency_code: 'AUD',
    }),
  });
  check('§167 RLS fdh_retirement_statements: ANON INSERT refused', anonWrite.status >= 400,
    `status=${anonWrite.status} code=${anonWrite.json?.code}`);

  // RPCs are executable by an authenticated user and refuse anon.
  const anonRpc = await fetch(`${URL_}/rest/v1/rpc/fdh12_approve_retirement_statement`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_statement_id: probeStatementId }),
  });
  const anonRpcText = await anonRpc.text();
  check('§167 fdh12_approve_retirement_statement refuses the ANON role', anonRpc.status >= 400,
    `status=${anonRpc.status} ${anonRpcText.slice(0, 90)}`);
}

async function phaseJourney() {
  console.log('\n=== §119 / §127 / §129 / §120(canonical) — AUSTRALIA LIVE DEV JOURNEY ===');

  const user = await createUser('journeyA');
  const member = await seedMember(user, 'self');
  const account = await seedAccount(user, { name: 'LiveCert Horizon Super', balance: '100000.00', memberId: member.id });
  state.A = { user, member, account };

  const before = await snapshotAccount(account.id);
  const snaps = [];

  // --- Upload -------------------------------------------------------------
  const csv = summaryCsv();
  const up = await uploadStatement(user, csv, {
    fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****1234',
    statement_date: '2026-06-30', statement_period_start: '2026-01-01', statement_period_end: '2026-06-30',
  });
  check('§119 upload accepted by the real API route', up.status === 200, `status=${up.status} ${up.text.slice(0, 160)}`);
  const documentId = up.json?.data?.document_id;
  const statementId = up.json?.data?.statement_id;
  check('§119 a document and a statement were created', Boolean(documentId && statementId), `doc=${documentId} stmt=${statementId}`);
  check('§119 pipeline_status ok', up.json?.data?.pipeline_status === 'ok', String(up.json?.data?.pipeline_status));
  snaps.push(['after upload+parse', await snapshotAccount(account.id)]);
  state.A.documentId = documentId;
  state.A.statementId = statementId;

  const s1 = (await rest(`fdh_retirement_statements?id=eq.${statementId}&select=*`)).json?.[0];
  check('§119 extraction_status = extracted', s1?.extraction_status === 'extracted', String(s1?.extraction_status));
  check('§127 LIVE: a fully reconcilable statement reports RECONCILED',
    s1?.reconciliation_status === 'reconciled', `status=${s1?.reconciliation_status} variance=${s1?.reconciliation_variance}`);
  check('§127 LIVE: reported variance is exactly zero',
    Number(s1?.reconciliation_variance) === 0, String(s1?.reconciliation_variance));
  check('§119 closing balance read from the statement', money(s1?.closing_balance) === 105675, String(s1?.closing_balance));
  check('§123 LIVE: the admin fee was read as $100 of retirement value reduction', money(s1?.fees) === 100, String(s1?.fees));
  check('§124 LIVE: the insurance premium was read as $75 of retirement value reduction', money(s1?.insurance_premiums) === 75, String(s1?.insurance_premiums));
  check('§125 LIVE: investment earnings read as $5,000 of retirement asset movement', money(s1?.investment_earnings) === 5000, String(s1?.investment_earnings));

  // --- Member + account match --------------------------------------------
  const am = await post(user, documentId, '/account-match', { action: 'auto' });
  check('§119 account match ran', am.status === 200, `status=${am.status} ${am.text.slice(0, 160)}`);
  check('§119 statement matched the canonical account', am.json?.data?.canonical_account_id === account.id,
    String(am.json?.data?.canonical_account_id));
  check('§119 statement resolved the household member', am.json?.data?.retirement_member_id === member.id,
    String(am.json?.data?.retirement_member_id));
  snaps.push(['after account+member match', await snapshotAccount(account.id)]);

  // --- Evidence reconciliation -------------------------------------------
  const ev = await post(user, documentId, '/evidence-matches', {});
  check('§119 evidence matching ran', ev.status === 200, `status=${ev.status} ${ev.text.slice(0, 200)}`);
  snaps.push(['after evidence matching', await snapshotAccount(account.id)]);

  // --- Review + approve ---------------------------------------------------
  const approval = await approveEvidence(user, documentId, statementId, '§119');
  state.A.liveApproval = approval.liveApproval;
  const stubNote = approval.liveApproval ? '' : STUB;
  snaps.push(['after approve-evidence', await snapshotAccount(account.id)]);

  // --- Compare (proposal) -------------------------------------------------
  const pr = await post(user, documentId, '/proposal', {});
  check(`§119 comparison/proposal generated ${stubNote}`, pr.status === 200, `status=${pr.status} ${pr.text.slice(0, 200)}`);
  const proposalId = pr.json?.data?.proposal_id;
  state.A.proposalId = proposalId;
  const fields = pr.json?.data?.fields ?? [];
  const byName = Object.fromEntries(fields.map((f) => [f.fieldName ?? f.field_name, f]));
  check(`§119 proposal recommends UPDATE EXISTING against the matched account ${stubNote}`,
    pr.json?.data?.recommended_apply_mode === 'update_existing' && pr.json?.data?.target_entity_id === account.id,
    `${pr.json?.data?.recommended_apply_mode} / ${pr.json?.data?.target_entity_id}`);
  check(`§119 proposal carries the statement closing balance ${stubNote}`, byName.current_balance?.proposedValue === '105675.00',
    String(byName.current_balance?.proposedValue));
  check(`§120 proposal carries employer contribution of exactly 1000.00 (ONE figure, not a sum) ${stubNote}`,
    byName.employer_contribution?.proposedValue === '1000.00', String(byName.employer_contribution?.proposedValue));
  snaps.push(['after compare/proposal', await snapshotAccount(account.id)]);

  const prGet = await app(user, `/api/financial-data-hub/retirement-statement/${documentId}/proposal`);
  check(`§119 Current-vs-Proposed comparison readable ${stubNote}`, prGet.status === 200 && (prGet.json?.data?.fields?.length ?? 0) > 0);
  snaps.push(['after reading the comparison', await snapshotAccount(account.id)]);

  // --- §129: canonical byte-unchanged through every pre-Apply step ---------
  for (const [label, snap] of snaps) {
    check(`§129 LIVE: canonical retirement_accounts row is byte-unchanged ${label}`, snap === before,
      snap === before ? '' : 'ROW CHANGED BEFORE APPLY');
  }
  const appsBefore = await countRows('fhip_import_applications', user.id);
  check('§129 LIVE: no canonical apply record exists before the user presses Apply', appsBefore === 0, `applications=${appsBefore}`);

  // --- USER APPLY ---------------------------------------------------------
  const applied = await post(user, documentId, '/apply', {
    proposal_id: proposalId, decision: 'update_existing',
    selected_fields: ['current_balance', 'employer_contribution'],
  });
  check(`§119 USER APPLY succeeded ${stubNote}`, applied.status === 200 && applied.json?.data?.outcome === 'applied',
    `status=${applied.status} ${applied.text.slice(0, 200)}`);

  const after = (await rest(`retirement_accounts?id=eq.${account.id}&select=*`)).json?.[0];
  check(`§119 canonical Retirement balance updated to the statement closing balance ${stubNote}`,
    money(after?.current_balance) === 105675, String(after?.current_balance));
  check(`§120 LIVE: canonical employer contribution is exactly 1000.00 — never 2000.00 ${stubNote}`,
    money(after?.employer_contribution) === 1000, String(after?.employer_contribution));
  check('§119 canonical row records the apply provenance',
    Boolean(after?.last_import_application_id) && Boolean(after?.last_imported_at),
    `${after?.last_import_application_id} / ${after?.last_imported_at}`);
  const appRow = (await rest(`fhip_import_applications?id=eq.${after?.last_import_application_id}&select=*`)).json?.[0];
  check('§119 the apply record names THIS retirement statement as its source',
    appRow?.source_retirement_statement_id === statementId, String(appRow?.source_retirement_statement_id));
  check('§119 the apply record targets THIS canonical account', appRow?.target_entity_id === account.id);
  state.A.applicationId = after?.last_import_application_id;
  state.A.appliedSnapshot = await snapshotAccount(account.id);
}

async function phaseEmployerContribution() {
  console.log('\n=== §120 — LIVE EMPLOYER CONTRIBUTION: $1,000 + $1,000 = $1,000 ===');
  const { user, account } = state.A;

  const payslip = await seedPayrollEvent(user, {
    employer: 'LiveCert Employer Pty Ltd',
    periodStart: '2026-03-01', periodEnd: '2026-03-14', paymentDate: '2026-03-15',
    employerSuper: '1000.0000',
  });
  state.A.payslipId = payslip.id;
  check('§120 payslip evidence seeded with employer super $1,000',
    money(payslip.employer_retirement_contribution) === 1000, String(payslip.employer_retirement_contribution));

  const csv = transactionCsv([
    '2026-03-20,Employer Superannuation Guarantee,1000.00,LiveCert Employer Pty Ltd',
  ]);
  const up = await uploadStatement(user, csv, {
    fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****1234',
    statement_date: '2026-03-31', statement_period_start: '2026-03-01', statement_period_end: '2026-03-31',
  });
  check('§120 fund contribution statement uploaded', up.status === 200 && up.json?.data?.pipeline_status === 'ok',
    `status=${up.status} ${up.text.slice(0, 200)}`);
  const doc2 = up.json?.data?.document_id;
  const stmt2 = up.json?.data?.statement_id;
  state.A.contributionDoc = doc2;
  state.A.contributionStatement = stmt2;
  check('§120 exactly one activity extracted from the statement', up.json?.data?.activities_extracted === 1,
    String(up.json?.data?.activities_extracted));

  const acts0 = (await rest(`fdh_retirement_statement_activities?statement_id=eq.${stmt2}&select=*`)).json ?? [];
  check('§120 the fund line was classified EMPLOYER_CONTRIBUTION', acts0[0]?.activity_type === 'EMPLOYER_CONTRIBUTION',
    String(acts0[0]?.activity_type));
  check('§120 the fund contribution amount is $1,000', money(acts0[0]?.amount) === 1000, String(acts0[0]?.amount));

  const am = await post(user, doc2, '/account-match', { action: 'auto' });
  check('§120 contribution statement matched the same canonical account', am.json?.data?.canonical_account_id === account.id,
    String(am.json?.data?.canonical_account_id));

  const ev = await post(user, doc2, '/evidence-matches', {});
  check('§120 payslip reconciliation matched EXACTLY ONE payslip to the fund contribution',
    ev.json?.data?.payslip?.matched === 1, JSON.stringify(ev.json?.data?.payslip));

  const acts = (await rest(`fdh_retirement_statement_activities?statement_id=eq.${stmt2}&select=*`)).json ?? [];
  check('§120 the activity is linked to the payslip as EVIDENCE OF THE SAME EVENT',
    acts[0]?.matched_payroll_event_id === payslip.id && acts[0]?.payslip_match_status === 'matched',
    `${acts[0]?.payslip_match_status} / ${acts[0]?.matched_payroll_event_id}`);
  check('§120 the match reports ZERO variance between payslip and fund figures',
    Number(acts[0]?.payslip_match_variance) === 0, String(acts[0]?.payslip_match_variance));

  // THE NEGATIVE CONTROL ITSELF.
  const payslipAfter = (await rest(`fdh_payroll_events?id=eq.${payslip.id}&select=*`)).json?.[0];
  check('§120 the payslip row was NOT modified by FDH-12',
    money(payslipAfter?.employer_retirement_contribution) === 1000, String(payslipAfter?.employer_retirement_contribution));
  const acct = (await rest(`retirement_accounts?id=eq.${account.id}&select=*`)).json?.[0];
  check('§120 canonical economic employer contribution is $1,000 — NOT $2,000',
    money(acct?.employer_contribution) === 1000, String(acct?.employer_contribution));
  const incomes = await countRows('income_sources', user.id);
  check('§120 no canonical income row was created by either evidence source', incomes === 0, `income_sources=${incomes}`);
  const acctCount = await countRows('retirement_accounts', user.id);
  check('§120 exactly ONE canonical retirement account exists (no second contribution posting)', acctCount === 1, `accounts=${acctCount}`);

  // Duplicate-claim structural control (spec 22): one payslip, at most one fund contribution.
  const forge = await rest('fdh_retirement_statement_activities', {
    method: 'POST',
    body: JSON.stringify({
      user_id: user.id, statement_id: stmt2, activity_type: 'EMPLOYER_CONTRIBUTION',
      amount: '1000.00', currency_code: 'AUD', activity_date: '2026-03-20',
      matched_payroll_event_id: payslip.id,
    }),
  });
  check('§120 a SECOND fund activity cannot claim the same payslip (live unique index)',
    forge.status >= 400 && forge.json?.code === '23505', `status=${forge.status} code=${forge.json?.code}`);
}

async function phaseInternalMovements() {
  console.log('\n=== §123 / §124 / §125 — LIVE FEE, INSURANCE, EARNINGS (isolated negative controls) ===');
  const { user, account } = state.A;
  const beforeAll = await snapshotAccount(account.id);

  // Each control is the SAME statement with exactly one term removed from the
  // closing balance. The resulting variance IS the economic effect of that
  // term, measured by the live engine on real Postgres.
  const cases = [
    ['§123', 'admin fee', summaryCsv({ closing: '105775.00' }), -100, 100],
    ['§124', 'insurance premium', summaryCsv({ closing: '105750.00' }), -75, 75],
    ['§125', 'investment earnings', summaryCsv({ closing: '100675.00' }), 5000, 5000],
  ];
  for (const [sec, term, csv, expectedVariance, magnitude] of cases) {
    const up = await uploadStatement(user, csv, {
      fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****1234',
      statement_date: '2026-06-30', statement_period_start: '2026-01-01', statement_period_end: '2026-06-30',
    });
    const sid = up.json?.data?.statement_id;
    const row = (await rest(`fdh_retirement_statements?id=eq.${sid}&select=*`)).json?.[0];
    check(`${sec} LIVE: removing the ${term} from the closing balance produces VARIANCE, not a silent pass`,
      row?.reconciliation_status === 'variance', String(row?.reconciliation_status));
    check(`${sec} LIVE: the ${term} is worth exactly $${magnitude} of retirement value`,
      money(row?.reconciliation_variance) === expectedVariance,
      `variance=${row?.reconciliation_variance} expected=${expectedVariance}`);
  }

  // No household cash duplication anywhere.
  const expenses = await countRows('expense_items', user.id);
  const txns = await countRows('fdh_transactions', user.id);
  const incomes = await countRows('income_sources', user.id);
  const assets = await countRows('assets', user.id);
  check('§123/§124 LIVE: internal fees and premiums created ZERO ordinary cash expense rows', expenses === 0, `expense_items=${expenses}`);
  check('§123/§124 LIVE: internal fees and premiums created ZERO bank transactions', txns === 0, `fdh_transactions=${txns}`);
  check('§125 LIVE: retained earnings created ZERO household bank income event', incomes === 0 && txns === 0, `income_sources=${incomes} fdh_transactions=${txns}`);
  check('§125 LIVE: retained earnings created no canonical asset row', assets === 0, `assets=${assets}`);
  check('§129 LIVE: uploading three further statements changed canonical Retirement not at all',
    (await snapshotAccount(account.id)) === beforeAll);
}

async function phasePersonalContribution() {
  console.log('\n=== §121 — LIVE PERSONAL CONTRIBUTION: bank -$5,000, super +$5,000, expense $0 ===');
  const user = await createUser('personal');
  const member = await seedMember(user, 'self');
  const account = await seedAccount(user, { name: 'LiveCert Horizon Super', balance: '50000.00', memberId: member.id });
  const bank = await seedBankAccount(user);
  const txn = await seedTransaction(user, bank.id, {
    date: '2026-02-10', amount: '5000.0000', direction: 'debit',
    description: 'LIVECERT HORIZON SUPER CONTRIBUTION', economicType: 'transfer',
  });
  state.personal = { user, account, txn };
  const txnBefore = JSON.stringify((await rest(`fdh_transactions?id=eq.${txn.id}&select=*`)).json?.[0]);
  const acctBefore = await snapshotAccount(account.id);

  const csv = transactionCsv(['2026-02-10,Personal Contribution,5000.00,'], { withEmployerColumn: true });
  const up = await uploadStatement(user, csv, {
    fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****5555',
    statement_date: '2026-02-28', statement_period_start: '2026-02-01', statement_period_end: '2026-02-28',
  });
  check('§121 statement uploaded', up.status === 200 && up.json?.data?.pipeline_status === 'ok', `${up.status} ${up.text.slice(0, 160)}`);
  const doc = up.json?.data?.document_id, sid = up.json?.data?.statement_id;
  const acts0 = (await rest(`fdh_retirement_statement_activities?statement_id=eq.${sid}&select=*`)).json ?? [];
  check('§121 the fund line was classified PERSONAL_CONTRIBUTION', acts0[0]?.activity_type === 'PERSONAL_CONTRIBUTION', String(acts0[0]?.activity_type));

  await post(user, doc, '/account-match', { action: 'auto' });
  const ev = await post(user, doc, '/evidence-matches', {});
  check('§121 the $5,000 bank debit was matched to the $5,000 fund credit as ONE event',
    ev.json?.data?.bank?.matched === 1, JSON.stringify(ev.json?.data?.bank));
  const acts = (await rest(`fdh_retirement_statement_activities?statement_id=eq.${sid}&select=*`)).json ?? [];
  check('§121 the activity links the real bank transaction', acts[0]?.linked_transaction_id === txn.id, String(acts[0]?.linked_transaction_id));

  const expenses = await countRows('expense_items', user.id);
  check('§121 LIVE: required ordinary expense is $0 — no expense row was created', expenses === 0, `expense_items=${expenses}`);
  const txnAfter = JSON.stringify((await rest(`fdh_transactions?id=eq.${txn.id}&select=*`)).json?.[0]);
  check('§121 LIVE: the bank transaction was NOT reclassified as household consumption', txnAfter === txnBefore);
  const txnCount = await countRows('fdh_transactions', user.id);
  check('§121 LIVE: no second bank transaction was created for the same movement', txnCount === 1, `fdh_transactions=${txnCount}`);
  check('§121 LIVE: canonical retirement is unchanged (no Apply was pressed)', (await snapshotAccount(account.id)) === acctBefore);
}

async function phaseRollover() {
  console.log('\n=== §122 — LIVE ROLLOVER: Fund A -$100,000, Fund B +$100,000 ===');
  const user = await createUser('rollover');
  const member = await seedMember(user, 'self');
  const fundA = await seedAccount(user, { name: 'LiveCert Alpha Super', balance: '100000.00', memberId: member.id });
  const fundB = await seedAccount(user, { name: 'LiveCert Beta Super', balance: '0.00', memberId: member.id });
  state.rollover = { user, fundA, fundB };

  const netWorthBefore = ((await rest(`retirement_accounts?user_id=eq.${user.id}&select=current_balance`)).json ?? [])
    .reduce((s, r) => s + Number(r.current_balance), 0);

  const upA = await uploadStatement(user, transactionCsv(['2026-04-01,Rollover to another fund,100000.00,']), {
    fund_name: 'LiveCert Alpha Super', masked_account_identifier: '****1111',
    statement_date: '2026-04-30', statement_period_start: '2026-04-01', statement_period_end: '2026-04-30',
  });
  const docA = upA.json?.data?.document_id, sidA = upA.json?.data?.statement_id;
  const upB = await uploadStatement(user, transactionCsv(['2026-04-01,Rollover received from LiveCert Alpha,100000.00,']), {
    fund_name: 'LiveCert Beta Super', masked_account_identifier: '****2222',
    statement_date: '2026-04-30', statement_period_start: '2026-04-01', statement_period_end: '2026-04-30',
  });
  const docB = upB.json?.data?.document_id, sidB = upB.json?.data?.statement_id;
  check('§122 both fund statements uploaded', Boolean(sidA && sidB), `${sidA} / ${sidB}`);

  const aA = (await rest(`fdh_retirement_statement_activities?statement_id=eq.${sidA}&select=*`)).json ?? [];
  const aB = (await rest(`fdh_retirement_statement_activities?statement_id=eq.${sidB}&select=*`)).json ?? [];
  check('§122 Fund A leg classified ROLLOVER_OUT', aA[0]?.activity_type === 'ROLLOVER_OUT', String(aA[0]?.activity_type));
  check('§122 Fund B leg classified ROLLOVER_IN', aB[0]?.activity_type === 'ROLLOVER_IN', String(aB[0]?.activity_type));

  const mA = await post(user, docA, '/account-match', { action: 'resolve', account_id: fundA.id });
  const mB = await post(user, docB, '/account-match', { action: 'resolve', account_id: fundB.id });
  check('§122 each statement matched its own fund', mA.json?.data?.canonical_account_id === fundA.id && mB.json?.data?.canonical_account_id === fundB.id);

  await post(user, docA, '/evidence-matches', {});
  const evB = await post(user, docB, '/evidence-matches', {});
  check('§122 the two legs were paired as ONE movement', evB.json?.data?.rollover?.matched === 1, JSON.stringify(evB.json?.data?.rollover));
  const aB2 = (await rest(`fdh_retirement_statement_activities?statement_id=eq.${sidB}&select=*`)).json ?? [];
  check('§122 the IN leg names the OUT leg as its counterpart', aB2[0]?.rollover_counterpart_activity_id === aA[0]?.id,
    `${aB2[0]?.rollover_counterpart_activity_id}`);

  const incomes = await countRows('income_sources', user.id);
  const expenses = await countRows('expense_items', user.id);
  const txns = await countRows('fdh_transactions', user.id);
  const netWorthAfter = ((await rest(`retirement_accounts?user_id=eq.${user.id}&select=current_balance`)).json ?? [])
    .reduce((s, r) => s + Number(r.current_balance), 0);
  check('§122 LIVE: required income $0', incomes === 0, `income_sources=${incomes}`);
  check('§122 LIVE: required expense $0', expenses === 0 && txns === 0, `expense_items=${expenses} fdh_transactions=${txns}`);
  check('§122 LIVE: required net-worth increase $0', netWorthAfter === netWorthBefore, `before=${netWorthBefore} after=${netWorthAfter}`);
  const acctCount = await countRows('retirement_accounts', user.id);
  check('§122 LIVE: no third retirement account was invented for the movement', acctCount === 2, `accounts=${acctCount}`);
}

async function phaseWithdrawal() {
  console.log('\n=== §126 — LIVE WITHDRAWAL: super -$20,000, bank +$20,000 ===');
  const user = await createUser('withdrawal');
  const member = await seedMember(user, 'self');
  const account = await seedAccount(user, { name: 'LiveCert Horizon Super', balance: '200000.00', memberId: member.id });
  const bank = await seedBankAccount(user);
  const txn = await seedTransaction(user, bank.id, {
    date: '2026-05-05', amount: '20000.0000', direction: 'credit',
    description: 'LIVECERT HORIZON SUPER BENEFIT PAYMENT', economicType: 'transfer',
  });
  state.withdrawal = { user, account, txn };
  const txnBefore = JSON.stringify((await rest(`fdh_transactions?id=eq.${txn.id}&select=*`)).json?.[0]);

  const up = await uploadStatement(user, transactionCsv(['2026-05-05,Lump sum withdrawal,20000.00,']), {
    fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****7777',
    statement_date: '2026-05-31', statement_period_start: '2026-05-01', statement_period_end: '2026-05-31',
  });
  const doc = up.json?.data?.document_id, sid = up.json?.data?.statement_id;
  const acts0 = (await rest(`fdh_retirement_statement_activities?statement_id=eq.${sid}&select=*`)).json ?? [];
  check('§126 the fund line was classified WITHDRAWAL', acts0[0]?.activity_type === 'WITHDRAWAL', String(acts0[0]?.activity_type));

  await post(user, doc, '/account-match', { action: 'auto' });
  const ev = await post(user, doc, '/evidence-matches', {});
  check('§126 LIVE: the super debit and the bank credit were matched as a SINGLE economic event',
    ev.json?.data?.bank?.matched === 1, JSON.stringify(ev.json?.data?.bank));
  const acts = (await rest(`fdh_retirement_statement_activities?statement_id=eq.${sid}&select=*`)).json ?? [];
  check('§126 exactly one activity, linked to exactly one bank transaction',
    acts.length === 1 && acts[0]?.linked_transaction_id === txn.id, `${acts.length} / ${acts[0]?.linked_transaction_id}`);

  const incomes = await countRows('income_sources', user.id);
  check('§126 LIVE: the withdrawal was NOT automatically treated as ordinary taxable income', incomes === 0, `income_sources=${incomes}`);
  const txnAfter = JSON.stringify((await rest(`fdh_transactions?id=eq.${txn.id}&select=*`)).json?.[0]);
  check('§126 LIVE: the bank credit was NOT reclassified to income by the match', txnAfter === txnBefore);
  const txnCount = await countRows('fdh_transactions', user.id);
  check('§126 LIVE: no second cash record was created (one event, not two)', txnCount === 1, `fdh_transactions=${txnCount}`);
}

async function phaseReconciliationNegative() {
  console.log('\n=== §128 — LIVE $0.01 NEGATIVE CONTROL ===');
  const user = await createUser('recon');
  const member = await seedMember(user, 'self');
  await seedAccount(user, { name: 'LiveCert Horizon Super', balance: '100000.00', memberId: member.id });
  state.recon = { user };

  const good = await uploadStatement(user, summaryCsv(), {
    fund_name: 'LiveCert Horizon Super', statement_date: '2026-06-30',
    statement_period_start: '2026-01-01', statement_period_end: '2026-06-30',
  });
  const goodRow = (await rest(`fdh_retirement_statements?id=eq.${good.json?.data?.statement_id}&select=*`)).json?.[0];
  check('§127 LIVE (independent second instance): the balancing statement is RECONCILED',
    goodRow?.reconciliation_status === 'reconciled' && Number(goodRow?.reconciliation_variance) === 0,
    `${goodRow?.reconciliation_status} / ${goodRow?.reconciliation_variance}`);

  const bad = await uploadStatement(user, summaryCsv({ closing: '105675.01' }), {
    fund_name: 'LiveCert Horizon Super', statement_date: '2026-12-31',
    statement_period_start: '2026-07-01', statement_period_end: '2026-12-31',
  });
  const badRow = (await rest(`fdh_retirement_statements?id=eq.${bad.json?.data?.statement_id}&select=*`)).json?.[0];
  check('§128 LIVE: a closing balance off by exactly $0.01 reports VARIANCE, not RECONCILED',
    badRow?.reconciliation_status === 'variance', String(badRow?.reconciliation_status));
  check('§128 LIVE: the reported variance is exactly one cent — no float absorption on real Postgres',
    money(badRow?.reconciliation_variance) === -0.01, String(badRow?.reconciliation_variance));
}

async function phaseDuplicateAndOverlap() {
  console.log('\n=== §130 / §131 — LIVE DUPLICATE AND OVERLAPPING STATEMENTS ===');
  const user = await createUser('dedup');
  const member = await seedMember(user, 'self');
  const account = await seedAccount(user, { name: 'LiveCert Horizon Super', balance: '100000.00', memberId: member.id });
  state.dedup = { user, account };

  // --- §130a: the same SUMMARY statement, applied, then uploaded again -----
  const csv = summaryCsv();
  const meta = {
    fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****1234',
    statement_date: '2026-06-30', statement_period_start: '2026-01-01', statement_period_end: '2026-06-30',
  };
  const up1 = await uploadStatement(user, csv, meta);
  const doc1 = up1.json?.data?.document_id, sid1 = up1.json?.data?.statement_id;
  await post(user, doc1, '/account-match', { action: 'auto' });
  await post(user, doc1, '/evidence-matches', {});
  const appr130 = await approveEvidence(user, doc1, sid1, '§130');
  const note130 = appr130.liveApproval ? '' : STUB;
  const pr1 = await post(user, doc1, '/proposal', {});
  const apply1 = await post(user, doc1, '/apply', {
    proposal_id: pr1.json?.data?.proposal_id, decision: 'update_existing',
    selected_fields: ['current_balance', 'employer_contribution'],
  });
  check(`§130 first upload applied to canonical Retirement ${note130}`, apply1.json?.data?.outcome === 'applied', apply1.text.slice(0, 160));
  const balAfter1 = String((await rest(`retirement_accounts?id=eq.${account.id}&select=current_balance`)).json?.[0]?.current_balance);

  const up2 = await uploadStatement(user, csv, meta);
  check('§130 LIVE: the identical re-upload is recognised as a duplicate document',
    up2.json?.data?.pipeline_status === 'duplicate_statement', String(up2.json?.data?.pipeline_status));
  check('§130 LIVE: the duplicate resolves to the SAME statement, not a new one',
    up2.json?.data?.statement_id === sid1, `${up2.json?.data?.statement_id} vs ${sid1}`);

  const stmtCount = ((await rest(`fdh_retirement_statements?user_id=eq.${user.id}&select=id`)).json ?? []).length;
  const propCount = ((await rest(`fhip_import_proposals?user_id=eq.${user.id}&select=id`)).json ?? []).length;
  const appCount = ((await rest(`fhip_import_applications?user_id=eq.${user.id}&select=id`)).json ?? []).length;
  check(`§130 LIVE: duplicate proposals 0 (proposals total = 1) ${note130}`, propCount === 1, `proposals=${propCount}`);
  check(`§130 LIVE: duplicate canonical contributions 0 (applications total = 1) ${note130}`, appCount === 1, `applications=${appCount}`);
  check('§130 LIVE: only one retirement statement exists', stmtCount === 1, `statements=${stmtCount}`);
  const balAfter2 = String((await rest(`retirement_accounts?id=eq.${account.id}&select=current_balance`)).json?.[0]?.current_balance);
  check(`§130 LIVE: the canonical balance was not applied twice ${note130}`, balAfter2 === balAfter1, `${balAfter1} -> ${balAfter2}`);

  // --- §130b: the same TRANSACTION statement twice -> duplicate activities 0
  const tcsv = transactionCsv([
    '2026-09-20,Employer Superannuation Guarantee,1000.00,LiveCert Employer Pty Ltd',
    '2026-09-21,Administration Fee,20.00,',
    '2026-09-22,Investment Earnings,300.00,',
  ]);
  const tmeta = { fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****1234', statement_date: '2026-09-30', statement_period_start: '2026-09-01', statement_period_end: '2026-09-30' };
  const t1 = await uploadStatement(user, tcsv, tmeta);
  const tdoc1 = t1.json?.data?.document_id, tsid1 = t1.json?.data?.statement_id;
  await post(user, tdoc1, '/account-match', { action: 'auto' });
  const t2 = await uploadStatement(user, tcsv, tmeta);
  check('§130 LIVE: an identical activity statement re-upload is a duplicate document',
    t2.json?.data?.pipeline_status === 'duplicate_statement', String(t2.json?.data?.pipeline_status));
  const tActs = (await rest(`fdh_retirement_statement_activities?user_id=eq.${user.id}&statement_id=eq.${tsid1}&select=*`)).json ?? [];
  check('§130 LIVE: duplicate activities 0 — 3 lines uploaded twice produced 3 activity rows', tActs.length === 3, `activities=${tActs.length}`);
  state.dedup.tsid1 = tsid1;

  // --- §131: OVERLAPPING PERIOD statements (different bytes) ---------------
  const overlapUser = await createUser('overlap');
  const om = await seedMember(overlapUser, 'self');
  const oa = await seedAccount(overlapUser, { name: 'LiveCert Horizon Super', balance: '100000.00', memberId: om.id });
  state.overlap = { user: overlapUser, account: oa };

  const quarter = transactionCsv([
    '2026-07-15,Employer Superannuation Guarantee,1000.00,LiveCert Employer Pty Ltd',
  ]);
  const annual = transactionCsv([
    '2026-07-15,Employer Superannuation Guarantee,1000.00,LiveCert Employer Pty Ltd',
    '2026-10-15,Employer Superannuation Guarantee,1100.00,LiveCert Employer Pty Ltd',
  ]);
  const uq = await uploadStatement(overlapUser, quarter, {
    fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****1234',
    statement_date: '2026-09-30', statement_period_start: '2026-07-01', statement_period_end: '2026-09-30',
  });
  const uqDoc = uq.json?.data?.document_id, uqSid = uq.json?.data?.statement_id;
  await post(overlapUser, uqDoc, '/account-match', { action: 'auto' });

  const ua = await uploadStatement(overlapUser, annual, {
    fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****1234',
    statement_date: '2026-12-31', statement_period_start: '2026-07-01', statement_period_end: '2026-12-31',
  });
  const uaDoc = ua.json?.data?.document_id, uaSid = ua.json?.data?.statement_id;
  check('§131 the overlapping annual statement is NOT a byte duplicate (different file)',
    ua.json?.data?.pipeline_status === 'ok' && uaSid !== uqSid, String(ua.json?.data?.pipeline_status));
  await post(overlapUser, uaDoc, '/account-match', { action: 'auto' });

  const all = (await rest(`fdh_retirement_statement_activities?user_id=eq.${overlapUser.id}&select=*&order=activity_date`)).json ?? [];
  const economic = all.filter((a) => a.duplicate_of_activity_id === null);
  const flagged = all.filter((a) => a.duplicate_of_activity_id !== null);
  const fingerprints = economic.map((a) => a.activity_fingerprint).filter(Boolean);
  const dupFingerprints = fingerprints.length - new Set(fingerprints).size;
  check('§131 LIVE: overlap activity duplicates 0 — no two counted activities share an economic identity',
    dupFingerprints === 0, `counted=${economic.length} duplicate_fingerprints=${dupFingerprints}`);
  check('§131 LIVE: the repeated July line is flagged as a duplicate of the original, not counted twice',
    flagged.length === 1 && money(flagged[0].amount) === 1000,
    `flagged=${flagged.length} rows=${all.length} amounts=${all.map((a) => a.amount).join('|')}`);
  check('§131 LIVE: exactly two distinct economic contributions survive across the overlapping statements',
    economic.length === 2, `counted=${economic.length}`);
}

async function phaseWrongAccount() {
  console.log('\n=== §132 — LIVE WRONG ACCOUNT: Self ****1234 vs Spouse ****9876 ===');
  const user = await createUser('wrongacct');
  const self = await seedMember(user, 'self');
  const spouse = await seedMember(user, 'spouse');
  const selfAcct = await seedAccount(user, { name: 'LiveCert Horizon Super', balance: '100000.00', memberId: self.id, owner: 'self' });
  const spouseAcct = await seedAccount(user, { name: 'LiveCert Horizon Super', balance: '100100.00', memberId: spouse.id, owner: 'spouse' });
  state.wrong = { user, selfAcct, spouseAcct };

  // Seed the identifier history the matcher uses: each account has been seen
  // with its own masked member number.
  const seedIdent = async (acctId, memberId, masked, tag) => {
    const up = await uploadStatement(user, transactionCsv([`2026-01-10,Employer Superannuation Guarantee,900.00,LiveCert ${tag} Employer`]), {
      fund_name: 'LiveCert Horizon Super', masked_account_identifier: masked,
      statement_date: '2026-01-31', statement_period_start: '2026-01-01', statement_period_end: '2026-01-31',
    });
    const doc = up.json?.data?.document_id;
    const r = await post(user, doc, '/account-match', { action: 'resolve', account_id: acctId, member_id: memberId });
    return r.json?.data?.canonical_account_id;
  };
  const r1 = await seedIdent(selfAcct.id, self.id, '****1234', 'A');
  const r2 = await seedIdent(spouseAcct.id, spouse.id, '****9876', 'B');
  check('§132 identifier history seeded against each account', r1 === selfAcct.id && r2 === spouseAcct.id, `${r1} / ${r2}`);

  const spouseBefore = await snapshotAccount(spouseAcct.id);
  const selfBefore = await snapshotAccount(selfAcct.id);

  // A NEW statement for Self's ****1234.
  const up = await uploadStatement(user, summaryCsv(), {
    fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****1234',
    statement_date: '2026-06-30', statement_period_start: '2026-02-01', statement_period_end: '2026-06-30',
  });
  const doc = up.json?.data?.document_id;
  const am = await post(user, doc, '/account-match', { action: 'auto' });
  check('§132 LIVE: the ****1234 statement resolved to SELF\'s account', am.json?.data?.canonical_account_id === selfAcct.id,
    `resolved=${am.json?.data?.canonical_account_id} self=${selfAcct.id} spouse=${spouseAcct.id}`);
  check('§132 LIVE: it did NOT resolve to the spouse\'s same-fund account', am.json?.data?.canonical_account_id !== spouseAcct.id);

  await post(user, doc, '/evidence-matches', {});
  const sid132 = ((await rest(`fdh_retirement_statements?statement_upload_id=eq.${doc}&select=id`)).json ?? [])[0]?.id;
  const appr132 = await approveEvidence(user, doc, sid132, '§132');
  const note132 = appr132.liveApproval ? '' : STUB;
  const pr = await post(user, doc, '/proposal', {});
  const ap = await post(user, doc, '/apply', {
    proposal_id: pr.json?.data?.proposal_id, decision: 'update_existing',
    selected_fields: ['current_balance'],
  });
  check(`§132 the statement applied to the account it matched ${note132}`, ap.json?.data?.outcome === 'applied', ap.text.slice(0, 160));
  check(`§132 LIVE: the SPOUSE's account is byte-unchanged by the SELF statement ${note132}`,
    (await snapshotAccount(spouseAcct.id)) === spouseBefore);
  const selfAfter = (await rest(`retirement_accounts?id=eq.${selfAcct.id}&select=current_balance`)).json?.[0];
  check(`§132 LIVE: only SELF's balance moved ${note132}`, money(selfAfter?.current_balance) === 105675 && (await snapshotAccount(selfAcct.id)) !== selfBefore,
    String(selfAfter?.current_balance));
  const spouseNow = (await rest(`retirement_accounts?id=eq.${spouseAcct.id}&select=current_balance`)).json?.[0];
  check(`§132 LIVE: the spouse balance is still exactly its seeded value ${note132}`, money(spouseNow?.current_balance) === 100100, String(spouseNow?.current_balance));

  // Symmetric control: the ****9876 statement must reach the SPOUSE, never Self.
  const up2 = await uploadStatement(user, summaryCsv({ closing: '105675.00', opening: '100100.00', employer: '1000.00', earnings: '5000.00', fee: '100.00', insurance: '75.00', tax: '250.00' }), {
    fund_name: 'LiveCert Horizon Super', masked_account_identifier: '****9876',
    statement_date: '2026-06-30', statement_period_start: '2026-02-01', statement_period_end: '2026-06-30',
  });
  const am2 = await post(user, up2.json?.data?.document_id, '/account-match', { action: 'auto' });
  check('§132 LIVE (symmetric control): the ****9876 statement resolved to the SPOUSE\'s account',
    am2.json?.data?.canonical_account_id === spouseAcct.id, String(am2.json?.data?.canonical_account_id));
}

async function phaseCrossTenant() {
  console.log('\n=== §133 — LIVE CROSS-TENANT: real Tenant A vs real Tenant B ===');
  const A = state.A;
  const B = await createUser('tenantB');
  state.B = { user: B };
  const bMember = await seedMember(B, 'self');
  const bAccount = await seedAccount(B, { name: 'Tenant B Super', balance: '1.00', memberId: bMember.id });
  const bStmt = (await rest('fdh_retirement_statements', {
    method: 'POST',
    body: JSON.stringify({
      user_id: B.id, statement_type: 'super_member_statement', retirement_jurisdiction: 'AU',
      account_type: 'industry_super', currency_code: 'AUD', extraction_status: 'extracted',
      canonical_account_id: bAccount.id,
    }),
  })).json?.[0];
  const aBank = await seedBankAccount(A.user);
  const aTxn = await seedTransaction(A.user, aBank.id, {
    date: '2026-03-20', amount: '1000.0000', direction: 'debit',
    description: 'LIVECERT HORIZON SUPER', economicType: 'transfer',
  });
  state.A.bankTxnId = aTxn.id;

  // READS
  const r1 = await userRest(B, `fdh_retirement_statements?select=id&id=eq.${A.statementId}`);
  check("§133 LIVE: A's statement visible to B — 0 rows", Array.isArray(r1.json) && r1.json.length === 0, `rows=${r1.json?.length}`);
  const r1b = await userRest(B, `fdh_retirement_statements?select=id`);
  check("§133 LIVE positive control: B CAN see B's own statement (the empty result above is real RLS, not a broken query)",
    Array.isArray(r1b.json) && r1b.json.length === 1 && r1b.json[0].id === bStmt.id, `rows=${r1b.json?.length}`);
  const r2 = await userRest(B, `fdh_retirement_statement_activities?select=id&statement_id=eq.${A.contributionStatement}`);
  check("§133 LIVE: A's statement activities visible to B — 0 rows", Array.isArray(r2.json) && r2.json.length === 0, `rows=${r2.json?.length}`);
  const r3 = await userRest(B, `fdh_retirement_statement_positions?select=id`);
  check("§133 LIVE: A's statement positions visible to B — 0 rows", Array.isArray(r3.json) && r3.json.length === 0, `rows=${r3.json?.length}`);

  // TARGETING
  const t1 = await userRest(B, 'fdh_retirement_statements', {
    method: 'POST',
    body: JSON.stringify({
      user_id: B.id, statement_type: 'super_member_statement', retirement_jurisdiction: 'AU',
      account_type: 'industry_super', currency_code: 'AUD', canonical_account_id: A.account.id,
    }),
  });
  check("§133 LIVE: A's retirement account targetable by B — NO", t1.status >= 400 && /cross-tenant|different user/i.test(t1.text),
    `status=${t1.status} ${t1.text.slice(0, 110)}`);
  const t1m = await userRest(B, 'fdh_retirement_statements', {
    method: 'POST',
    body: JSON.stringify({
      user_id: B.id, statement_type: 'super_member_statement', retirement_jurisdiction: 'AU',
      account_type: 'industry_super', currency_code: 'AUD', retirement_member_id: A.member.id,
    }),
  });
  check("§133 LIVE: A's household member targetable by B — NO", t1m.status >= 400 && /cross-tenant|different user/i.test(t1m.text),
    `status=${t1m.status} ${t1m.text.slice(0, 110)}`);
  const t2 = await userRest(B, 'fdh_retirement_statement_activities', {
    method: 'POST',
    body: JSON.stringify({
      user_id: B.id, statement_id: bStmt.id, activity_type: 'EMPLOYER_CONTRIBUTION',
      amount: '1000.00', currency_code: 'AUD', activity_date: '2026-03-20',
      matched_payroll_event_id: A.payslipId,
    }),
  });
  check("§133 LIVE: A's payslip matchable by B — NO", t2.status >= 400 && /cross-tenant|different user/i.test(t2.text),
    `status=${t2.status} ${t2.text.slice(0, 110)}`);
  const t3 = await userRest(B, 'fdh_retirement_statement_activities', {
    method: 'POST',
    body: JSON.stringify({
      user_id: B.id, statement_id: bStmt.id, activity_type: 'PERSONAL_CONTRIBUTION',
      amount: '1000.00', currency_code: 'AUD', activity_date: '2026-03-20',
      linked_transaction_id: aTxn.id,
    }),
  });
  check("§133 LIVE: A's bank transaction matchable by B — NO", t3.status >= 400 && /cross-tenant|different user/i.test(t3.text),
    `status=${t3.status} ${t3.text.slice(0, 110)}`);
  const t3p = await userRest(B, 'fdh_retirement_statement_activities', {
    method: 'POST',
    body: JSON.stringify({
      user_id: B.id, statement_id: bStmt.id, activity_type: 'FEE',
      amount: '1.00', currency_code: 'AUD', activity_date: '2026-03-20',
    }),
  });
  check('§133 LIVE positive control: B CAN write an activity on B\'s own statement (the refusals above are cross-tenant, not a blanket block)',
    t3p.status === 201, `status=${t3p.status} ${t3p.text.slice(0, 110)}`);

  // APP-LEVEL and RPC-LEVEL
  const appAccess = await app(B, `/api/financial-data-hub/retirement-statement/${A.documentId}/proposal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check("§133 LIVE: B cannot drive A's document through the app's own API", appAccess.status >= 400, `status=${appAccess.status}`);
  const rpcApprove = await userRest(B, 'rpc/fdh12_approve_retirement_statement', {
    method: 'POST', body: JSON.stringify({ p_statement_id: A.statementId }),
  });
  check("§133 LIVE: B cannot approve A's statement via the RPC", rpcApprove.json?.ok === false && rpcApprove.json?.code === 'NOT_FOUND',
    JSON.stringify(rpcApprove.json).slice(0, 120));
  const rpcApply = await userRest(B, 'rpc/fdh12_apply_retirement_proposal', {
    method: 'POST', body: JSON.stringify({ p_proposal_id: A.proposalId, p_decision: 'update_existing', p_selected_fields: ['current_balance'] }),
  });
  check("§133 LIVE: B cannot apply A's proposal via the RPC", rpcApply.json?.ok === false && rpcApply.json?.code === 'PROPOSAL_NOT_FOUND',
    JSON.stringify(rpcApply.json).slice(0, 120));
  check("§133 LIVE: A's canonical account is untouched by every Tenant B attempt",
    (await snapshotAccount(A.account.id)) === A.appliedSnapshot);
}

async function phaseSameTenantForgery() {
  console.log('\n=== §134 — LIVE SAME-TENANT FORGERY (row owner, direct REST) ===');
  const { user, statementId, account, contributionStatement } = state.A;
  const activity = ((await rest(`fdh_retirement_statement_activities?statement_id=eq.${contributionStatement}&select=*`)).json ?? [])[0];

  const forge = async (label, table, id, body) => {
    const r = await userRest(user, `${table}?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    const blocked = r.status >= 400 && /system-authoritative/i.test(r.text);
    check(`§134 LIVE: ${label} — BLOCKED`, blocked, `status=${r.status} ${r.text.slice(0, 110)}`);
  };
  // EVERY value below is DIFFERENT from what the row currently holds. Forging a
  // column to the value it already has is a no-op that `is distinct from`
  // correctly ignores, and would make each check vacuous.
  const live = (await rest(`fdh_retirement_statements?id=eq.${statementId}&select=*`)).json?.[0];
  check('§134 setup: the statement really is in the authoritative state being attacked',
    live?.reconciliation_status === 'reconciled' && live?.account_match_status === 'matched'
    && live?.approval_status === 'approved' && live?.extraction_status === 'extracted'
    && live?.canonical_account_id === account.id,
    `${live?.reconciliation_status}/${live?.account_match_status}/${live?.approval_status}/${live?.extraction_status}`);
  await forge('forge reconciliation_status reconciled -> variance', 'fdh_retirement_statements', statementId, { reconciliation_status: 'variance' });
  await forge('forge account_match_status matched -> no_match', 'fdh_retirement_statements', statementId, { account_match_status: 'no_match' });
  await forge('forge approval_status approved -> pending', 'fdh_retirement_statements', statementId, { approval_status: 'pending' });
  await forge('forge canonical_account_id -> null (retarget the apply)', 'fdh_retirement_statements', statementId, { canonical_account_id: null });
  await forge('forge closing_balance -> 999999.00', 'fdh_retirement_statements', statementId, { closing_balance: '999999.00' });
  await forge('forge employer_contributions -> 999999.00', 'fdh_retirement_statements', statementId, { employer_contributions: '999999.00' });
  await forge('forge extraction_status extracted -> manual_mapping_required', 'fdh_retirement_statements', statementId, { extraction_status: 'manual_mapping_required' });
  await forge('forge smsf_classification not_smsf -> routed_to_smsf', 'fdh_retirement_statements', statementId, { smsf_classification: 'routed_to_smsf' });
  await forge('forge activity payslip_match_status matched -> no_match', 'fdh_retirement_statement_activities', activity.id, { payslip_match_status: 'no_match' });
  await forge('forge activity matched_payroll_event_id -> null', 'fdh_retirement_statement_activities', activity.id, { matched_payroll_event_id: null });
  await forge('forge activity amount 1000 -> 999999.00', 'fdh_retirement_statement_activities', activity.id, { amount: '999999.00' });

  // Canonical application/proposal status.
  const appId = state.A.applicationId;
  const pApp = await userRest(user, `fhip_import_applications?id=eq.${appId}`, { method: 'PATCH', body: JSON.stringify({ apply_mode: 'add_new' }) });
  const appRow = (await rest(`fhip_import_applications?id=eq.${appId}&select=apply_mode`)).json?.[0];
  check('§134 LIVE: canonical apply record cannot be rewritten by its own owner',
    appRow?.apply_mode === 'update_existing', `status=${pApp.status} apply_mode=${appRow?.apply_mode}`);
  const pProp = await userRest(user, `fhip_import_proposals?id=eq.${state.A.proposalId}`, { method: 'PATCH', body: JSON.stringify({ status: 'ready' }) });
  const propRow = (await rest(`fhip_import_proposals?id=eq.${state.A.proposalId}&select=status`)).json?.[0];
  check('§134 LIVE: an APPLIED proposal cannot be reset to ready and re-applied',
    propRow?.status === 'applied', `status=${pProp.status} proposal_status=${propRow?.status}`);

  // --- Canonical retirement APPLY PROVENANCE (spec 96) --------------------
  // DEFECT FDH12-LD-2, found by this run: 0112 added
  // retirement_accounts.source_type = 'retirement_statement_import',
  // last_import_application_id and last_imported_at WITHOUT either of the two
  // guards income_sources (0091) and liabilities (0096) pair with the very
  // same columns. Fixed forward in migration 0114, NOT applied to DEV, so
  // these still fail live and are reported as failures rather than excused.
  const DEFECT2 = '[DEFECT FDH12-LD-2: retirement_accounts provenance is unguarded; fixed forward in migration 0114, which is NOT applied to DEV]';
  const pProv = await userRest(user, `retirement_accounts?id=eq.${account.id}`, {
    method: 'PATCH', body: JSON.stringify({ last_import_application_id: null, last_imported_at: null }),
  });
  const provRow = (await rest(`retirement_accounts?id=eq.${account.id}&select=last_import_application_id`)).json?.[0];
  check('§134 LIVE: canonical apply provenance cannot be ERASED by direct REST',
    provRow?.last_import_application_id === appId,
    `status=${pProv.status} -> ${provRow?.last_import_application_id} ${provRow?.last_import_application_id === appId ? '' : DEFECT2}`);
  const pType = await userRest(user, `retirement_accounts?id=eq.${account.id}`, {
    method: 'PATCH', body: JSON.stringify({ source_type: 'manual' }),
  });
  const typeRow = (await rest(`retirement_accounts?id=eq.${account.id}&select=source_type`)).json?.[0];
  check('§134 LIVE: canonical source_type cannot be rewritten by direct REST',
    typeRow?.source_type === 'retirement_statement_import',
    `status=${pType.status} -> ${typeRow?.source_type} ${typeRow?.source_type === 'retirement_statement_import' ? '' : DEFECT2}`);
  // POSITIVE CONTROL for the same finding: the identical move on the FDH-9
  // canonical register IS refused, which is what proves this is one table left
  // out of a working pattern rather than a capability nobody has.
  const incProbe = await rest('income_sources', {
    method: 'POST',
    body: JSON.stringify({ user_id: user.id, source_name: 'LiveCert provenance control', income_type: 'salary', amount: '1.00', frequency: 'monthly', currency_code: 'AUD', is_active: true }),
  });
  const incId = incProbe.json?.[0]?.id;
  const pInc = await userRest(user, `income_sources?id=eq.${incId}`, {
    method: 'PATCH', body: JSON.stringify({ last_import_application_id: appId }),
  });
  check('§134 POSITIVE CONTROL: the SAME forgery on income_sources IS refused (FDH-9 guard, migration 0091)',
    pInc.status >= 400 && /import-bridge provenance/.test(pInc.text), `status=${pInc.status} ${pInc.text.slice(0, 110)}`);
  await rest(`income_sources?id=eq.${incId}`, { method: 'DELETE' });
  // Restore the real provenance so the architecture phase reads true state.
  await rest(`retirement_accounts?id=eq.${account.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_import_application_id: appId, last_imported_at: new Date().toISOString(), source_type: 'retirement_statement_import' }),
  });

  // POSITIVE CONTROLS — the genuinely user-editable surface still works.
  const ok = async (label, body) => {
    const r = await userRest(user, `fdh_retirement_statements?id=eq.${statementId}`, { method: 'PATCH', body: JSON.stringify(body) });
    check(`§134 POSITIVE CONTROL: ${label} — still editable by the owner`, r.status < 300 && Array.isArray(r.json) && r.json.length === 1,
      `status=${r.status} ${r.text.slice(0, 110)}`);
  };
  await ok('fund_name', { fund_name: 'LiveCert Horizon Super (renamed by user)' });
  await ok('nickname', { nickname: 'My super' });
  await ok('masked_account_identifier', { masked_account_identifier: '****4321' });
  await ok('statement_date', { statement_date: '2026-06-29' });
  await ok('statement_start_date / statement_end_date', { statement_start_date: '2026-01-02', statement_end_date: '2026-06-29' });
  await ok('review_status', { review_status: 'resolved' });
  await ok('source_provenance', { source_provenance: 'user annotated' });
  await ok('supersedes_statement_id', { supersedes_statement_id: state.A.contributionStatement });
}

async function phaseSmsf() {
  console.log('\n=== §137 — LIVE SMSF ROUTING ===');
  const user = await createUser('smsf');
  const member = await seedMember(user, 'self');
  const ordinary = await seedAccount(user, { name: 'LiveCert Horizon Super', balance: '100000.00', memberId: member.id });
  const smsfAcct = await seedAccount(user, { name: 'LiveCert Family SMSF', balance: '500000.00', memberId: member.id, masterItemKey: 'smsf' });
  state.smsf = { user, ordinary, smsfAcct };
  const acctCountBefore = await countRows('retirement_accounts', user.id);
  const smsfFundsBefore = await countRows('smsf_funds', user.id);

  const up = await uploadStatement(user, summaryCsv(), {
    fund_name: 'LiveCert Family Self-Managed Super Fund', masked_account_identifier: '****3333',
    statement_date: '2026-06-30', statement_period_start: '2026-01-01', statement_period_end: '2026-06-30',
  });
  const doc = up.json?.data?.document_id, sid = up.json?.data?.statement_id;
  check('§137 LIVE: an SMSF-looking statement is ROUTED, not imported as ordinary super',
    up.json?.data?.pipeline_status === 'routed_to_smsf', String(up.json?.data?.pipeline_status));
  const row = (await rest(`fdh_retirement_statements?id=eq.${sid}&select=*`)).json?.[0];
  check('§137 LIVE: smsf_classification = routed_to_smsf', row?.smsf_classification === 'routed_to_smsf', String(row?.smsf_classification));
  check('§137 LIVE: routing evidence is recorded, not merely asserted', Boolean(row?.smsf_evidence), JSON.stringify(row?.smsf_evidence ?? null).slice(0, 120));

  const am = await post(user, doc, '/account-match', { action: 'auto' });
  check('§137 LIVE: ordinary super import — NO (account matching refuses)', am.status === 409, `status=${am.status} ${am.text.slice(0, 110)}`);
  const ap = await post(user, doc, '/approve', {});
  check('§137 LIVE: SMSF evidence cannot be approved', ap.status === 409, `status=${ap.status} ${ap.text.slice(0, 110)}`);
  const pr = await post(user, doc, '/proposal', {});
  check('§137 LIVE: SMSF evidence can never become a proposal', pr.status === 409, `status=${pr.status} ${pr.text.slice(0, 110)}`);
  check('§137 LIVE: SMSF route/review PASS — the statement is retained for the SMSF section', Boolean(sid) && row?.review_status === 'pending',
    `review_status=${row?.review_status}`);

  const acctCountAfter = await countRows('retirement_accounts', user.id);
  const smsfFundsAfter = await countRows('smsf_funds', user.id);
  check('§137 LIVE: no duplicate SMSF canonical account was created', acctCountAfter === acctCountBefore, `${acctCountBefore} -> ${acctCountAfter}`);
  check('§137 LIVE: no smsf_funds row was created by FDH-12', smsfFundsAfter === smsfFundsBefore && smsfFundsAfter === 0, `${smsfFundsBefore} -> ${smsfFundsAfter}`);
  const props = await countRows('fhip_import_proposals', user.id);
  const apps = await countRows('fhip_import_applications', user.id);
  check('§137 LIVE: zero proposals and zero canonical applies from SMSF evidence', props === 0 && apps === 0, `proposals=${props} applications=${apps}`);

  // Ambiguity resolves to REVIEW, never to "probably ordinary super".
  // Byte-DIFFERENT from the first upload in this phase, or FDH-3's document
  // hash returns the earlier statement and this control tests nothing.
  const up2 = await uploadStatement(user, summaryCsv({ tax: '250.00', closing: '105575.00' }), {
    fund_name: 'LiveCert Corporate Trustee ATF Trust Deed Fund', masked_account_identifier: '****4444',
    statement_date: '2026-06-30', statement_period_start: '2026-01-01', statement_period_end: '2026-06-30',
  });
  const row2 = (await rest(`fdh_retirement_statements?id=eq.${up2.json?.data?.statement_id}&select=*`)).json?.[0];
  check('§137 LIVE: an AMBIGUOUS SMSF-looking statement is held as possible_smsf, not silently imported',
    row2?.smsf_classification === 'possible_smsf', String(row2?.smsf_classification));
  const ap2 = await post(user, up2.json?.data?.document_id, '/approve', {});
  check('§137 LIVE: a possible_smsf statement also cannot be approved without confirmation', ap2.status === 409, `status=${ap2.status}`);

  // The SMSF canonical row can never be an import target either.
  const smsfMatch = await post(user, doc, '/account-match', { action: 'resolve', account_id: smsfAcct.id });
  check('§137 LIVE: an SMSF canonical account cannot be selected as an import target', smsfMatch.status === 409, `status=${smsfMatch.status}`);
}

async function phasePagination() {
  console.log('\n=== §139 — LIVE POSTGREST PAGINATION BOUNDARY (1000 / 1001) ===');
  const user = await createUser('pagination');
  const member = await seedMember(user, 'self');
  await seedAccount(user, { name: 'LiveCert Horizon Super', balance: '100000.00', memberId: member.id });
  state.pagination = { user };

  const run = async (n) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      const month = String((i % 12) + 1).padStart(2, '0');
      // Distinct amounts keep every row a distinct economic identity.
      rows.push(`2026-${month}-${day},Administration Fee,${(1 + i / 100).toFixed(2)},`);
    }
    const up = await uploadStatement(user, transactionCsv(rows), {
      fund_name: `LiveCert Paging ${n}`, masked_account_identifier: `****${n}`,
      statement_date: '2026-12-31', statement_period_start: '2026-01-01', statement_period_end: '2026-12-31',
    });
    const sid = up.json?.data?.statement_id;
    const extracted = up.json?.data?.activities_extracted;
    // Independent service-role head count, paged explicitly past the cap.
    let stored = 0;
    for (let from = 0; ; from += 1000) {
      const page = await rest(`fdh_retirement_statement_activities?select=id&statement_id=eq.${sid}&order=id&offset=${from}&limit=1000`);
      const len = page.json?.length ?? 0;
      stored += len;
      if (len < 1000) break;
    }
    // The application's OWN read path: evidence matching must see every row.
    const ev = await post(user, up.json?.data?.document_id, '/evidence-matches', {});
    const b = ev.json?.data?.bank ?? {};
    const seenByApp = (b.matched ?? 0) + (b.no_match ?? 0) + (b.multiple_candidates ?? 0) + (b.not_expected ?? 0) + (b.bank_evidence_not_available ?? 0);
    return { sid, extracted, stored, seenByApp, evStatus: ev.status };
  };

  for (const n of [1000, 1001]) {
    const r = await run(n);
    check(`§139 LIVE: ${n} activity rows extracted from one statement`, r.extracted === n, `extracted=${r.extracted}`);
    check(`§139 LIVE: ${n} activity rows actually stored in hosted DEV`, r.stored === n, `stored=${r.stored}`);
    check(`§139 LIVE: the application's own read path saw all ${n} rows — no silent PostgREST truncation at the cap`,
      r.seenByApp === n, `seen=${r.seenByApp} status=${r.evStatus}`);
  }
}

async function phaseEvidenceOnlyTriple() {
  console.log('\n=== ARCHITECTURE — statement activities are EVIDENCE, not a second canonical ledger ===');
  const { user, account, applicationId } = state.A;

  const acts = (await rest(`fdh_retirement_statement_activities?user_id=eq.${user.id}&select=id`)).json ?? [];
  check('Statement activities: stored as evidence (rows exist independently of any canonical write)',
    acts.length > 0, `activities=${acts.length}`);

  const applications = (await rest(`fhip_import_applications?user_id=eq.${user.id}&select=id,target_domain,source_retirement_statement_id`)).json ?? [];
  const acct = (await rest(`retirement_accounts?id=eq.${account.id}&select=*`)).json?.[0];
  check('Canonical Retirement: summary state updated only through approved apply',
    applications.length === 1 && acct?.last_import_application_id === applicationId,
    `applications=${applications.length} last_import_application_id=${acct?.last_import_application_id}`);
  check('Canonical Retirement carries no per-activity ledger: the account row holds SUMMARY fields only',
    ['current_balance', 'employer_contribution', 'personal_contribution', 'contribution_frequency'].every((c) => c in acct)
    && !Object.keys(acct).some((c) => /activity|transaction|movement|ledger|posting/.test(c)),
    Object.keys(acct).join(','));

  // Repository-wide + live-schema proof that no second canonical ledger exists.
  const spec = await (await fetch(`${URL_}/rest/v1/`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();
  const tables = Object.keys(spec.definitions ?? {});
  const canonicalLedgerish = tables.filter((t) =>
    !t.startsWith('fdh_') && !t.startsWith('ii_')
    && /retirement/.test(t) && /(activit|transaction|movement|ledger|posting|contribution_event)/.test(t));
  check('Second canonical activity ledger created: 0', canonicalLedgerish.length === 0, canonicalLedgerish.join(','));

  const mig = fs.readFileSync(path.join(repoRoot, 'supabase/migrations/0112_fdh12_retirement_statement_intelligence.sql'), 'utf8');
  const createdTables = [...mig.matchAll(/^create table (\w+)/gm)].map((m) => m[1]);
  check('Migration 0112 creates exactly the three fdh_ evidence tables and nothing canonical',
    createdTables.length === 3 && createdTables.every((t) => t.startsWith('fdh_retirement_statement')),
    createdTables.join(','));
  const alteredCanonical = [...mig.matchAll(/alter table (retirement_accounts|retirement_members|smsf_funds)\s+add column (?:if not exists\s+)?([a-z_][a-z0-9_]*)/g)].map((m) => `${m[1]}.${m[2]}`);
  check('Migration 0112 adds only apply-provenance columns to canonical Retirement',
    alteredCanonical.every((c) => /last_import_application_id|last_imported_at/.test(c)), alteredCanonical.join(','));

  // Every canonical register outside Retirement stayed empty across the run.
  for (const [uname, u] of Object.entries({ A: state.A?.user, personal: state.personal?.user, rollover: state.rollover?.user, withdrawal: state.withdrawal?.user })) {
    if (!u) continue;
    const inc = await countRows('income_sources', u.id);
    const exp = await countRows('expense_items', u.id);
    check(`No canonical income/expense posting from FDH-12 for tenant ${uname}`, inc === 0 && exp === 0, `income=${inc} expense=${exp}`);
  }
}

async function phaseCleanup() {
  console.log('\n=== §171 — DEV CLEANUP ===');
  const ids = createdUsers.map((u) => u.id);
  for (const id of ids) {
    await rest(`fdh_retirement_statement_activities?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_retirement_statement_positions?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_retirement_statements?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fhip_import_proposal_fields?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fhip_import_applications?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fhip_import_proposals?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`retirement_accounts?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`retirement_members?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_payroll_events?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_transactions?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_document_audit_events?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_statement_uploads?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_upload_sessions?user_id=eq.${id}`, { method: 'DELETE' });
    await rest(`fdh_financial_accounts?user_id=eq.${id}`, { method: 'DELETE' });
    await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  }

  const residue = {};
  for (const t of ['fdh_retirement_statements', 'fdh_retirement_statement_activities', 'fdh_retirement_statement_positions',
    'fdh_statement_uploads', 'fdh_transactions', 'fdh_payroll_events', 'fdh_financial_accounts',
    'retirement_accounts', 'retirement_members', 'fhip_import_proposals', 'fhip_import_applications', 'user_profiles']) {
    const key = t === 'user_profiles' ? 'user_id' : 'user_id';
    const q = ids.map((i) => i).join(',');
    const r = await rest(`${t}?select=${key}&${key}=in.(${q})`);
    residue[t] = Array.isArray(r.json) ? r.json.length : `ERR:${r.text.slice(0, 60)}`;
  }
  for (const [t, n] of Object.entries(residue)) {
    check(`§171 cleanup verified: 0 synthetic rows remain in ${t}`, n === 0, `rows=${n}`);
  }

  // Independent sweep by the tag pattern, not by the id list.
  const anyUsers = await fetch(`${URL_}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  const uj = await anyUsers.json();
  const leftovers = (uj.users ?? []).filter((u) => (u.email ?? '').startsWith(`${TAG}-`));
  check('§171 cleanup verified independently: no fdh12-livedev-* auth user remains',
    leftovers.length === 0, leftovers.map((u) => u.email).join(','));
  // DISCLOSURE, not a claim of ownership: synthetic users left on DEV by
  // EARLIER certification rounds (not this one — every id here predates this
  // run and carries another phase's tag). Reported so the residue is visible
  // rather than silently absorbed into an "all clean" statement.
  const foreign = (uj.users ?? [])
    .filter((u) => /@fhip-test\.invalid|@test\.fhip\.internal/.test(u.email ?? ''))
    .filter((u) => !(u.email ?? '').startsWith(`${TAG}-`));
  console.log(`  NOTE  pre-existing synthetic users from EARLIER rounds still on DEV (not created or removed by this run): ${foreign.length ? foreign.map((u) => `${u.email} (${u.created_at})`).join('; ') : 'none'}`);
}

// ===========================================================================

const PHASES = {
  schema: phaseSchema,
  journey: phaseJourney,
  employer: phaseEmployerContribution,
  internal: phaseInternalMovements,
  personal: phasePersonalContribution,
  rollover: phaseRollover,
  withdrawal: phaseWithdrawal,
  recon: phaseReconciliationNegative,
  dedup: phaseDuplicateAndOverlap,
  wrong: phaseWrongAccount,
  cross: phaseCrossTenant,
  forgery: phaseSameTenantForgery,
  smsf: phaseSmsf,
  pagination: phasePagination,
  triple: phaseEvidenceOnlyTriple,
};
const ORDER = ['schema', 'journey', 'employer', 'internal', 'personal', 'rollover', 'withdrawal', 'recon',
  'dedup', 'wrong', 'cross', 'triple', 'forgery', 'smsf', 'pagination'];

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const selected = requested.length > 0 ? requested : ORDER;
  console.log(`FDH-12 LIVE DEV CERTIFICATION`);
  console.log(`  DEV project : ${new URL(URL_).host}`);
  console.log(`  App server  : ${APP}`);
  console.log(`  Phases      : ${selected.join(', ')}`);

  // Prove the app server is THIS worktree: the route exists here and nowhere else.
  const probe = await fetch(`${APP}/api/financial-data-hub/retirement-statement/upload`, { method: 'POST' });
  check('The dev server on this port serves THIS branch (FDH-12 route present: 401, not 404)', probe.status === 401, `status=${probe.status}`);

  try {
    for (const name of selected) {
      if (!PHASES[name]) throw new Error(`unknown phase ${name}`);
      await PHASES[name]();
    }
  } finally {
    if (!process.argv.includes('--no-cleanup')) await phaseCleanup();
  }

  console.log(`\n=== RESULT: ${pass} PASS, ${fail} FAIL ===`);
  if (fail > 0) console.log('Failures:\n  - ' + failures.join('\n  - '));
  fs.writeFileSync(path.join(repoRoot, 'scripts', 'fdh12-live-dev-results.json'), JSON.stringify({ pass, fail, failures }, null, 2));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
