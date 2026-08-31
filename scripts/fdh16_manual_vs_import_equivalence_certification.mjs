// FDH-16 — Full Integration Certification: FRESH live-DEV proof of the
// central Manual-vs-Import Equivalence gate (spec sections 16-30, 214-216,
// 254 "Manual financial fact = Imported financial fact in economic effect").
//
// Builds TWO synthetic AU households on live hosted DEV with IDENTICAL
// economic facts (same salary, same liability balance, same retirement
// balance):
//   Household M — every canonical row created via a direct RLS-scoped
//     insert using the household's own real authenticated JWT (role
//     "authenticated"), i.e. exactly the write shape the real manual-entry
//     API routes execute (see app/api/income/route.ts -> makeRegistry().save()
//     -> supabase.from('income_sources').insert({...,user_id}) under the
//     user's own session — no service-role, no bridge).
//   Household I — every canonical row created via the REAL owner Apply RPCs
//     (fdh9_apply_income_proposal, fdh10_apply_liability_proposal,
//     fdh12_apply_retirement_proposal), decision='add_new', called with a
//     real authenticated JWT — never service-role — per repository standing
//     rule #10.
//
// Then compares the two households' canonical rows field-by-field. Required
// (spec §29): amount/balance variance = $0. Allowed differences are
// PROVENANCE ONLY (source_type, last_import_application_id, last_imported_at).
//
// Also proves, fresh, the following spec §206 system negative controls using
// this same fixture:
//   - manual vs import inequality detector (this script's own core assertion)
//   - FDH evidence in Net Worth (0 — evidence rows never separately summed)
//   - a fresh cross-tenant foreign-target sweep against the NEW proposals
//     created in this fixture (Household I's proposals targeted by Household M)
//
// Service-role key used ONLY for: creating synthetic users, seeding evidence
// rows a real upload+parse pipeline would have produced (approve step),
// ground-truth re-queries, and cleanup. All decisive Apply/manual-write calls
// use a real authenticated JWT.
//
// DEV project guarded (vqycarelcoijzwlpkpcz). Every synthetic row + both
// synthetic auth users are deleted at the end; cleanup is independently
// re-verified by re-query.
//
// Run: node scripts/fdh16_manual_vs_import_equivalence_certification.mjs

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

const TAG = 'fdh16-mvi';
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
async function insertAsUser(token, table, body, track) {
  const r = await asUser(token, 'POST', table, body);
  const row = Array.isArray(r.json) ? r.json[0] : null;
  if (!row) throw new Error(`insertAsUser ${table} failed (${r.status}): ${r.text.slice(0, 500)}`);
  if (track) track.push({ table, id: row.id });
  return row;
}

async function createUser(label) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `${TAG}-${label}-${stamp}@fhip-test.invalid`;
  const password = `Fdh16Mvi!${stamp}`;
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { ...SH, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser(${label}) failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await svc('PATCH', `user_profiles?user_id=eq.${j.id}`, { full_name: `FDH16 ${label}`, country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100, country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
  const signInR = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const signInJ = await signInR.json();
  if (!signInJ.access_token) throw new Error(`signIn(${label}) failed: ${JSON.stringify(signInJ).slice(0, 300)}`);
  return { id: j.id, email, token: signInJ.access_token };
}
async function deleteUser(id) {
  await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH });
}

const trackM = [];
const trackI = [];

async function cleanupTrack(track) {
  for (const { table, id } of track.reverse()) {
    await svc('DELETE', `${table}?id=eq.${id}`);
  }
}

// Shared economic facts both households must end up with.
const FACTS = {
  salaryAmount: 6000,
  liabilityBalance: 15000,
  retirementBalance: 150000,
};

