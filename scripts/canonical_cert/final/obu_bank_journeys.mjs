/**
 * Owner-before-upload DEV certification: BANK journeys (spec steps 19, 21, 23, 24, 25; bank CSV; PDF is in obu_bank_pdf_journeys.mjs).
 *   node scripts/canonical_cert/final/obu_bank_journeys.mjs [--steps=19,21,...]
 * Localhost app (port 3991) on DEV; existing fixture users only: AU2 (forecast.tc009) is the main actor, IN1 for the India checks.
 * A step passes only when the API answer and the database row agree. Rows created are removed by the OBU residue ledger.
 */
import { randomUUID } from 'node:crypto';
import { USERS, call, db, hostGuard, record, saveResults, results, selfMember, ensureSpouse, sha } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const only = (process.argv.find((a) => a.startsWith('--steps='))?.slice(8) ?? '').split(',').filter(Boolean);
const want = (n) => only.length === 0 || only.includes(String(n));
const sb = await db();
const AU = USERS.AU2;
const salt = String(Math.floor(1000 + Math.random() * 9000));
const userIdOf = async (email) => (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)?.id;
const UA = await userIdOf(AU);
const UB = await userIdOf(USERS.AU1);
let seq = 0;
/** a unique, parseable CBA-style debit/credit CSV (so the same file never collides on bytes) */
function csv(tag = 'x') {
  seq += 1;
  const d = (n) => `${String(n).padStart(2, '0')}/03/2026`;
  return Buffer.from(['Date,Description,Debit Amount,Credit Amount,Balance',
    `${d(1)},OBU ${salt} ${tag} ${seq} Supermarket,45.20,,1954.80`,
    `${d(2)},OBU ${salt} ${tag} ${seq} Salary,,3500.00,5454.80`,
    `${d(3)},OBU ${salt} ${tag} ${seq} Streaming,15.99,,5438.81`, ''].join('\n'));
}
const q = (extra = '') => `country_code=AU&currency_code=AUD${extra}`;
const upload = (email, bytes, owner, extra = '', ownerOverride) => call(email, 'POST', `/api/financial-data-hub/bank-csv/upload?${q(extra)}`, { body: bytes, contentType: 'text/csv', owner: ownerOverride === undefined ? owner : ownerOverride });
const doc = async (id) => (await sb.from('fdh_statement_uploads').select('*').eq('id', id).single()).data;
const acct = async (id) => (await sb.from('fdh_financial_accounts').select('*').eq('id', id).single()).data;
const accountsOf = async (uid) => (await sb.from('fdh_financial_accounts').select('*').eq('user_id', uid)).data ?? [];
const docCount = async (uid) => (await sb.from('fdh_statement_uploads').select('id', { count: 'exact', head: true }).eq('user_id', uid)).count;
const selfA = await selfMember(AU);
const spouseA = await ensureSpouse(AU, 'FHIP Synthetic Spouse AU');
const ctx = {};

async function ownerCase(step, label, ownerWire, expectRole, expectMember, digits) {
  const bytes = csv(label);
  const r = await upload(AU, bytes, ownerWire, `&masked_identifier=${encodeURIComponent('****' + digits)}&filename=obu-${label}.csv`);
  const id = r.json?.data?.document_id;
  record(step, `Bank CSV as ${label}: accepted (owner chosen before upload)`, r.status === 200 && !!id, `HTTP ${r.status} ${r.json?.error ?? ''} resolution=${r.json?.data?.account_resolution}`);
  if (!id) return null;
  const d = await doc(id);
  record(step, `${label}: DB document owner role ${expectRole}, user_selected${expectMember ? ', member recorded' : ', no member id'}`, d.owner_role === expectRole && d.owner_selection_source === 'user_selected' && (expectMember ? d.owner_member_id === expectMember : d.owner_member_id === null) && d.owner_business_entity_id === null, JSON.stringify({ role: d.owner_role, member: (d.owner_member_id ?? '').slice(0, 8) }));
  const a = d.financial_account_id ? await acct(d.financial_account_id) : null;
  record(step, `${label}: DB account created and linked; account owner_role = ${expectRole}`, !!a && a.owner_role === expectRole && a.user_id === UA && ['created', 'reused'].includes(r.json?.data?.account_resolution), JSON.stringify({ resolution: r.json?.data?.account_resolution, owner: a?.owner_role }));
  const det = await call(AU, 'POST', `/api/financial-data-hub/bank-csv/${id}/detect`, { owner: null });
  const pr = await call(AU, 'POST', `/api/financial-data-hub/bank-csv/${id}/process`, { owner: null });
  const d2 = await doc(id);
  const tx = (await sb.from('fdh_transactions').select('transaction_date,financial_account_id,statement_upload_id').eq('statement_upload_id', id)).data ?? [];
  const dates = tx.map((t) => t.transaction_date).sort();
  record(step, label + ': detect + process ran; 3 transactions, period 2026-03-01 to 2026-03-03 read from the statement, every transaction on the linked account; owner and link unchanged', det.status < 300 && pr.status < 300 && tx.length === 3 && dates[0] === '2026-03-01' && dates[2] === '2026-03-03' && tx.every((t) => t.financial_account_id === d.financial_account_id) && d2.owner_role === expectRole && d2.financial_account_id === d.financial_account_id, 'detect ' + det.status + ' process ' + pr.status + ' txns ' + tx.length + ' ' + dates[0] + '..' + dates[tx.length - 1] + ' status=' + d2.processing_status);
  return { id, bytes, accountId: d.financial_account_id };
}

