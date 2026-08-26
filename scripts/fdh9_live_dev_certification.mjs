// FDH-9 — Payslip & Income Intelligence: LIVE DEV certification.
//
// *** NOT YET RUN AS OF THIS COMMIT. ***
// Migration 0091_fdh9_payslip_income_intelligence.sql (including Part D,
// the atomic-apply hardening) has NOT been applied to DEV — confirmed live
// against the real project (vqycarelcoijzwlpkpcz.supabase.co) on 2026-08-26:
// every fdh_payroll_events / fhip_import_* table and the
// fdh9_apply_income_proposal RPC return PGRST205/PGRST202 ("could not find
// the table/function"). This session had no Supabase CLI auth
// (`SUPABASE_ACCESS_TOKEN` unset, `supabase login` never run) and no direct
// Postgres connection string in `.env.local` — only NEXT_PUBLIC_SUPABASE_URL,
// NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY, none of which
// can execute DDL. Applying migration 0091 to DEV therefore requires a human
// (or a session with genuine DB/CLI credentials) to run it — most likely by
// pasting the file into the Supabase SQL Editor, the same mechanism this
// project's own history records for prior migrations.
//
// This script is the exact live-DEV counterpart to
// scripts/fdh9_certification.mjs's PGlite run (which is 76/76 PASS against
// the identical migration file). Run it immediately after 0091 is applied:
//
//   node scripts/fdh9_live_dev_certification.mjs
//
// It follows the established pattern (scripts/r11_professional_live_dev_tests.mjs):
// real synthetic users via the Auth admin API, real password sign-in, real
// PostgREST/RPC calls with a real user JWT (not the service-role key, except
// for setup/cleanup/ground-truth verification), and explicit cleanup with an
// independent post-cleanup verification query (spec section 50).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

// EXPECTED DEV PROJECT REF — spec section 42's "verify target project
// identity first". Refuses to run against anything else, so this script can
// never be pointed at production by an unnoticed .env swap.
const EXPECTED_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_PROJECT_REF) {
  console.error(`REFUSING TO RUN: target project ref "${actualRef}" does not match the expected DEV project "${EXPECTED_PROJECT_REF}". This script never touches production.`);
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label} ${detail}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

const stamp = Date.now();
const cleanup = { userIds: [], incomeIds: [], payrollIds: [], proposalIds: [] };