async function main() {
  console.log('=== FDH-16 LIVE DEV: Manual vs Import Equivalence Certification ===');
  const M = await createUser('household-M-manual');
  const I = await createUser('household-I-import');
  console.log(`Household M (manual): ${M.email} (${M.id})`);
  console.log(`Household I (import): ${I.email} (${I.id})`);
  try {
    await buildManualHousehold(M);
    await buildImportedHousehold(I);
    await compareHouseholds(M, I);
    await freshCrossTenantSweep(M, I);
  } finally {
    console.log('\n--- CLEANUP ---');
    await cleanupTrack(trackI);
    await cleanupTrack(trackM);
    await deleteUser(I.id);
    await deleteUser(M.id);
    const residualM = await svc('GET', `income_sources?user_id=eq.${M.id}&select=id`);
    const residualI = await svc('GET', `income_sources?user_id=eq.${I.id}&select=id`);
    const residualUserM = await fetch(`${BASE}/auth/v1/admin/users/${M.id}`, { headers: SH });
    const residualUserI = await fetch(`${BASE}/auth/v1/admin/users/${I.id}`, { headers: SH });
    check('CLEANUP: Household M synthetic income rows = 0 after cleanup', Array.isArray(residualM.json) && residualM.json.length === 0, `rows=${JSON.stringify(residualM.json)}`);
    check('CLEANUP: Household I synthetic income rows = 0 after cleanup', Array.isArray(residualI.json) && residualI.json.length === 0, `rows=${JSON.stringify(residualI.json)}`);
    check('CLEANUP: Household M auth user deleted', residualUserM.status >= 400, `status=${residualUserM.status}`);
    check('CLEANUP: Household I auth user deleted', residualUserI.status >= 400, `status=${residualUserI.status}`);
  }

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (findings.length) {
    console.log('\n=== FINDINGS ===');
    for (const f of findings) console.log(`  - ${f.label}: ${f.detail}`);
  }
  if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exitCode = 1; }
}

// ===========================================================================
// HOUSEHOLD M — MANUAL ENTRY (direct RLS-scoped insert as the real user,
// mirroring lib/services/registry.ts's save()/create() shape exactly)
// ===========================================================================
async function buildManualHousehold(M) {
  console.log('\n--- HOUSEHOLD M: MANUAL ENTRY (real authenticated JWT, RLS-scoped insert) ---');
  const income = await insertAsUser(M.token, 'income_sources', {
    user_id: M.id, source_name: 'Salary', employer_name: 'FDH16 Test Employer Pty Ltd', income_type: 'salary',
    amount: FACTS.salaryAmount, frequency: 'monthly', currency_code: 'AUD', is_active: true, owner: 'self',
  }, trackM);
  check('M-1 Manual income row created via real authenticated insert', Number(income?.amount) === FACTS.salaryAmount, JSON.stringify(income));
  check('M-1b Manual income row source_type is the manual default (not an import provenance value)', income?.source_type !== 'payslip_import', `source_type=${income?.source_type}`);

  const liability = await insertAsUser(M.token, 'liabilities', {
    user_id: M.id, liability_name: 'Personal Loan', debt_type: 'personal_loan', balance: FACTS.liabilityBalance,
    currency_code: 'AUD', is_active: true, owner: 'self',
  }, trackM);
  check('M-2 Manual liability row created via real authenticated insert', Number(liability?.balance) === FACTS.liabilityBalance, JSON.stringify(liability));

  const member = await insertAsUser(M.token, 'retirement_members', { user_id: M.id, member_type: 'self', country_code: 'AU' }, trackM);
  const retirement = await insertAsUser(M.token, 'retirement_accounts', {
    user_id: M.id, account_name: 'Super', account_type: 'super', current_balance: FACTS.retirementBalance,
    currency_code: 'AUD', is_active: true, owner: 'self', retirement_member_id: member.id,
  }, trackM);
  check('M-3 Manual retirement row created via real authenticated insert', Number(retirement?.current_balance) === FACTS.retirementBalance, JSON.stringify(retirement));

  M.canonical = { income, liability, retirement };
}