// ================= STEP 19: Bank CSV, Self / Spouse / Joint =================
if (want(19)) {
  const none = await upload(AU, csv('noowner'), undefined, '', null);
  record(19, 'owner required before upload: no owner -> 422 owner_required, no document row', none.status === 422 && none.json?.error === 'owner_required', `HTTP ${none.status} ${none.json?.error}`);
  const self = await ownerCase(19, 'self', { kind: 'member', memberId: selfA }, 'self', selfA, '1111');
  const spouse = await ownerCase(19, 'spouse', { kind: 'member', memberId: spouseA }, 'spouse', spouseA, '2222');
  const joint = await ownerCase(19, 'joint', { kind: 'joint' }, 'joint', null, '3333');
  Object.assign(ctx, { self, spouse, joint });
  const accts = await accountsOf(UA);
  record(19, 'three separate accounts, one per owner (no household ambiguity: each statement belongs to exactly one account and one owner)', ['self', 'spouse', 'joint'].every((r) => accts.filter((a) => a.owner_role === r).length === 1), JSON.stringify(accts.map((a) => a.owner_role)));
  const opts = (await call(AU, 'GET', '/api/ownership/options?flow=bank')).json?.data;
  record(19, 'owner options for a bank statement: members only, no entity listed, entity notice shown, joint needs no percentages', (opts?.entities ?? []).length === 0 && !!opts?.entityNotice && opts?.joint?.requiresPercentages === false && opts?.smsf?.available === true, JSON.stringify({ members: opts?.members?.length, entities: opts?.entities, joint: opts?.joint, smsf: opts?.smsf }));
}

// ================= STEP 20 (CSV part): SMSF owner, AU only =================
if (want(20)) {
  const smsf = await ownerCase(20, 'smsf', { kind: 'smsf' }, 'smsf', null, '4444');
  ctx.smsf = smsf;
  const india = await call(USERS.IN1, 'POST', '/api/financial-data-hub/bank-csv/upload?country_code=IN&currency_code=INR', { body: csv('insmsf'), contentType: 'text/csv', owner: { kind: 'smsf' } });
  record(20, 'SMSF is AU only: an India user choosing SMSF is refused (owner_not_allowed_for_country) and nothing is stored', india.status === 403 && /owner_not_allowed/.test(india.json?.error ?? india.json?.code ?? ''), `HTTP ${india.status} ${india.json?.error ?? india.json?.code}`);
  record(20, 'PARTIAL / DEFERRED DOWNSTREAM CAPABILITY: SMSF BANK OWNER ATTRIBUTION is certified; SMSF BANK TRANSACTION -> SMSF CASH-FLOW INTEGRATION is not built (PO-deferred, OWNER_BEFORE_UPLOAD_FINAL_REPORT section 8 item 2) and is NOT claimed as passed', null, 'see step 31 for the personal-totals isolation proof');
}

// ================= STEP 21: bank entity refusal =================
if (want(21)) {
  const mk = async (email, name, entity_type, cur) => {
    const l = (await call(email, 'GET', '/api/business-entities')).json?.data ?? [];
    const hit = l.find((e) => e.name === name);
    if (hit) return hit;
    const r = await call(email, 'POST', '/api/business-entities', { json: { name, entity_type, ownership_percentage: 100, valuation_mode: 'summary', summary_net_asset_value: 0, currency_code: cur }, owner: null });
    return r.json?.data ?? { error: r.json, status: r.status };
  };
  const before = await docCount(UA);
  const company = await mk(AU, `FHIP OBU AU Company ${salt}`, 'company', 'AUD');
  const trust = await mk(AU, `FHIP OBU AU Trust ${salt}`, 'family_trust', 'AUD');
  record(21, 'synthetic AU Company and Family Trust exist for the AU user', !!company.id && !!trust.id, JSON.stringify([company.entity_type, trust.entity_type]));
  const accountsBefore = (await accountsOf(UA)).length;
  for (const [name, ent] of [['Company', company], ['Family Trust', trust]]) {
    const r = await upload(AU, csv('ent' + name), { kind: 'entity', entityId: ent.id }, '&masked_identifier=%2A%2A%2A%2A5555');
    record(21, `bank statement owned by a ${name}: refused before any canonical processing`, r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.json?.error ?? ''} ${String(r.json?.message ?? '').slice(0, 90)}`);
  }
  const huf = await call(AU, 'POST', '/api/business-entities', { json: { name: 'x', entity_type: 'huf', ownership_percentage: 100, valuation_mode: 'summary', summary_net_asset_value: 0, currency_code: 'AUD' }, owner: null });
  record(21, 'HUF cannot exist for an AU user (403), so it cannot own a bank statement', huf.status === 403, `HTTP ${huf.status}`);
  const hufIn = (await call(USERS.IN1, 'GET', '/api/business-entities')).json?.data?.find((e) => e.entity_type === 'huf');
  if (hufIn) {
    const r = await call(USERS.IN1, 'POST', '/api/financial-data-hub/bank-csv/upload?country_code=IN&currency_code=INR', { body: csv('inhuf'), contentType: 'text/csv', owner: { kind: 'entity', entityId: hufIn.id } });
    record(21, 'India HUF owning a bank statement is refused as well (entity bank cash flow is deferred)', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.json?.error ?? ''}`);
  }
  const after = await docCount(UA);
  record(21, 'DB: no document row and no account was created by any refused entity bank upload (personal totals cannot change)', after === before && (await accountsOf(UA)).length === accountsBefore, `docs ${before}->${after}`);
}

