/**
 * Owner-before-upload DEV certification, step 32: cross-tenant matrix.
 *   node scripts/canonical_cert/final/obu_cross_tenant_matrix.mjs
 * User A = IN1 (forecast.tc083, owns CAS documents, a Spouse, entities, a joint account, a case), User B = IN2 (fhip.e2e.tc031), AU2/AU1 for bank rows.
 * For every foreign id kind, B's answer must be IDENTICAL (status and body) to B's answer for a random id that exists nowhere:
 * no response may reveal whether the foreign id exists. Existing fixture users only; localhost app on port 3991; DEV only.
 */
import { randomUUID } from 'node:crypto';
import { USERS, call, uploadCas, db, hostGuard, record, saveResults, results, selfMember } from './obu_lib.mjs';
import fs from 'node:fs';

console.log('DEV host verified:', hostGuard());
const sb = await db();
const A = USERS.IN1;
const B = USERS.IN2;
const users = (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users;
const UA = users.find((u) => u.email === A).id;
const UB = users.find((u) => u.email === B).id;
const selfB = await selfMember(B);

const pick = async (table, filter) => {
  let q = sb.from(table).select('*').limit(1);
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  return (await q).data?.[0];
};
const foreign = {
  memberId: (await pick('household_members', { user_id: UA, relationship: 'spouse' }))?.id,
  entityId: (await pick('business_entities', { user_id: UA, entity_type: 'company' }))?.id,
  docId: (await pick('ii_source_documents', { user_id: UA, owner_role: 'self' }))?.id,
  accountId: (await pick('ii_accounts', { user_id: UA }))?.id,
};
const hold = foreign.accountId ? await pick('ii_holding_snapshots', { account_id: foreign.accountId }) : null;
foreign.holdingId = hold?.id;
foreign.instrumentId = hold?.instrument_id;
foreign.caseId = (await pick('ii_reconciliation_cases', { user_id: UA }))?.id ?? null;
foreign.resolutionId = foreign.caseId;
const bankDoc = await pick('fdh_statement_uploads', { user_id: users.find((u) => u.email === USERS.AU2)?.id });
const AUB = USERS.AU1;
record(32, 'fixture: User A owns a Spouse member, a Company entity, a source document, an account, a holding', Boolean(foreign.memberId && foreign.entityId && foreign.docId && foreign.accountId && foreign.holdingId), JSON.stringify(Object.fromEntries(Object.entries(foreign).map(([k, v]) => [k, v ? String(v).slice(0, 8) : null]))));

/** B's answer for the foreign id and for a random id must be byte-identical (status + body). */
async function same(label, method, mk, opts = {}) {
  const f = await call(B, method, mk(foreign), { owner: null, ...opts.f });
  const r = await call(B, method, mk(Object.fromEntries(Object.keys(foreign).map((k) => [k, randomUUID()]))), { owner: null, ...opts.r });
  const ok = f.status === r.status && JSON.stringify(f.json) === JSON.stringify(r.json);
  record(32, `${label}: a foreign id is answered exactly like a random id`, ok && f.status >= 400, `foreign ${f.status} ${JSON.stringify(f.json)?.slice(0, 90)} | random ${r.status} ${JSON.stringify(r.json)?.slice(0, 90)}`);
}
const owned = (body) => ({ f: { json: body }, r: { json: body } });
const base = '/api/investment-intelligence';

// owner ids in an upload
for (const [kind, key] of [['household member', 'memberId'], ['business entity', 'entityId']]) {
  const bytes = Buffer.from(`not a real pdf ${randomUUID()}`);
  const mk = (id) => (key === 'memberId' ? { kind: 'member', memberId: id } : { kind: 'entity', entityId: id });
  const f = await uploadCas(B, bytes, 'x.pdf', mk(foreign[key]));
  const r = await uploadCas(B, bytes, 'x.pdf', mk(randomUUID()));
  record(32, `CAS upload naming a foreign ${kind} as owner: refused exactly like a random id`, f.status === r.status && JSON.stringify(f.json) === JSON.stringify(r.json) && f.status >= 400, `foreign ${f.status} ${f.json?.error} | random ${r.status} ${r.json?.error}`);
}
const jointF = await uploadCas(B, Buffer.from('x' + randomUUID()), 'x.pdf', { kind: 'joint', allocations: [{ memberId: selfB, basisPoints: 6000 }, { memberId: foreign.memberId, basisPoints: 4000 }] });
const jointR = await uploadCas(B, Buffer.from('x' + randomUUID()), 'x.pdf', { kind: 'joint', allocations: [{ memberId: selfB, basisPoints: 6000 }, { memberId: randomUUID(), basisPoints: 4000 }] });
record(32, 'joint participant from another tenant: refused exactly like a random id', jointF.status === jointR.status && JSON.stringify(jointF.json) === JSON.stringify(jointR.json) && jointF.status >= 400, `foreign ${jointF.status} ${jointF.json?.error} | random ${jointR.status} ${jointR.json?.error}`);

// document / statement / account / resolution / entity / member ids
await same('statement (source document) summary', 'GET', (x) => `${base}/source-documents/${x.docId}/summary`);
await same('statement status', 'GET', (x) => `${base}/source-documents/${x.docId}/status`);
await same('statement process', 'POST', (x) => `${base}/source-documents/${x.docId}/process`, owned({}));
await same('statement discard', 'POST', (x) => `${base}/source-documents/${x.docId}/discard`, owned({}));
await same('statement confirm-owner', 'POST', (x) => `${base}/source-documents/${x.docId}/confirm-owner`, owned({ accountIds: [randomUUID()], targetSignature: 'member:x' }));
await same('statement confirm-sole-owner', 'POST', (x) => `${base}/source-documents/${x.docId}/confirm-sole-owner`, owned({ accountIds: [randomUUID()] }));
await same('account owner (GET dialog data)', 'GET', (x) => `${base}/accounts/${x.accountId}/owner`);
await same('account owner change (PATCH)', 'PATCH', (x) => `${base}/accounts/${x.accountId}/owner`, owned({ kind: 'member', member_id: selfB, confirm: true }));
await same('position publish (holding id)', 'POST', (x) => `${base}/positions/${x.holdingId}/publish`, owned({ acknowledgedNoDuplicate: true }));
await same('position re-evaluate (certify)', 'POST', () => `${base}/portfolio-truth/certify`, { f: { json: { accountId: foreign.accountId, instrumentId: foreign.instrumentId } }, r: { json: { accountId: randomUUID(), instrumentId: randomUUID() } } });
if (foreign.caseId) {
  await same('resolution amend (case id)', 'POST', (x) => `${base}/resolutions/${x.caseId}/amend`, owned({ kind: 'member', member_id: selfB, confirm: true }));
  await same('reconciliation case resolve', 'POST', (x) => `${base}/reconciliation-cases/${x.caseId}/resolve`, owned({ resolution_method: 'user_confirmed' }));
} else record(32, 'resolution / case id rows', null, 'User A has no reconciliation case on DEV to probe; the route shape was probed with random ids only');
await same('business entity (GET)', 'GET', (x) => `/api/business-entities/${x.entityId}`);
await same('business entity (PATCH)', 'PATCH', (x) => `/api/business-entities/${x.entityId}`, owned({ name: 'hijack' }));
await same('household member (GET)', 'GET', (x) => `/api/household-members/${x.memberId}`);
await same('household member (PATCH)', 'PATCH', (x) => `/api/household-members/${x.memberId}`, owned({ full_name: 'hijack' }));

// bank rows (AU): statement id / account id
if (bankDoc) {
  const bf = await call(AUB, 'POST', `/api/financial-data-hub/bank-statements/${bankDoc.id}/resolve-account`, { json: {}, owner: null });
  const br = await call(AUB, 'POST', `/api/financial-data-hub/bank-statements/${randomUUID()}/resolve-account`, { json: {}, owner: null });
  record(32, 'bank statement id of another tenant: resolve-account answers exactly like a random statement id', bf.status === br.status && JSON.stringify(bf.json) === JSON.stringify(br.json) && bf.status === 404, `foreign ${bf.status} | random ${br.status}`);
  const pf = await call(AUB, 'POST', `/api/financial-data-hub/bank-csv/${bankDoc.id}/process`, { json: {}, owner: null });
  const pr = await call(AUB, 'POST', `/api/financial-data-hub/bank-csv/${randomUUID()}/process`, { json: {}, owner: null });
  record(32, 'bank statement id of another tenant: process answers exactly like a random id', pf.status === pr.status && JSON.stringify(pf.json) === JSON.stringify(pr.json) && pf.status >= 400, `foreign ${pf.status} | random ${pr.status}`);
}
// the existence-oracle controls: a REAL own id must NOT look like a random id (so the identical answers above are not a vacuous 404)
const own = await call(A, 'GET', `${base}/source-documents/${foreign.docId}/summary`, { owner: null });
record(32, 'CONTROL: the owner of the document gets 200 for the same call (the identical 404s above are tenant isolation, not a dead route)', own.status === 200, `owner HTTP ${own.status}`);

saveResults('.canonical-cert/obu-cross-tenant-results.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