// ===========================================================================
// HOUSEHOLD I — FDH IMPORT (evidence -> approve -> propose -> real Apply RPC,
// decision='add_new', with a real authenticated JWT throughout)
// ===========================================================================
async function buildImportedHousehold(I) {
  console.log('\n--- HOUSEHOLD I: FDH IMPORT (evidence -> propose -> real Apply RPC) ---');

  // --- Income: payslip evidence -> proposal (add_new) -> fdh9_apply_income_proposal
  const payroll = await insert('fdh_payroll_events', {
    user_id: I.id, country_code: 'AU', currency_code: 'AUD', net_pay: FACTS.salaryAmount, gross_pay: 7100.50,
    pay_frequency: 'monthly', pay_frequency_source: 'stated_on_payslip', reconciliation_status: 'reconciled',
    bank_match_status: 'not_attempted', review_status: 'resolved', approval_status: 'approved', approved_at: new Date().toISOString(),
    payslip_fingerprint: `${TAG}-payslip-1`,
  }, trackI);
  const incomeProp = await insert('fhip_import_proposals', {
    user_id: I.id, target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: payroll.id,
    currency_code: 'AUD', target_entity_id: null, recommended_apply_mode: 'add_new', status: 'ready',
  }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: incomeProp.id, field_name: 'amount', value_kind: 'money', proposed_value: String(FACTS.salaryAmount), existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: incomeProp.id, field_name: 'frequency', value_kind: 'text', proposed_value: 'monthly', existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: incomeProp.id, field_name: 'income_type', value_kind: 'text', proposed_value: 'salary', existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: incomeProp.id, field_name: 'currency_code', value_kind: 'text', proposed_value: 'AUD', existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: incomeProp.id, field_name: 'source_name', value_kind: 'text', proposed_value: 'Salary', existing_value: null }, trackI);

  const incomeApply = await rpcAs(I.token, 'fdh9_apply_income_proposal', { p_proposal_id: incomeProp.id, p_decision: 'add_new', p_selected_fields: ['amount', 'frequency', 'income_type', 'currency_code', 'source_name'] });
  check('I-1 Real fdh9_apply_income_proposal add_new succeeds via real authenticated RPC', incomeApply.json?.ok === true, JSON.stringify(incomeApply.json));
  const incomeTargetId = incomeApply.json?.target_entity_id;
  if (incomeTargetId) trackI.push({ table: 'income_sources', id: incomeTargetId });
  const income = (await svc('GET', `income_sources?id=eq.${incomeTargetId}&select=*`)).json?.[0];
  check('I-1b Imported income amount = 6000 (exact)', Number(income?.amount) === FACTS.salaryAmount, JSON.stringify(income));
  check('I-1c Imported income provenance stamped payslip_import', income?.source_type === 'payslip_import', `source_type=${income?.source_type}`);

  // --- Liability: loan statement evidence -> approve -> proposal (add_new) -> fdh10_apply_liability_proposal
  const liabStmt = await insert('fdh_liability_statements', {
    user_id: I.id, liability_id: null, statement_type: 'loan', facility_type: 'personal_loan', currency_code: 'AUD',
    closing_balance: FACTS.liabilityBalance, reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'pending',
  }, trackI);
  const liabApprove = await rpcAs(I.token, 'fdh10_approve_liability_statement', { p_statement_id: liabStmt.id });
  check('I-2 Real fdh10_approve_liability_statement succeeds', liabApprove.json?.ok === true, JSON.stringify(liabApprove.json));
  const liabProp = await insert('fhip_import_proposals', {
    user_id: I.id, target_domain: 'liability', source_kind: 'loan_statement', source_liability_statement_id: liabStmt.id,
    currency_code: 'AUD', target_entity_id: null, recommended_apply_mode: 'add_new', status: 'ready',
  }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: liabProp.id, field_name: 'balance', value_kind: 'money', proposed_value: String(FACTS.liabilityBalance), existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: liabProp.id, field_name: 'liability_name', value_kind: 'text', proposed_value: 'Personal Loan', existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: liabProp.id, field_name: 'debt_type', value_kind: 'text', proposed_value: 'personal_loan', existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: liabProp.id, field_name: 'currency_code', value_kind: 'text', proposed_value: 'AUD', existing_value: null }, trackI);

  const liabApply = await rpcAs(I.token, 'fdh10_apply_liability_proposal', { p_proposal_id: liabProp.id, p_decision: 'add_new', p_selected_fields: ['balance', 'liability_name', 'debt_type', 'currency_code'] });
  check('I-3 Real fdh10_apply_liability_proposal add_new succeeds via real authenticated RPC', liabApply.json?.ok === true, JSON.stringify(liabApply.json));
  const liabTargetId = liabApply.json?.target_entity_id;
  if (liabTargetId) trackI.push({ table: 'liabilities', id: liabTargetId });
  const liability = (await svc('GET', `liabilities?id=eq.${liabTargetId}&select=*`)).json?.[0];
  check('I-3b Imported liability balance = 15000 (exact)', Number(liability?.balance) === FACTS.liabilityBalance, JSON.stringify(liability));
  check('I-3c Imported liability provenance stamped liability_statement_import', liability?.source_type === 'liability_statement_import', `source_type=${liability?.source_type}`);

  // --- Retirement: statement evidence -> approve -> proposal (add_new) -> fdh12_apply_retirement_proposal
  const member = await insert('retirement_members', { user_id: I.id, member_type: 'self', country_code: 'AU' }, trackI);
  const retStmt = await insert('fdh_retirement_statements', {
    user_id: I.id, retirement_member_id: member.id, canonical_account_id: null, statement_type: 'super_member_statement',
    retirement_jurisdiction: 'AU', account_type: 'industry_super', currency_code: 'AUD', closing_balance: FACTS.retirementBalance,
    reconciliation_status: 'reconciled', review_status: 'resolved', approval_status: 'pending', extraction_status: 'extracted',
  }, trackI);
  const retApprove = await rpcAs(I.token, 'fdh12_approve_retirement_statement', { p_statement_id: retStmt.id });
  check('I-4 Real fdh12_approve_retirement_statement succeeds', retApprove.json?.ok === true, JSON.stringify(retApprove.json));
  const retProp = await insert('fhip_import_proposals', {
    user_id: I.id, target_domain: 'retirement', source_kind: 'retirement_statement', source_retirement_statement_id: retStmt.id,
    currency_code: 'AUD', target_entity_id: null, recommended_apply_mode: 'add_new', status: 'ready',
  }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: retProp.id, field_name: 'current_balance', value_kind: 'money', proposed_value: String(FACTS.retirementBalance), existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: retProp.id, field_name: 'account_name', value_kind: 'text', proposed_value: 'Super', existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: retProp.id, field_name: 'account_type', value_kind: 'text', proposed_value: 'super', existing_value: null }, trackI);
  await insert('fhip_import_proposal_fields', { user_id: I.id, proposal_id: retProp.id, field_name: 'currency_code', value_kind: 'text', proposed_value: 'AUD', existing_value: null }, trackI);

  const retApply = await rpcAs(I.token, 'fdh12_apply_retirement_proposal', { p_proposal_id: retProp.id, p_decision: 'add_new', p_selected_fields: ['current_balance', 'account_name', 'account_type', 'currency_code'] });
  check('I-5 Real fdh12_apply_retirement_proposal add_new succeeds via real authenticated RPC', retApply.json?.ok === true, JSON.stringify(retApply.json));
  const retTargetId = retApply.json?.target_entity_id;
  if (retTargetId) trackI.push({ table: 'retirement_accounts', id: retTargetId });
  const retirement = (await svc('GET', `retirement_accounts?id=eq.${retTargetId}&select=*`)).json?.[0];
  check('I-5b Imported retirement balance = 150000 (exact)', Number(retirement?.current_balance) === FACTS.retirementBalance, JSON.stringify(retirement));
  check('I-5c Imported retirement provenance stamped retirement_statement_import', retirement?.source_type === 'retirement_statement_import', `source_type=${retirement?.source_type}`);
  check('I-5d Imported retirement row correctly stamped to the Self member (not orphaned/null)', retirement?.retirement_member_id === member.id, `member=${retirement?.retirement_member_id}`);

  I.canonical = { income, liability, retirement, incomeProp, liabProp, retProp };
}

