/**
 * Owner-before-upload DEV certification: PHASE 2 routes (spec step 26): payslip, liability, retirement, AU investment, generic upload sessions.
 *   npx tsx scripts/canonical_cert/final/obu_phase2_journeys.mjs
 * Actor AU3 = forecast.tc015 (ledger OBU3; has Self + a real Spouse), attacker AU4 = forecast.tc024. Localhost app on port 3991, DEV only.
 * For each route: no owner -> refused; valid owner -> accepted and stored on the document; an owner changed between upload and Accept/Apply -> 409;
 * another tenant's owner -> refused (owner_not_found); the canonical write happens exactly once.
 */
import { randomUUID } from 'node:crypto';
import { payslipPdf, creditCardStatement, retirementSummaryStatement, brokerTransactionStatement, parseMonth } from '../documents/builders.ts';
import { call, db, hostGuard, record, saveResults, results, selfMember, ensureSpouse } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const sb = await db();
const AU3 = 'forecast.tc015@example.test';
const AU4 = 'forecast.tc024@example.test';
const users = (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users;
const U3 = users.find((u) => u.email === AU3).id;
const self3 = await selfMember(AU3);
const spouse3 = await ensureSpouse(AU3, 'FHIP Synthetic Spouse AU3');
const self4 = await selfMember(AU4);
const MEMBER = (id) => ({ kind: 'member', memberId: id });
const month = parseMonth('2026-08');
const salt = 'P2' + String(Math.floor(100 + Math.random() * 900));
const doc = async (id) => (await sb.from('fdh_statement_uploads').select('*').eq('id', id).single()).data;
const qs = (query, owner) => new URLSearchParams({ ...query, ...(owner ? { owner: JSON.stringify(owner) } : {}) }).toString();
const apply = (route, body) => call(AU3, 'POST', route, { json: body, owner: null });

// ================= PAYSLIP (upload-sessions -> complete -> process -> approve -> proposal -> apply) =================
{
  const p = payslipPdf(month, salt);
  const sessionBody = (owner) => ({ document_type: 'payslip', source_type: 'pdf_native', country_code: 'AU', declared_mime_type: 'application/pdf', declared_file_size_bytes: p.bytes.length, ...(owner ? { owner } : {}) });
  const none = await call(AU3, 'POST', '/api/financial-data-hub/documents/upload-sessions', { json: sessionBody(null), owner: null });
  record(26, 'payslip: no owner -> 422 owner_required (no session opened)', none.status === 422 && none.json?.error === 'owner_required', `HTTP ${none.status} ${none.json?.error}`);
  const foreign = await call(AU4, 'POST', '/api/financial-data-hub/documents/upload-sessions', { json: sessionBody(MEMBER(spouse3)), owner: null });
  record(26, "payslip: another tenant's member as the owner -> refused owner_not_found", foreign.status >= 400 && foreign.json?.error === 'owner_not_found', `HTTP ${foreign.status} ${foreign.json?.error}`);
  const s = await call(AU3, 'POST', '/api/financial-data-hub/documents/upload-sessions', { json: sessionBody(MEMBER(spouse3)), owner: null });
  record(26, 'payslip: valid owner (Spouse) accepted, session opened', s.status < 300 && !!s.json?.data?.session_id, `HTTP ${s.status}`);
  const c = await call(AU3, 'POST', `/api/financial-data-hub/documents/upload-sessions/${s.json.data.session_id}/complete`, { body: Buffer.from(p.bytes), contentType: 'application/pdf', owner: null });
  const id = c.json?.data?.document_id;
  const d = await doc(id);
  record(26, 'payslip: DB document stores the chosen owner (spouse / user_selected / member)', d.owner_role === 'spouse' && d.owner_member_id === spouse3 && d.owner_selection_source === 'user_selected', JSON.stringify({ role: d.owner_role }));
  await call(AU3, 'POST', `/api/financial-data-hub/payslip/${id}/process`, { owner: null });
  const wrong = await call(AU3, 'POST', `/api/financial-data-hub/payslip/${id}/approve`, { json: { income_owner: 'self', acknowledge_review: true, replaces_earlier: false }, owner: null });
  record(26, 'payslip: owner changed between upload and Approve (Self vs Spouse) -> 409 owner_differs_from_upload', wrong.status === 409 && wrong.json?.code === 'owner_differs_from_upload', `HTTP ${wrong.status} ${wrong.json?.code}`);
  const ok = await call(AU3, 'POST', `/api/financial-data-hub/payslip/${id}/approve`, { json: { acknowledge_review: true, replaces_earlier: false }, owner: null });
  const pr = await call(AU3, 'POST', `/api/financial-data-hub/payslip/${id}/proposal`, { owner: null });
  const fields = (pr.json?.data?.fields ?? []).filter((f) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value).map((f) => f.field_name);
  const proposalId = pr.json?.data?.proposal_id;
  const before = (await sb.from('income_sources').select('id,owner').eq('user_id', U3)).data ?? [];
  const a1 = await apply(`/api/financial-data-hub/income-proposals/${proposalId}/apply`, { decision: 'add_new', selectedFields: fields });
  const a2 = await apply(`/api/financial-data-hub/income-proposals/${proposalId}/apply`, { decision: 'add_new', selectedFields: fields });
  const after = (await sb.from('income_sources').select('id,owner').eq('user_id', U3)).data ?? [];
  const created = after.filter((r) => !before.some((b) => b.id === r.id));
  record(26, 'payslip: approve without an owner takes the document\'s; Apply writes exactly ONE income source, owned by the Spouse; a repeat Apply is ALREADY_APPLIED', ok.status === 200 && a1.status === 200 && a2.status === 409 && created.length === 1 && created[0].owner === 'spouse', `approve ${ok.status} apply ${a1.status}/${a2.status} created=${JSON.stringify(created)}`);
}

// ================= LIABILITY (credit card CSV) =================
{
  const cc = creditCardStatement(month, salt);
  const route = '/api/financial-data-hub/liability-statement/upload';
  const q = { ...cc.upload.query, filename: cc.filename };
  const none = await call(AU3, 'POST', `${route}?${qs(q)}`, { body: Buffer.from(cc.bytes), contentType: 'text/csv', owner: null });
  record(26, 'liability: no owner -> 422 owner_required', none.status === 422 && none.json?.error === 'owner_required', `HTTP ${none.status} ${none.json?.error}`);
  const foreign = await call(AU4, 'POST', `${route}?${qs(q, MEMBER(spouse3))}`, { body: Buffer.from(cc.bytes), contentType: 'text/csv', owner: null });
  record(26, "liability: another tenant's member as owner -> refused owner_not_found", foreign.status >= 400 && foreign.json?.error === 'owner_not_found', `HTTP ${foreign.status} ${foreign.json?.error}`);
  const up = await call(AU3, 'POST', `${route}?${qs(q, MEMBER(spouse3))}`, { body: Buffer.from(cc.bytes), contentType: 'text/csv', owner: null });
  const id = up.json?.data?.document_id;
  const d = id ? await doc(id) : null;
  record(26, 'liability: valid owner (Spouse) accepted; DB document stores spouse', up.status === 200 && d?.owner_role === 'spouse' && d?.owner_member_id === spouse3, `HTTP ${up.status} ${up.json?.error ?? ''}`);
  await call(AU3, 'POST', `/api/financial-data-hub/liability-statement/${id}/approve`, { owner: null });
  const pr = await call(AU3, 'POST', `/api/financial-data-hub/liability-statement/${id}/proposal`, { owner: null });
  const fields = (pr.json?.data?.fields ?? []).filter((f) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value).map((f) => f.field_name);
  const proposalId = pr.json?.data?.proposal_id;
  const wrong = await apply(`/api/financial-data-hub/liability-proposals/${proposalId}/apply`, { decision: 'add_new', selectedFields: fields, owner: 'self' });
  record(26, 'liability: owner changed between upload and Apply (Self vs Spouse) -> 409 owner_differs_from_upload; nothing written', wrong.status === 409 && wrong.json?.code === 'owner_differs_from_upload' && ((await sb.from('liabilities').select('id').eq('user_id', U3)).data ?? []).length === 0, `HTTP ${wrong.status} ${wrong.json?.code}`);
  const a1 = await apply(`/api/financial-data-hub/liability-proposals/${proposalId}/apply`, { decision: 'add_new', selectedFields: fields });
  const a2 = await apply(`/api/financial-data-hub/liability-proposals/${proposalId}/apply`, { decision: 'add_new', selectedFields: fields });
  const liab = (await sb.from('liabilities').select('id,owner').eq('user_id', U3)).data ?? [];
  record(26, "liability: Apply without an owner takes the document's; exactly ONE liability, owner spouse; repeat Apply ALREADY_APPLIED", a1.status === 200 && a2.status === 409 && liab.length === 1 && liab[0].owner === 'spouse', `apply ${a1.status}/${a2.status} liabilities=${JSON.stringify(liab)}`);
}

// ================= RETIREMENT (super summary CSV) =================
{
  const rs = retirementSummaryStatement(month, 'A', salt);
  const route = '/api/financial-data-hub/retirement-statement/upload';
  const q = { ...rs.upload.query, filename: rs.filename };
  const none = await call(AU3, 'POST', `${route}?${qs(q)}`, { body: Buffer.from(rs.bytes), contentType: 'text/csv', owner: null });
  record(26, 'retirement: no owner -> 422 owner_required', none.status === 422 && none.json?.error === 'owner_required', `HTTP ${none.status} ${none.json?.error}`);
  const foreign = await call(AU4, 'POST', `${route}?${qs(q, MEMBER(spouse3))}`, { body: Buffer.from(rs.bytes), contentType: 'text/csv', owner: null });
  record(26, "retirement: another tenant's member as owner -> refused owner_not_found", foreign.status >= 400 && foreign.json?.error === 'owner_not_found', `HTTP ${foreign.status} ${foreign.json?.error}`);
  const up = await call(AU3, 'POST', `${route}?${qs(q, MEMBER(self3))}`, { body: Buffer.from(rs.bytes), contentType: 'text/csv', owner: null });
  const id = up.json?.data?.document_id;
  const d = id ? await doc(id) : null;
  record(26, 'retirement: valid owner (Self) accepted; DB document stores self', up.status === 200 && d?.owner_role === 'self', `HTTP ${up.status} ${up.json?.error ?? ''}`);
  const mismatch = await call(AU3, 'POST', `/api/financial-data-hub/retirement-statement/${id}/account-match`, { json: { action: 'confirm_new', member_id: randomUUID() }, owner: null });
  record(26, 'retirement: matching the statement to a DIFFERENT retirement member than the upload owner -> 409 owner_differs_from_upload', mismatch.status === 409 && mismatch.json?.error === 'owner_differs_from_upload', `HTTP ${mismatch.status} ${mismatch.json?.error}`);
  const match = await call(AU3, 'POST', `/api/financial-data-hub/retirement-statement/${id}/account-match`, { json: { action: 'confirm_new' }, owner: null });
  record(26, "retirement: matching with no member takes the owner's own retirement member", match.status === 200, `HTTP ${match.status}`);
}

// ================= AU INVESTMENT (broker transactions CSV) =================
{
  const bs = brokerTransactionStatement(month, salt);
  const route = '/api/financial-data-hub/investment-statement/upload';
  const q = { ...bs.upload.query, filename: bs.filename };
  const none = await call(AU3, 'POST', `${route}?${qs(q)}`, { body: Buffer.from(bs.bytes), contentType: 'text/csv', owner: null });
  record(26, 'AU investment: no owner -> 422 owner_required', none.status === 422 && none.json?.error === 'owner_required', `HTTP ${none.status} ${none.json?.error}`);
  const jointNoPct = await call(AU3, 'POST', `${route}?${qs(q, { kind: 'joint' })}`, { body: Buffer.from(bs.bytes), contentType: 'text/csv', owner: null });
  record(26, 'AU investment: Joint WITHOUT percentages -> refused joint_allocation_required', jointNoPct.status === 422 && jointNoPct.json?.error === 'joint_allocation_required', `HTTP ${jointNoPct.status} ${jointNoPct.json?.error}`);
  const entity = await call(AU3, 'POST', `${route}?${qs(q, { kind: 'entity', entityId: randomUUID() })}`, { body: Buffer.from(bs.bytes), contentType: 'text/csv', owner: null });
  record(26, 'AU investment: an entity owner is refused (entity investment records do not exist yet)', entity.status >= 400 && entity.status < 500, `HTTP ${entity.status} ${entity.json?.error}`);
  const foreign = await call(AU4, 'POST', `${route}?${qs(q, MEMBER(spouse3))}`, { body: Buffer.from(bs.bytes), contentType: 'text/csv', owner: null });
  record(26, "AU investment: another tenant's member as owner -> refused owner_not_found", foreign.status >= 400 && foreign.json?.error === 'owner_not_found', `HTTP ${foreign.status} ${foreign.json?.error}`);
  const joint = { kind: 'joint', allocations: [{ memberId: self3, basisPoints: 5000 }, { memberId: spouse3, basisPoints: 5000 }] };
  const up = await call(AU3, 'POST', `${route}?${qs(q, joint)}`, { body: Buffer.from(bs.bytes), contentType: 'text/csv', owner: null });
  const id = up.json?.data?.document_id;
  const d = id ? await doc(id) : null;
  record(26, 'AU investment: Joint 50/50 accepted; DB document keeps the split (5000 + 5000 = 10000)', up.status === 200 && d?.owner_role === 'joint' && (d?.owner_allocation ?? []).reduce((a, x) => a + x.basisPoints, 0) === 10000, `HTTP ${up.status} ${up.json?.error ?? ''}`);
}

// ================= generic upload sessions =================
{
  const mk = (document_type, owner) => call(AU3, 'POST', '/api/financial-data-hub/documents/upload-sessions', { json: { document_type, source_type: 'pdf_native', country_code: 'AU', declared_mime_type: 'application/pdf', declared_file_size_bytes: 1000, ...(owner ? { owner } : {}) }, owner: null });
  const bankNone = await mk('bank_statement', null);
  record(26, 'generic upload session: a bank_statement session with no owner -> 422 owner_required', bankNone.status === 422 && bankNone.json?.error === 'owner_required', `HTTP ${bankNone.status}`);
  const taxNone = await mk('tax_document', null);
  record(26, 'generic upload session: tax_document (no financial effect) needs no owner (asserted exception)', taxNone.status < 300, `HTTP ${taxNone.status}`);
}

saveResults('.canonical-cert/obu-phase2-results.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
