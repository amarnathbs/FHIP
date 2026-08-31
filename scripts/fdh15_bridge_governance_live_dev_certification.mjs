// FDH-15 — Bridge / Governance Certification: fresh LIVE DEV proof.
//
// Exercises the REAL owner RPCs (fdh9_apply_income_proposal,
// fdh10_apply_liability_proposal, fdh12_apply_retirement_proposal, and their
// companion approve RPCs) via a REAL authenticated-user JWT (role
// "authenticated" in the JWT claims), never the service-role key, for every
// decisive Apply/security/provenance/stale/idempotency test — per repository
// standing rule #10 / spec sections 149, 164, 165, 215.
//
// The service-role key is used ONLY for: creating synthetic users, seeding
// fixture/evidence rows that a real upload+parse pipeline would have produced
// (this script does not exercise PDF/CSV parsing — that is FDH-3/4/5/9/10/11/12's
// own certified territory), ground-truth re-queries, and cleanup.
//
// Reads credentials from THIS worktree's own .env.local (D:/fhip-fdh15/.env.local
// — never the Product Owner's D:/FHIP tree, which this branch does not touch).
// DEV project only (vqycarelcoijzwlpkpcz), guarded below. No migrations applied.
// No production access. Every synthetic row + both synthetic auth users are
// deleted at the end and cleanup is independently re-verified by re-query.
//
// Run: node scripts/fdh15_bridge_governance_live_dev_certification.mjs

import fs from 'node:fs';