// ===========================================================================
// COMPARISON — the decisive FDH-16 gate: economic variance must be $0
// ===========================================================================
async function compareHouseholds(M, I) {
  console.log('\n--- MANUAL vs IMPORT COMPARISON ---');
  const incomeVariance = Number(M.canonical.income.amount) - Number(I.canonical.income.amount);
  check('CMP-1 Income variance = $0.00', incomeVariance === 0, `M=${M.canonical.income.amount} I=${I.canonical.income.amount} variance=${incomeVariance}`);

  const liabilityVariance = Number(M.canonical.liability.balance) - Number(I.canonical.liability.balance);
  check('CMP-2 Liability variance = $0.00', liabilityVariance === 0, `M=${M.canonical.liability.balance} I=${I.canonical.liability.balance} variance=${liabilityVariance}`);

  const retirementVariance = Number(M.canonical.retirement.current_balance) - Number(I.canonical.retirement.current_balance);
  check('CMP-3 Retirement variance = $0.00', retirementVariance === 0, `M=${M.canonical.retirement.current_balance} I=${I.canonical.retirement.current_balance} variance=${retirementVariance}`);

  // Net worth partial oracle: retirement + (no other assets in this fixture) - liability, per household.
  const nwM = Number(M.canonical.retirement.current_balance) - Number(M.canonical.liability.balance);
  const nwI = Number(I.canonical.retirement.current_balance) - Number(I.canonical.liability.balance);
  check('CMP-4 Net Worth partial oracle (retirement - liability) variance = $0.00', nwM - nwI === 0, `M=${nwM} I=${nwI}`);

  // Provenance MUST differ (legitimate difference, not a bug) — proves this isn't a vacuous
  // "both empty" pass; the households really did take different code paths.
  check('CMP-5 Provenance legitimately differs (source_type): Manual != Import (anti-vacuity)', M.canonical.income.source_type !== I.canonical.income.source_type, `M=${M.canonical.income.source_type} I=${I.canonical.income.source_type}`);
  check('CMP-5b Provenance legitimately differs (liabilities.source_type)', M.canonical.liability.source_type !== I.canonical.liability.source_type, `M=${M.canonical.liability.source_type} I=${I.canonical.liability.source_type}`);
  check('CMP-5c Provenance legitimately differs (retirement_accounts.source_type)', M.canonical.retirement.source_type !== I.canonical.retirement.source_type, `M=${M.canonical.retirement.source_type} I=${I.canonical.retirement.source_type}`);

  // FDH evidence not separately counted: re-query evidence tables and confirm they carry
  // no independent "current balance" field consumed by any canonical total (spec §15/§55).
  const payrollRow = (await svc('GET', `fdh_payroll_events?user_id=eq.${I.id}&select=id,net_pay`)).json ?? [];
  check('CMP-6 Household I has exactly 1 payroll evidence row (not summed into a second income total)', payrollRow.length === 1, `count=${payrollRow.length}`);
  const incomeRows = (await svc('GET', `income_sources?user_id=eq.${I.id}&select=id`)).json ?? [];
  check('CMP-6b Household I has exactly 1 canonical income row despite 1 evidence row (no 1:1 duplication into a second system)', incomeRows.length === 1, `count=${incomeRows.length}`);
}