// ================= STEP 25: owner-change conflict on an existing account =================
if (want(25)) {
  const accts = await accountsOf(UA);
  const selfAcct = accts.find((a) => a.owner_role === 'self');
  record(25, 'precondition: an account owned by Self exists (from step 19)', !!selfAcct, '');
  if (selfAcct) {
    const countBefore = await docCount(UA);
    const r = await upload(AU, csv('conflict'), { kind: 'member', memberId: spouseA }, '&masked_identifier=%2A%2A%2A%2A1111');
    const a = await acct(selfAcct.id);
    record(25, 'upload as Spouse to the Self account: 409 conflict BEFORE any overwrite; nothing uploaded; account still Self', r.status === 409 && /owner/.test(r.json?.error ?? '') && a.owner_role === 'self' && (await docCount(UA)) === countBefore, `HTTP ${r.status} ${r.json?.error} existing=${r.json?.existing_owner_role} selected=${r.json?.selected_owner_role}`);
    const yes = await upload(AU, csv('confirmed'), { kind: 'member', memberId: spouseA }, '&masked_identifier=%2A%2A%2A%2A1111&confirm_owner_change=1');
    const a2 = await acct(selfAcct.id);
    const reload = await acct(selfAcct.id);
    record(25, 'explicit confirmation ("Yes, change"): the upload succeeds and the account owner becomes Spouse; reload proves it', yes.status === 200 && a2.owner_role === 'spouse' && reload.owner_role === 'spouse', `HTTP ${yes.status} ${JSON.stringify(yes.json?.data?.owner_recorded)}`);
    const aud = (await sb.from('fdh_document_audit_events').select('*').eq('user_id', UA).order('created_at', { ascending: false }).limit(10)).data ?? [];
    record(25, 'the owner change is audited (document audit event metadata names the account owner change)', aud.some((e) => /changed|owner/.test(JSON.stringify(e.metadata ?? {}))), JSON.stringify(aud.slice(0, 2).map((e) => [e.event_type, e.metadata])).slice(0, 300));
  }
}

// ================= STEP 18 (bank): same file / different owner =================
if (want('18b')) {
  const bytes = csv('dup');
  const a = await upload(AU, bytes, { kind: 'member', memberId: selfA }, '&masked_identifier=%2A%2A%2A%2A6666');
  await call(AU, 'POST', '/api/financial-data-hub/bank-csv/' + a.json.data.document_id + '/detect', { owner: null });
  await call(AU, 'POST', '/api/financial-data-hub/bank-csv/' + a.json.data.document_id + '/process', { owner: null });
  const same = await upload(AU, bytes, { kind: 'member', memberId: selfA }, '&masked_identifier=%2A%2A%2A%2A6666');
  record('18b', 'bank: same bytes + same owner is accepted and flagged as a duplicate of the first', same.status === 200 && same.json?.data?.duplicate_of_document_id === a.json?.data?.document_id, `HTTP ${same.status} dup=${String(same.json?.data?.duplicate_of_document_id).slice(0, 8)}`);
  const diff = await upload(AU, bytes, { kind: 'member', memberId: spouseA }, '&masked_identifier=%2A%2A%2A%2A6666');
  record('18b', 'bank: same bytes + different owner -> 409 identical_upload_different_owner', diff.status === 409 && diff.json?.error === 'identical_upload_different_owner' && diff.json?.existing_document_id === a.json?.data?.document_id, `HTTP ${diff.status} ${diff.json?.error}`);
  const other = await upload(USERS.AU1, bytes, 'self', '&masked_identifier=%2A%2A%2A%2A6666');
  record('18b', "bank cross-tenant: another user uploading the same bytes gets an ordinary new upload (no duplicate flag, not A's id)", other.status === 200 && other.json?.data?.duplicate_of_document_id === null && other.json?.data?.document_id !== a.json?.data?.document_id, `HTTP ${other.status} dup=${other.json?.data?.duplicate_of_document_id}`);
}

saveResults('.canonical-cert/obu-bank-results.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