async function svc(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function makeUser(tag) {
  const email = `fdh9-${tag}-${stamp}@fhip-test.invalid`;
  const password = `TestPass!${stamp}Aa1`;
  const created = await svc('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  if (!id) throw new Error(`could not create test user ${tag}: ${created.text}`);
  cleanup.userIds.push(id);
  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) throw new Error(`could not sign in test user ${tag}: ${JSON.stringify(tokenJson)}`);
  return { id, email, accessToken: tokenJson.access_token };
}

async function asUser(user, p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${user.accessToken}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

console.log('=== FDH-9 LIVE DEV Certification ===');
console.log(`Target project: ${actualRef} (verified matches expected DEV ref)\n`);

// --- Pre-flight: confirm migration IS applied before running anything else.
const preflight = await svc('/rest/v1/fdh_payroll_events?limit=1');
if (preflight.status === 404) {
  console.error('MIGRATION 0091 IS NOT APPLIED TO THIS DEV PROJECT YET.');
  console.error('Apply supabase/migrations/0091_fdh9_payslip_income_intelligence.sql (all of it, including Part D) via the Supabase SQL Editor, then re-run this script.');
  process.exit(3);
}
console.log('Pre-flight: fdh_payroll_events table exists — migration 0091 is applied. Proceeding.\n');

const A = await makeUser('tenant-a');
const B = await makeUser('tenant-b');
console.log(`Tenant A: ${A.id}\nTenant B: ${B.id}\n`);

async function seedIncome(user, overrides = {}) {
  const row = { source_name: 'Salary — Acme', income_type: 'salary', amount: 5000, frequency: 'monthly', currency_code: 'AUD', employer_name: 'Acme Pty Ltd', ...overrides };
  const r = await asUser(user, '/rest/v1/income_sources', { method: 'POST', body: row, prefer: 'return=representation' });
  const id = r.json?.[0]?.id;
  if (id) cleanup.incomeIds.push(id);
  return id;
}
async function seedPayroll(user, overrides = {}) {
  const row = { employer_name: 'Acme Pty Ltd', country_code: 'AU', currency_code: 'AUD', gross_pay: 5200, net_pay: 4250, ...overrides };
  const r = await asUser(user, '/rest/v1/fdh_payroll_events', { method: 'POST', body: row, prefer: 'return=representation' });
  const id = r.json?.[0]?.id;
  if (id) cleanup.payrollIds.push(id);
  return id;
}
async function seedProposal(user, { sourcePayrollEventId, targetEntityId }) {
  const row = { target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: sourcePayrollEventId, currency_code: 'AUD', target_entity_id: targetEntityId, recommended_apply_mode: 'update_existing', status: 'ready' };
  const r = await asUser(user, '/rest/v1/fhip_import_proposals', { method: 'POST', body: row, prefer: 'return=representation' });
  const id = r.json?.[0]?.id;
  if (id) cleanup.proposalIds.push(id);
  return id;
}
async function seedField(user, proposalId, fieldName, valueKind, proposedValue, existingValue) {
  await asUser(user, '/rest/v1/fhip_import_proposal_fields', { method: 'POST', body: { proposal_id: proposalId, field_name: fieldName, value_kind: valueKind, proposed_value: proposedValue, existing_value: existingValue } });
}

console.log('=== LIVE-1: direct proposal-status forgery (mandatory closure gate, spec section 46) ===');
{
  const incomeId = await seedIncome(A);
  const payrollId = await seedPayroll(A);
  const proposalId = await seedProposal(A, { sourcePayrollEventId: payrollId, targetEntityId: incomeId });
  await seedField(A, proposalId, 'amount', 'money', '5200.00', '5000.00');

  const forge = await asUser(A, `/rest/v1/fhip_import_proposals?id=eq.${proposalId}`, { method: 'PATCH', body: { status: 'applied', applied_at: new Date().toISOString() } });
  check('LIVE: direct authenticated PATCH status=applied is BLOCKED', forge.status >= 400, `status=${forge.status} body=${forge.text.slice(0, 200)}`);

  const check2 = await svc(`/rest/v1/fhip_import_proposals?id=eq.${proposalId}&select=status`);
  check('LIVE: proposal status genuinely unchanged in the database (ground truth via service role)', check2.json?.[0]?.status === 'ready');
}

console.log('\n=== LIVE-2: forged application row ===');
{
  const incomeId = await seedIncome(A);
  const payrollId = await seedPayroll(A);
  const proposalId = await seedProposal(A, { sourcePayrollEventId: payrollId, targetEntityId: incomeId });
  const forge = await asUser(A, '/rest/v1/fhip_import_applications', {
    method: 'POST',
    body: { user_id: A.id, proposal_id: proposalId, target_domain: 'income', target_entity_id: incomeId, apply_mode: 'add_new', applied_fields: [], previous_values: {}, new_values: {}, applied_by: A.id },
  });
  check('LIVE: forged application row is BLOCKED', forge.status >= 400, `status=${forge.status} body=${forge.text.slice(0, 200)}`);
}

console.log('\n=== LIVE-3: atomic apply via the real RPC (happy path) ===');
{
  const incomeId = await seedIncome(A, { amount: 5000 });
  const payrollId = await seedPayroll(A);
  const proposalId = await seedProposal(A, { sourcePayrollEventId: payrollId, targetEntityId: incomeId });
  await seedField(A, proposalId, 'amount', 'money', '5200.00', '5000.00');

  const applyRes = await asUser(A, '/rest/v1/rpc/fdh9_apply_income_proposal', {
    method: 'POST', body: { p_proposal_id: proposalId, p_decision: 'apply_selected_fields', p_selected_fields: ['amount'] },
  });
  check('LIVE: RPC apply succeeds', applyRes.json?.ok === true, JSON.stringify(applyRes.json));
  const incomeAfter = await svc(`/rest/v1/income_sources?id=eq.${incomeId}&select=amount,source_type,last_import_application_id`);
  check('LIVE: Income amount genuinely updated in the database', Number(incomeAfter.json?.[0]?.amount) === 5200);
  check('LIVE: provenance stamped', incomeAfter.json?.[0]?.source_type === 'payslip_import');
  const appsAfter = await svc(`/rest/v1/fhip_import_applications?proposal_id=eq.${proposalId}&select=id`);
  check('LIVE: exactly one application row', appsAfter.json?.length === 1);

  const repeat = await asUser(A, '/rest/v1/rpc/fdh9_apply_income_proposal', {
    method: 'POST', body: { p_proposal_id: proposalId, p_decision: 'apply_selected_fields', p_selected_fields: ['amount'] },
  });
  check('LIVE: repeated apply is refused as ALREADY_APPLIED (idempotent)', repeat.json?.ok === false && repeat.json?.code === 'ALREADY_APPLIED');
}

console.log('\n=== LIVE-4: cross-tenant (spec sections 23, 47) ===');
{
  const incomeA = await seedIncome(A);
  const incomeB = await seedIncome(B, { source_name: 'Salary — B Corp' });
  const payrollA = await seedPayroll(A);
  const proposalA = await seedProposal(A, { sourcePayrollEventId: payrollA, targetEntityId: incomeA });
  await seedField(A, proposalA, 'amount', 'money', '5200.00', '5000.00');

  const bReadsA = await asUser(B, `/rest/v1/fhip_import_proposals?id=eq.${proposalA}`);
  check('LIVE: B cannot read A proposal', (bReadsA.json?.length ?? 0) === 0);
  const bReadsPayroll = await asUser(B, `/rest/v1/fdh_payroll_events?id=eq.${payrollA}`);
  check('LIVE: B cannot read A payroll', (bReadsPayroll.json?.length ?? 0) === 0);
  const bApplies = await asUser(B, '/rest/v1/rpc/fdh9_apply_income_proposal', { method: 'POST', body: { p_proposal_id: proposalA, p_decision: 'apply_selected_fields', p_selected_fields: ['amount'] } });
  check('LIVE: B applying A proposal is BLOCKED', bApplies.json?.ok === false && bApplies.json?.code === 'PROPOSAL_NOT_FOUND');

  // Cross-tenant target Income: A's own proposal, forged target -> B's income.
  const forgedTarget = await asUser(A, '/rest/v1/fhip_import_proposals', {
    method: 'POST',
    body: { target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: payrollA, currency_code: 'AUD', target_entity_id: incomeB, recommended_apply_mode: 'update_existing', status: 'ready' },
  });
  check('LIVE: cross-tenant target Income (forged target_entity_id) is BLOCKED at write time', forgedTarget.status >= 400, `status=${forgedTarget.status}`);
}

console.log('\n=== LIVE-5: no-apply through the flow (spec section 34, 45) ===');
{
  const incomeId = await seedIncome(A, { amount: 9000 });
  const payrollId = await seedPayroll(A);
  const proposalId = await seedProposal(A, { sourcePayrollEventId: payrollId, targetEntityId: incomeId });
  await seedField(A, proposalId, 'amount', 'money', '9200.00', '9000.00');
  // Generate only — never call apply.
  const income = await svc(`/rest/v1/income_sources?id=eq.${incomeId}&select=amount`);
  check('LIVE: Income unchanged after proposal generation with no Apply call', Number(income.json?.[0]?.amount) === 9000);
}

console.log(`\n=== SUBTOTAL: ${pass} passed, ${fail} failed ===`);

// =============================================================================
// CLEANUP (spec section 50) — delete every FDH-9 synthetic record, then
// independently re-query to prove zero remain.
// =============================================================================
console.log('\n=== CLEANUP ===');
for (const id of cleanup.proposalIds) await svc(`/rest/v1/fhip_import_proposals?id=eq.${id}`, { method: 'DELETE' });
for (const id of cleanup.payrollIds) await svc(`/rest/v1/fdh_payroll_events?id=eq.${id}`, { method: 'DELETE' });
for (const id of cleanup.incomeIds) await svc(`/rest/v1/income_sources?id=eq.${id}`, { method: 'DELETE' });
for (const id of cleanup.userIds) await svc(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });

let remaining = 0;
for (const id of cleanup.userIds) {
  const r = await svc(`/auth/v1/admin/users/${id}`);
  if (r.status !== 404) remaining += 1;
}
for (const id of cleanup.proposalIds) {
  const r = await svc(`/rest/v1/fhip_import_proposals?id=eq.${id}`);
  if ((r.json?.length ?? 0) > 0) remaining += 1;
}
check('CLEANUP: independently re-queried — zero FDH-9 test users/records remain', remaining === 0, `remaining=${remaining}`);

console.log(`\n=== FINAL RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) console.log('FAILURES:', failures.join(', '));
process.exit(fail > 0 ? 1 : 0);