function loadEnv() {
  const text = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    if (!line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const DEV_REF = 'vqycarelcoijzwlpkpcz';
if (!BASE || !SERVICE || !ANON) { console.error('FATAL: missing env vars'); process.exit(2); }
if (!BASE.includes(DEV_REF)) { console.error(`FATAL: refusing to run — ${BASE} is not the known DEV project.`); process.exit(2); }

const TAG = 'fdh15-bridge';
let pass = 0, fail = 0;
const failures = [];
const findings = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
};
const finding = (label, detail) => { findings.push({ label, detail }); console.log(`  FINDING  ${label} :: ${detail}`); };

const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
async function svc(method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { ...SH, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function asUser(token, method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function rpcAs(token, fn, args) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function insert(table, body, track) {
  const r = await svc('POST', table, body);
  const row = Array.isArray(r.json) ? r.json[0] : null;
  if (!row) throw new Error(`insert ${table} failed (${r.status}): ${r.text.slice(0, 500)}`);
  if (track) track.push({ table, id: row.id });
  return row;
}

async function createUser(label) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${TAG}-${label}-${stamp}@fhip-test.invalid`;
  const password = `Fdh15Bridge!${stamp}`;
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { ...SH, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser(${label}) failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await svc('PATCH', `user_profiles?user_id=eq.${j.id}`, { full_name: `FDH15 ${label}`, country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100, country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
  // Real authenticated-role JWT (rule #10 technique): grant_type=password, apikey=anon works identically to service-role here; use anon (matches established repo pattern in mcc14_livedev_verification.mjs).
  const signInR = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const signInJ = await signInR.json();
  if (!signInJ.access_token) throw new Error(`signIn(${label}) failed: ${JSON.stringify(signInJ).slice(0, 300)}`);
  return { id: j.id, email, token: signInJ.access_token };
}
async function deleteUser(id) {
  await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH });
}

const trackA = []; // Tenant A rows, deleted at the end
const trackB = []; // Tenant B rows
const DAY = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function cleanupTrack(track) {
  for (const { table, id } of track.reverse()) {
    await svc('DELETE', `${table}?id=eq.${id}`);
  }
}

async function main() {
  console.log('=== FDH-15 LIVE DEV: Bridge / Governance Certification ===');
  const A = await createUser('tenantA');
  const B = await createUser('tenantB');
  console.log(`Tenant A: ${A.email} (${A.id})`);
  console.log(`Tenant B: ${B.email} (${B.id})`);
  try {
    await incomeSuite(A, B);
    await retirementSelfSpouseSuite(A);
    await liabilitySuite(A, B);
    await crossTenantSweep(A, B);
  } finally {
    console.log('\n--- CLEANUP ---');
    await cleanupTrack(trackB);
    await cleanupTrack(trackA);
    await deleteUser(B.id);
    await deleteUser(A.id);
    // Independent re-verification: re-query by tag / by deleted user id.
    const residualA = await svc('GET', `income_sources?user_id=eq.${A.id}&select=id`);
    const residualUserA = await fetch(`${BASE}/auth/v1/admin/users/${A.id}`, { headers: SH });
    check('CLEANUP: Tenant A synthetic income rows = 0 after cleanup', Array.isArray(residualA.json) && residualA.json.length === 0, `rows=${JSON.stringify(residualA.json)}`);
    check('CLEANUP: Tenant A auth user deleted (re-query 404/empty)', residualUserA.status >= 400 || residualUserA.status === 200 && (await residualUserA.json())?.id === undefined, `status=${residualUserA.status}`);
  }

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (findings.length) {
    console.log('\n=== FINDINGS (require disclosure / defect assessment) ===');
    for (const f of findings) console.log(`  - ${f.label}: ${f.detail}`);
  }
  if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exitCode = 1; }
}

// ===========================================================================
// INCOME SUITE
// ===========================================================================
async function incomeSuite(A, B) {
  console.log('\n--- INCOME BRIDGE ---');

  // Baseline: Self income source (manual), Spouse income source (manual), same employer name (folds identically)
  const selfIncome = await insert('income_sources', { user_id: A.id, source_name: 'Self salary', employer_name: 'Woolworths Group Pty Ltd', income_type: 'salary', amount: 4000, frequency: 'monthly', currency_code: 'AUD', is_active: true, owner: 'self' }, trackA);
  const spouseIncome = await insert('income_sources', { user_id: A.id, source_name: 'Spouse salary', employer_name: 'Woolworths Group Pty Ltd', income_type: 'salary', amount: 3500, frequency: 'monthly', currency_code: 'AUD', is_active: true, owner: 'spouse' }, trackA);

  // --- Positive control: legitimate update_existing against SELF's own row via the real RPC ---
  const payrollEvent = await insert('fdh_payroll_events', { user_id: A.id, country_code: 'AU', currency_code: 'AUD', net_pay: 4200, gross_pay: 4200, pay_frequency: 'monthly', pay_frequency_source: 'stated_on_payslip', reconciliation_status: 'reconciled', bank_match_status: 'not_attempted', review_status: 'resolved', approval_status: 'approved', approved_at: new Date().toISOString(), payslip_fingerprint: `${TAG}-payslip-pos` }, trackA);
  const propPos = await insert('fhip_import_proposals', { user_id: A.id, target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: payrollEvent.id, currency_code: 'AUD', target_entity_id: selfIncome.id, recommended_apply_mode: 'update_existing', status: 'ready' }, trackA);
  await insert('fhip_import_proposal_fields', { user_id: A.id, proposal_id: propPos.id, field_name: 'amount', value_kind: 'money', proposed_value: '4200.00', existing_value: '4000.00', is_recommended: true }, trackA);

  const applyPos = await rpcAs(A.token, 'fdh9_apply_income_proposal', { p_proposal_id: propPos.id, p_decision: 'update_existing', p_selected_fields: ['amount'] });
  check('INC-1 Positive control: legitimate update_existing via real authenticated RPC succeeds', applyPos.json?.ok === true, JSON.stringify(applyPos.json));
  const selfAfter = (await svc('GET', `income_sources?id=eq.${selfIncome.id}&select=amount,source_type,last_import_application_id`)).json?.[0];
  check('INC-1b: Self income amount updated to 4200 (exact decimal)', Number(selfAfter?.amount) === 4200, JSON.stringify(selfAfter));
  check('INC-1c: Apply stamped provenance source_type=payslip_import', selfAfter?.source_type === 'payslip_import', JSON.stringify(selfAfter));

  // --- Double apply / idempotency ---
  const applyAgain = await rpcAs(A.token, 'fdh9_apply_income_proposal', { p_proposal_id: propPos.id, p_decision: 'update_existing', p_selected_fields: ['amount'] });
  check('INC-2 Double apply of same proposal returns ALREADY_APPLIED (not a second mutation)', applyAgain.json?.ok === false && applyAgain.json?.code === 'ALREADY_APPLIED', JSON.stringify(applyAgain.json));
  const appRows = (await svc('GET', `fhip_import_applications?proposal_id=eq.${propPos.id}&select=id`)).json ?? [];
  check('INC-2b: exactly ONE fhip_import_applications row exists for this proposal (unique(proposal_id) enforced)', appRows.length === 1, `rows=${appRows.length}`);

  // --- Provenance forge/erase: owning user tries to directly PATCH provenance columns ---
  const forgeErase = await asUser(A.token, 'PATCH', `income_sources?id=eq.${selfIncome.id}`, { source_type: 'manual' });
  const selfAfterForge = (await svc('GET', `income_sources?id=eq.${selfIncome.id}&select=source_type`)).json?.[0];
  check('INC-3 Provenance erase BLOCKED: direct authenticated PATCH of source_type is rejected or has zero effect', selfAfterForge?.source_type === 'payslip_import', `patchStatus=${forgeErase.status} liveValue=${selfAfterForge?.source_type}`);

  const forgeAppId = await asUser(A.token, 'PATCH', `income_sources?id=eq.${selfIncome.id}`, { last_import_application_id: null });
  const selfAfterForge2 = (await svc('GET', `income_sources?id=eq.${selfIncome.id}&select=last_import_application_id`)).json?.[0];
  check('INC-3b Provenance erase BLOCKED: direct authenticated PATCH of last_import_application_id is rejected or has zero effect', selfAfterForge2?.last_import_application_id !== null, `patchStatus=${forgeAppId.status}`);

  // --- Stale proposal: manually change canonical value after proposal generated, before apply ---
  const propStale = await insert('fhip_import_proposals', { user_id: A.id, target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: payrollEvent.id, currency_code: 'AUD', target_entity_id: selfIncome.id, recommended_apply_mode: 'update_existing', status: 'ready' }, trackA);
  await insert('fhip_import_proposal_fields', { user_id: A.id, proposal_id: propStale.id, field_name: 'frequency', value_kind: 'enum', proposed_value: 'fortnightly', existing_value: 'monthly' }, trackA);
  // User independently edits their own income record (simulating a manual edit between proposal generation and apply)
  await asUser(A.token, 'PATCH', `income_sources?id=eq.${selfIncome.id}`, { frequency: 'weekly' });
  const staleApply = await rpcAs(A.token, 'fdh9_apply_income_proposal', { p_proposal_id: propStale.id, p_decision: 'update_existing', p_selected_fields: ['frequency'] });
  check('INC-4 Stale proposal BLOCKED: manual edit after proposal generation causes STALE_PROPOSAL, not silent overwrite', staleApply.json?.ok === false && staleApply.json?.code === 'STALE_PROPOSAL', JSON.stringify(staleApply.json));
  const selfAfterStale = (await svc('GET', `income_sources?id=eq.${selfIncome.id}&select=frequency`)).json?.[0];
  check('INC-4b: canonical frequency remains the user\'s manual value (weekly), not silently overwritten to fortnightly', selfAfterStale?.frequency === 'weekly', JSON.stringify(selfAfterStale));

  // --- Zero fields selected ---
  const propZero = await insert('fhip_import_proposals', { user_id: A.id, target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: payrollEvent.id, currency_code: 'AUD', target_entity_id: selfIncome.id, recommended_apply_mode: 'update_existing', status: 'ready' }, trackA);
  await insert('fhip_import_proposal_fields', { user_id: A.id, proposal_id: propZero.id, field_name: 'amount', value_kind: 'money', proposed_value: '9999.00', existing_value: '4200.00' }, trackA);
  const zeroApply = await rpcAs(A.token, 'fdh9_apply_income_proposal', { p_proposal_id: propZero.id, p_decision: 'apply_selected_fields', p_selected_fields: [] });
  check('INC-5 Zero-fields Apply produces a controlled outcome (NO_FIELDS_SELECTED), not a blank/ambiguous write', zeroApply.json?.ok === false && zeroApply.json?.code === 'NO_FIELDS_SELECTED', JSON.stringify(zeroApply.json));

  // --- DECISIVE NEGATIVE CONTROL: same-tenant target forgery, Self proposal repointed to Spouse's income row ---
  const propForge = await insert('fhip_import_proposals', { user_id: A.id, target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: payrollEvent.id, currency_code: 'AUD', target_entity_id: spouseIncome.id, recommended_apply_mode: 'update_existing', status: 'ready' }, trackA);
  await insert('fhip_import_proposal_fields', { user_id: A.id, proposal_id: propForge.id, field_name: 'amount', value_kind: 'money', proposed_value: '9000.00', existing_value: '3500.00' }, trackA);
  const forgeApply = await rpcAs(A.token, 'fdh9_apply_income_proposal', { p_proposal_id: propForge.id, p_decision: 'update_existing', p_selected_fields: ['amount'] });
  const spouseAfter = (await svc('GET', `income_sources?id=eq.${spouseIncome.id}&select=amount,owner`)).json?.[0];
  const forgeBlocked = forgeApply.json?.ok === false;
  check('INC-6 SAME-TENANT TARGET/OWNER FORGERY: Self-attributed payslip proposal targeting Spouse-owned income row is BLOCKED', forgeBlocked, JSON.stringify(forgeApply.json));
  if (!forgeBlocked) {
    finding('FDH15-DEF-001 (Income owner/member forgery)', `fdh9_apply_income_proposal accepted a same-tenant proposal whose target_entity_id pointed at a Spouse-owned (owner='${spouseIncome.owner}') income_sources row and mutated it to amount=${spouseAfter?.amount}. The RPC's ownership check is 'user_id = auth.uid()' only — it never compares the target row's 'owner' column. Root cause: neither incomeAdapter.ts's matching query (no .eq('owner', ...) filter) nor fdh9_apply_income_proposal (no owner check) enforce member-level target validation.`);
  }

  console.log('  [Income suite complete]');
}

// ===========================================================================
// RETIREMENT SELF/SPOUSE SUITE
// ===========================================================================
async function retirementSelfSpouseSuite(A) {
  console.log('\n--- RETIREMENT BRIDGE: SELF/SPOUSE BOUNDARY ---');

  const selfMember = await insert('retirement_members', { user_id: A.id, member_type: 'self', country_code: 'AU' }, trackA);
  const spouseMember = await insert('retirement_members', { user_id: A.id, member_type: 'spouse', country_code: 'AU' }, trackA);
  const selfAcct = await insert('retirement_accounts', { user_id: A.id, account_name: 'Self Super', account_type: 'super', current_balance: 100000, currency_code: 'AUD', is_active: true, owner: 'self', retirement_member_id: selfMember.id }, trackA);
  const spouseAcct = await insert('retirement_accounts', { user_id: A.id, account_name: 'Spouse Super', account_type: 'super', current_balance: 80000, currency_code: 'AUD', is_active: true, owner: 'spouse', retirement_member_id: spouseMember.id }, trackA);

  const stmt = await insert('fdh_retirement_statements', { user_id: A.id, retirement_member_id: selfMember.id, canonical_account_id: selfAcct.id, statement_type: 'super_member_statement', retirement_jurisdiction: 'AU', account_type: 'industry_super', currency_code: 'AUD', closing_balance: 105000, reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'pending', extraction_status: 'extracted' }, trackA);
  const approveR = await rpcAs(A.token, 'fdh12_approve_retirement_statement', { p_statement_id: stmt.id });
  check('RET-0 Real approve RPC (fdh12_approve_retirement_statement) succeeds for the owning user', approveR.json?.ok === true, JSON.stringify(approveR.json));

  // Positive control: Self statement -> Self account, legitimate update_existing.
  const propSelf = await insert('fhip_import_proposals', { user_id: A.id, target_domain: 'retirement', source_kind: 'retirement_statement', currency_code: 'AUD', target_entity_id: selfAcct.id, recommended_apply_mode: 'update_existing', status: 'ready' }, trackA);
  await svc('PATCH', `fhip_import_proposals?id=eq.${propSelf.id}`, { source_retirement_statement_id: stmt.id });
  await insert('fhip_import_proposal_fields', { user_id: A.id, proposal_id: propSelf.id, field_name: 'current_balance', value_kind: 'money', proposed_value: '105000.00', existing_value: '100000.00' }, trackA);
  const applySelf = await rpcAs(A.token, 'fdh12_apply_retirement_proposal', { p_proposal_id: propSelf.id, p_decision: 'update_existing', p_selected_fields: ['current_balance'] });
  check('RET-1 Positive control: legitimate Self statement -> Self account apply succeeds via real RPC', applySelf.json?.ok === true, JSON.stringify(applySelf.json));
  const selfAcctAfter = (await svc('GET', `retirement_accounts?id=eq.${selfAcct.id}&select=current_balance,source_type`)).json?.[0];
  check('RET-1b: Self account balance updated to 105000', Number(selfAcctAfter?.current_balance) === 105000, JSON.stringify(selfAcctAfter));

  // DECISIVE NEGATIVE CONTROL: statement resolved to SELF member, but target_entity_id forged/repointed to SPOUSE's account (same tenant).
  const stmt2 = await insert('fdh_retirement_statements', { user_id: A.id, retirement_member_id: selfMember.id, canonical_account_id: selfAcct.id, statement_type: 'super_member_statement', retirement_jurisdiction: 'AU', account_type: 'industry_super', currency_code: 'AUD', closing_balance: 999000, reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'pending', extraction_status: 'extracted' }, trackA);
  await rpcAs(A.token, 'fdh12_approve_retirement_statement', { p_statement_id: stmt2.id });
  const propForge = await insert('fhip_import_proposals', { user_id: A.id, target_domain: 'retirement', source_kind: 'retirement_statement', currency_code: 'AUD', target_entity_id: spouseAcct.id, recommended_apply_mode: 'update_existing', status: 'ready' }, trackA);
  await svc('PATCH', `fhip_import_proposals?id=eq.${propForge.id}`, { source_retirement_statement_id: stmt2.id });
  await insert('fhip_import_proposal_fields', { user_id: A.id, proposal_id: propForge.id, field_name: 'current_balance', value_kind: 'money', proposed_value: '999000.00', existing_value: '80000.00' }, trackA);
  const forgeApply = await rpcAs(A.token, 'fdh12_apply_retirement_proposal', { p_proposal_id: propForge.id, p_decision: 'update_existing', p_selected_fields: ['current_balance'] });
  const spouseAcctAfter = (await svc('GET', `retirement_accounts?id=eq.${spouseAcct.id}&select=current_balance,retirement_member_id`)).json?.[0];
  const forgeBlocked = forgeApply.json?.ok === false;
  check('RET-2 SELF/SPOUSE BOUNDARY: a Self-sourced statement proposal repointed at Spouse\'s account is BLOCKED', forgeBlocked, JSON.stringify(forgeApply.json));
  if (!forgeBlocked) {
    finding('FDH15-DEF-002 (Retirement Self/Spouse forgery)', `fdh12_apply_retirement_proposal accepted a same-tenant proposal sourced from a Self-member statement (retirement_member_id=${selfMember.id}) whose target_entity_id pointed at the Spouse's retirement_accounts row (retirement_member_id=${spouseAcct.retirement_member_id}) and mutated its current_balance to ${spouseAcctAfter?.current_balance}. Root cause: the RPC computes v_member_id from the source statement AFTER the compare-and-swap claim and uses it ONLY for the add_new insert path (0112 line ~1445-1458) — update_existing never compares v_account.retirement_member_id against the statement's retirement_member_id before mutating.`);
  }

  // Provenance forge/erase on retirement_accounts
  const forgePatch = await asUser(A.token, 'PATCH', `retirement_accounts?id=eq.${selfAcct.id}`, { source_type: 'manual' });
  const selfAcctAfterForge = (await svc('GET', `retirement_accounts?id=eq.${selfAcct.id}&select=source_type`)).json?.[0];
  check('RET-3 Provenance erase BLOCKED on retirement_accounts.source_type', selfAcctAfterForge?.source_type === 'retirement_statement_import', `patchStatus=${forgePatch.status} live=${selfAcctAfterForge?.source_type}`);

  // target_retirement_age must never be reachable via the bridge (spec 78, 197)
  const propAge = await insert('fhip_import_proposals', { user_id: A.id, target_domain: 'retirement', source_kind: 'retirement_statement', currency_code: 'AUD', target_entity_id: selfAcct.id, recommended_apply_mode: 'update_existing', status: 'ready' }, trackA);
  await svc('PATCH', `fhip_import_proposals?id=eq.${propAge.id}`, { source_retirement_statement_id: stmt.id });
  await insert('fhip_import_proposal_fields', { user_id: A.id, proposal_id: propAge.id, field_name: 'target_retirement_age', value_kind: 'int', proposed_value: '50', existing_value: '67' }, trackA);
  const ageApply = await rpcAs(A.token, 'fdh12_apply_retirement_proposal', { p_proposal_id: propAge.id, p_decision: 'update_existing', p_selected_fields: ['target_retirement_age'] });
  check('RET-4 target_retirement_age is NOT an applicable field: FORBIDDEN_FIELD', ageApply.json?.ok === false && ageApply.json?.code === 'FORBIDDEN_FIELD', JSON.stringify(ageApply.json));

  console.log('  [Retirement suite complete]');
}

// ===========================================================================
// LIABILITY SUITE
// ===========================================================================
async function liabilitySuite(A, B) {
  console.log('\n--- LIABILITY BRIDGE ---');
  const liab = await insert('liabilities', { user_id: A.id, liability_name: 'Home Loan', debt_type: 'home_loan', balance: 500000, currency_code: 'AUD', is_active: true, masked_identifier: '****1234' }, trackA);
  const stmt = await insert('fdh_liability_statements', { user_id: A.id, liability_id: liab.id, statement_type: 'loan', facility_type: 'home_loan', currency_code: 'AUD', closing_balance: 495000, reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'pending' }, trackA);
  const approveR = await rpcAs(A.token, 'fdh10_approve_liability_statement', { p_statement_id: stmt.id });
  check('LIA-0 Real approve RPC succeeds for the owning user', approveR.json?.ok === true, JSON.stringify(approveR.json));

  const prop = await insert('fhip_import_proposals', { user_id: A.id, target_domain: 'liability', source_kind: 'loan_statement', currency_code: 'AUD', target_entity_id: liab.id, recommended_apply_mode: 'update_existing', status: 'ready' }, trackA);
  await insert('fhip_import_proposal_fields', { user_id: A.id, proposal_id: prop.id, field_name: 'balance', value_kind: 'money', proposed_value: '495000.00', existing_value: '500000.00' }, trackA);
  const apply1 = await rpcAs(A.token, 'fdh10_apply_liability_proposal', { p_proposal_id: prop.id, p_decision: 'update_existing', p_selected_fields: ['balance'] });
  check('LIA-1 Positive control: legitimate liability update_existing succeeds via real RPC', apply1.json?.ok === true, JSON.stringify(apply1.json));
  const liabAfter = (await svc('GET', `liabilities?id=eq.${liab.id}&select=balance,source_type`)).json?.[0];
  check('LIA-1b: balance updated to 495000, provenance stamped', Number(liabAfter?.balance) === 495000 && liabAfter?.source_type === 'liability_statement_import', JSON.stringify(liabAfter));

  // Provenance erase
  const forgePatch = await asUser(A.token, 'PATCH', `liabilities?id=eq.${liab.id}`, { source_type: 'manual' });
  const liabAfterForge = (await svc('GET', `liabilities?id=eq.${liab.id}&select=source_type`)).json?.[0];
  check('LIA-2 Provenance erase BLOCKED on liabilities.source_type', liabAfterForge?.source_type === liabAfter?.source_type, `patchStatus=${forgePatch.status}`);

  // Cross-tenant: Tenant B tries to apply Tenant A's liability proposal
  const bForeignApply = await rpcAs(B.token, 'fdh10_apply_liability_proposal', { p_proposal_id: prop.id, p_decision: 'update_existing', p_selected_fields: ['balance'] });
  check('LIA-3 Cross-tenant Apply BLOCKED (Tenant B cannot apply Tenant A\'s proposal)', bForeignApply.json?.ok === false, JSON.stringify(bForeignApply.json));

  console.log('  [Liability suite complete]');
}

// ===========================================================================
// CROSS-TENANT SWEEP
// ===========================================================================
async function crossTenantSweep(A, B) {
  console.log('\n--- CROSS-TENANT ISOLATION SWEEP ---');
  const aIncome = await insert('income_sources', { user_id: A.id, source_name: 'A private income', income_type: 'salary', amount: 1234, frequency: 'monthly', currency_code: 'AUD', is_active: true, owner: 'self' }, trackA);
  const payrollEvent = await insert('fdh_payroll_events', { user_id: A.id, country_code: 'AU', currency_code: 'AUD', net_pay: 1234, gross_pay: 1234, pay_frequency: 'monthly', pay_frequency_source: 'stated_on_payslip', reconciliation_status: 'reconciled', bank_match_status: 'not_attempted', review_status: 'resolved', approval_status: 'approved', approved_at: new Date().toISOString(), payslip_fingerprint: `${TAG}-payslip-xt` }, trackA);
  const aProp = await insert('fhip_import_proposals', { user_id: A.id, target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: payrollEvent.id, currency_code: 'AUD', target_entity_id: aIncome.id, recommended_apply_mode: 'update_existing', status: 'ready' }, trackA);
  await insert('fhip_import_proposal_fields', { user_id: A.id, proposal_id: aProp.id, field_name: 'amount', value_kind: 'money', proposed_value: '5000.00', existing_value: '1234.00' }, trackA);

  // B reads A's proposal via PostgREST (RLS)
  const bRead = await asUser(B.token, 'GET', `fhip_import_proposals?id=eq.${aProp.id}`);
  check('XT-1 Cross-tenant READ of proposal BLOCKED (RLS returns empty, not the row)', Array.isArray(bRead.json) && bRead.json.length === 0, JSON.stringify(bRead.json));

  // B tries to PATCH A's proposal (e.g. dismiss it)
  const bPatch = await asUser(B.token, 'PATCH', `fhip_import_proposals?id=eq.${aProp.id}`, { status: 'dismissed', dismissed_at: new Date().toISOString() });
  const aPropAfter = (await svc('GET', `fhip_import_proposals?id=eq.${aProp.id}&select=status`)).json?.[0];
  check('XT-2 Cross-tenant WRITE to proposal BLOCKED (status unchanged)', aPropAfter?.status === 'ready', `patchStatus=${bPatch.status} live=${aPropAfter?.status}`);

  // B tries to apply A's proposal via the real RPC
  const bApply = await rpcAs(B.token, 'fdh9_apply_income_proposal', { p_proposal_id: aProp.id, p_decision: 'update_existing', p_selected_fields: ['amount'] });
  check('XT-3 Cross-tenant APPLY BLOCKED via real RPC (PROPOSAL_NOT_FOUND, indistinguishable from nonexistent)', bApply.json?.ok === false && bApply.json?.code === 'PROPOSAL_NOT_FOUND', JSON.stringify(bApply.json));
  const aIncomeAfter = (await svc('GET', `income_sources?id=eq.${aIncome.id}&select=amount`)).json?.[0];
  check('XT-3b: Tenant A income unchanged after Tenant B\'s blocked attempt', Number(aIncomeAfter?.amount) === 1234, JSON.stringify(aIncomeAfter));

  // B tries to DELETE A's proposal
  const bDelete = await asUser(B.token, 'DELETE', `fhip_import_proposals?id=eq.${aProp.id}`);
  const aPropStillThere = (await svc('GET', `fhip_import_proposals?id=eq.${aProp.id}&select=id`)).json ?? [];
  check('XT-4 Cross-tenant DELETE BLOCKED (proposal still exists)', aPropStillThere.length === 1, `deleteStatus=${bDelete.status}`);

  // B forges own proposal with target_entity_id = A's income row (foreign canonical target, own-tenant proposal)
  const bPayroll = await insert('fdh_payroll_events', { user_id: B.id, country_code: 'AU', currency_code: 'AUD', net_pay: 999, gross_pay: 999, pay_frequency: 'monthly', pay_frequency_source: 'stated_on_payslip', reconciliation_status: 'reconciled', bank_match_status: 'not_attempted', review_status: 'resolved', approval_status: 'approved', approved_at: new Date().toISOString(), payslip_fingerprint: `${TAG}-payslip-b` }, trackB);
  const bForeignInsert = await asUser(B.token, 'POST', 'fhip_import_proposals', { user_id: B.id, target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: bPayroll.id, currency_code: 'AUD', target_entity_id: aIncome.id, recommended_apply_mode: 'update_existing', status: 'ready' });
  check('XT-5 Foreign canonical target BLOCKED at INSERT (Tenant B cannot even create a proposal naming Tenant A\'s income row as target)', bForeignInsert.status >= 400, `status=${bForeignInsert.status} body=${bForeignInsert.text.slice(0, 300)}`);

  console.log('  [Cross-tenant sweep complete]');
}

main().catch((e) => { console.error('UNCAUGHT:', e); process.exitCode = 9; });