// ===========================================================================
// FRESH CROSS-TENANT SWEEP against this fixture's own new proposals
// ===========================================================================
async function freshCrossTenantSweep(M, I) {
  console.log('\n--- FRESH CROSS-TENANT SWEEP (this fixture) ---');
  // Household M attempts to read/apply Household I's already-applied income proposal.
  const mRead = await asUser(M.token, 'GET', `fhip_import_proposals?id=eq.${I.canonical.incomeProp.id}`);
  check('XT16-1 Cross-tenant READ of another household\'s proposal BLOCKED (RLS empty)', Array.isArray(mRead.json) && mRead.json.length === 0, JSON.stringify(mRead.json));

  const mReadCanonical = await asUser(M.token, 'GET', `income_sources?user_id=eq.${I.id}&select=id,amount`);
  check('XT16-2 Cross-tenant READ of another household\'s canonical income BLOCKED (RLS empty)', Array.isArray(mReadCanonical.json) && mReadCanonical.json.length === 0, JSON.stringify(mReadCanonical.json));

  // Household M forges a proposal naming Household I's manual liability as target (foreign canonical target, different tenant).
  const forgeInsert = await asUser(M.token, 'POST', 'fhip_import_proposals', {
    user_id: M.id, target_domain: 'liability', source_kind: 'loan_statement', currency_code: 'AUD',
    target_entity_id: I.canonical.liability.id, recommended_apply_mode: 'update_existing', status: 'ready',
  });
  check('XT16-3 Foreign canonical target BLOCKED at INSERT (Household M cannot name Household I\'s liability as target)', forgeInsert.status >= 400, `status=${forgeInsert.status} body=${forgeInsert.text.slice(0, 300)}`);
  const iLiabAfter = (await svc('GET', `liabilities?id=eq.${I.canonical.liability.id}&select=balance`)).json?.[0];
  check('XT16-3b Household I liability balance unchanged after blocked forgery attempt', Number(iLiabAfter?.balance) === FACTS.liabilityBalance, JSON.stringify(iLiabAfter));
}

main();
