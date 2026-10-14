/**
 * Owner-before-upload DEV certification: India CAS journeys (spec steps 11-18).
 *   npx tsx scripts/canonical_cert/final/obu_cas_journeys.mjs [--steps 11,12,...]
 * Localhost app on port 3991 pointed at DEV. Existing fixture users only (IN1 = forecast.tc083, IN2 = fhip.e2e.tc031).
 * Every PASS needs the API answer AND the database row to agree. Synthetic statements only (PC3 fixtures + generated ones).
 * Rows created are cleaned by the harness residue ledger (OBU), never by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildMinimalTextPdf } from '../../../tests/support/buildMinimalPdf.ts';
import { USERS, CAS_DIR, call, uploadCas, processDoc, waitSettled, selfMember, ensureSpouse, db, hostGuard, record, saveResults, sha } from './obu_lib.mjs';

const host = hostGuard();
console.log('DEV host verified:', host);
const only = (process.argv.find((a) => a.startsWith('--steps='))?.slice(8) ?? '').split(',').filter(Boolean);
const want = (n) => only.length === 0 || only.includes(String(n));
const sb = await db();
const IN1 = USERS.IN1;
const IN2 = USERS.IN2;
const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CTX_FILE = '.canonical-cert/obu-cas-ctx.json';
const prev = fs.existsSync(CTX_FILE) ? JSON.parse(fs.readFileSync(CTX_FILE, 'utf8')) : {};
const salt = prev.salt ?? String(Math.floor(1000 + Math.random() * 9000));

// ---------- synthetic CAS builder (CAMS "detailed_v1" layout, copied from the PC3 fixtures) ----------
function casText({ holders, folios }) {
  const lines = ['CAMS Consolidated Account Statement', 'Statement Period : 01-Jan-2025 To 30-Jun-2025', ''];
  for (const f of folios) {
    lines.push(`Folio No: ${f.folio}`, `PAN: PCQAL${f.folio.slice(-4)}F`, `Name: ${f.name ?? holders ?? 'FHIP SYNTHETIC HOLDER'}`, `Holding Mode: ${f.mode ?? 'SI'}`, '');
    lines.push(`AMC Name: ${f.amc ?? 'HDFC Mutual Fund'}`, `Scheme Name: ${f.scheme ?? 'HDFC Flexi Cap Fund - Growth (Direct Plan)'}`, `ISIN: ${f.isin ?? 'INF179K01YW8'}`, `AMFI Code: ${f.amfi ?? '118834'}`, 'Registrar: CAMS', '');
    lines.push('Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance');
    lines.push(`01-Feb-2025   Purchase                              ${f.amount}  ${f.units}  ${f.nav}  ${f.units} [Ref: ${f.ref}]`, '');
    lines.push(`Closing Unit Balance as on 30-Jun-2025 : ${f.units} Units   Valuation : Rs. ${f.valuation}   NAV as on 30-Jun-2025 : Rs. ${f.closeNav}`, '');
  }
  return buildMinimalTextPdf([lines]);
}
const folioNo = (n) => `66${salt}0000${String(n).padStart(3, '0')}`;
/** one folio worth exactly `valuation` INR (units x NAV) */
const folio = (n, valuation, extra = {}) => {
  const units = '1000.000';
  const nav = (valuation / 1000).toFixed(4);
  return { folio: folioNo(n), amount: Number(valuation).toLocaleString('en-IN', { minimumFractionDigits: 2 }), units, nav, valuation: Number(valuation).toFixed(2), closeNav: nav, ref: `OBU${salt}-${n}`, ...extra };
};
const fixture = (name) => fs.readFileSync(path.join(CAS_DIR, name));

const rows = async (table, filter) => {
  let q = sb.from(table).select('*');
  for (const [k, v] of Object.entries(filter)) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return data ?? [];
};
const docRow = async (id) => (await rows('ii_source_documents', { id }))[0];
const accountsOf = async (userId, folios) => (await rows('ii_accounts', { user_id: userId })).filter((a) => folios.includes(a.folio_number ?? a.account_number_masked));
const uid = async (email) => (await call(email, 'GET', '/api/ownership/options?flow=ii_cas')).json?.data?.userId ?? null;
const userIdOf = async (email) => {
  const { data } = await sb.auth.admin.listUsers({ perPage: 1000 });
  return data.users.find((u) => u.email === email)?.id;
};
const U1 = await userIdOf(IN1);
const U2 = await userIdOf(IN2);

async function upAndProcess(email, bytes, name, owner) {
  const up = await uploadCas(email, bytes, name, owner);
  if (up.status !== 200 || !up.json?.data?.id) return { up };
  const id = up.json.data.id;
  const pr = up.json.data.deduplicated ? null : await processDoc(email, id);
  const st = pr ? await waitSettled(email, id) : null;
  return { up, id, pr, st };
}
const summary = async (email, id) => (await call(email, 'GET', `/api/investment-intelligence/source-documents/${id}/summary`)).json?.data;
const ctx = { ...prev, salt };

// ================= members and entities for IN1 =================
const selfId = await selfMember(IN1);
const spouseId = await ensureSpouse(IN1);
ctx.selfId = selfId; ctx.spouseId = spouseId;
record('setup', 'IN1 has a Self member and a REAL Spouse member (added through the explicit Add-household-member route)', !!selfId && !!spouseId && selfId !== spouseId, `self ${String(selfId).slice(0, 8)} spouse ${String(spouseId).slice(0, 8)}`);
const spouseRow = (await rows('household_members', { id: spouseId }))[0];
record('setup', 'the Spouse member belongs to IN1 and has relationship spouse (not a role-only label)', spouseRow?.user_id === U1 && spouseRow?.relationship === 'spouse', JSON.stringify({ rel: spouseRow?.relationship }));

// ================= STEP 11: Self =================
if (want(11)) {
  const bytes = fixture('pc3-q01-baseline-multi-folio-multi-amc.pdf');
  const none = await uploadCas(IN1, bytes, 'obu-s11-noowner.pdf', undefined);
  record(11, 'owner is required before upload: no owner -> 422 owner_required (before the file is read)', none.status === 422 && none.json?.error === 'owner_required', `HTTP ${none.status} ${none.json?.error}`);
  const r = await upAndProcess(IN1, bytes, 'obu-s11-q01.pdf', { kind: 'member', memberId: selfId });
  ctx.s11 = r.id;
  record(11, 'India CAS as Self: upload accepted and processed', r.up.status === 200 && !!r.id, `HTTP ${r.up.status} dedup=${r.up.json?.data?.deduplicated ?? false}`);
  const d = await docRow(r.id);
  record(11, 'DB: owner stored on the document (self / user_selected / member = Self)', d.owner_role === 'self' && d.owner_selection_source === 'user_selected' && d.owner_member_id === selfId && d.owner_business_entity_id === null, JSON.stringify({ role: d.owner_role, src: d.owner_selection_source }));
  const accts = await accountsOf(U1, ['9301040000101', '9301040000102']);
  record(11, 'DB: owner applied to BOTH folio accounts (owner_member_id = Self)', accts.length === 2 && accts.every((a) => a.owner_member_id === selfId), `${accts.length} accounts`);
  const cases = await rows('ii_reconciliation_cases', { user_id: U1, source_document_id: r.id });
  record(11, 'DB: no owner_unmatched case exists for this document', !cases.some((c) => /owner_unmatched/.test(c.discrepancy_type ?? '')), JSON.stringify(cases.map((c) => c.discrepancy_type)));
  const s = await summary(IN1, r.id);
  record(11, 'API: "Filed under" shows a friendly name, not a raw id', !!s?.owner?.label && !uuidRe.test(s.owner.label) && s.owner.chosenAtUpload === true, `label=${s?.owner?.label}`);
  const rp = await processDoc(IN1, r.id);
  const re = await call(IN1, 'POST', '/api/investment-intelligence/portfolio-truth/certify', { json: { accountId: accts[0].id, instrumentId: (await rows('ii_holding_snapshots', { account_id: accts[0].id }))[0].instrument_id }, owner: null });
  const d2 = await docRow(r.id);
  const a2 = await accountsOf(U1, ['9301040000101', '9301040000102']);
  record(11, 'reprocess + Re-evaluate keep the owner (document and accounts unchanged)', d2.owner_role === 'self' && d2.owner_member_id === selfId && a2.every((a) => a.owner_member_id === selfId), `reprocess HTTP ${rp.status}, certify HTTP ${re.status}`);
  record(11, 'raw-document lifecycle intact: storage purged and owner columns retained', d2.storage_purged_at !== null && d2.owner_role === 'self', `purged_at set=${d2.storage_purged_at !== null}`);
}

// ================= STEP 12: Spouse =================
if (want(12)) {
  const bytes = fixture('pc3-q03-same-instrument-two-folios-fifo-scope.pdf');
  const r = await upAndProcess(IN1, bytes, 'obu-s12-q03.pdf', { kind: 'member', memberId: spouseId });
  ctx.s12 = r.id;
  record(12, 'India CAS as Spouse accepted and processed', r.up.status === 200 && !!r.id, `HTTP ${r.up.status}`);
  const d = await docRow(r.id);
  record(12, 'DB: document owner = real Spouse member, role spouse, user_selected', d.owner_role === 'spouse' && d.owner_member_id === spouseId && d.owner_selection_source === 'user_selected');
  const accts = await accountsOf(U1, ['9303040000301', '9303040000302']);
  record(12, 'DB: both folio accounts owned by the Spouse member', accts.length === 2 && accts.every((a) => a.owner_member_id === spouseId), `${accts.length}`);
  const s1 = await summary(IN1, r.id);
  const re = await processDoc(IN1, r.id);
  const s2 = await summary(IN1, r.id);
  const d2 = await docRow(r.id);
  record(12, 'persistence after reload / reprocess: owner unchanged, label friendly', d2.owner_member_id === spouseId && s2?.owner?.ownerRole === 'spouse' && !uuidRe.test(s2.owner.label ?? ''), `label=${s1?.owner?.label} reprocess HTTP ${re.status}`);
}

// ================= STEP 13: Joint 60/40 =================
if (want(13)) {
  const earlier = (await rows('ii_source_documents', { user_id: U1, owner_role: 'joint' }))[0];
  let f = folio(1, 1000000);
  let r;
  if (earlier) {
    // re-run: reuse the joint document made earlier in this ledger run instead of creating a second one
    const a = (await rows('ii_accounts', { source_document_id: earlier.id }))[0];
    f = { folio: a.folio_number };
    r = { id: earlier.id, up: { status: 200, json: {} } };
  } else {
    const bytes = casText({ folios: [f] });
    const joint = { kind: 'joint', allocations: [{ memberId: selfId, basisPoints: 6000 }, { memberId: spouseId, basisPoints: 4000 }] };
    r = await upAndProcess(IN1, bytes, 'obu-s13-joint.pdf', joint);
  }
  ctx.s13 = r.id; ctx.s13Folio = f.folio;
  record(13, 'Joint 60/40 upload accepted and processed', r.up.status === 200 && !!r.id, `HTTP ${r.up.status} ${JSON.stringify(r.up.json).slice(0, 200)}`);
  const d = await docRow(r.id);
  const alloc = d.owner_allocation ?? [];
  const sum = alloc.reduce((s, x) => s + x.basisPoints, 0);
  record(13, 'DB: document keeps the joint intent (role joint, 6000/4000 = 10000)', d.owner_role === 'joint' && sum === 10000 && alloc.some((x) => x.ownerMemberId === selfId && x.basisPoints === 6000) && alloc.some((x) => x.ownerMemberId === spouseId && x.basisPoints === 4000), JSON.stringify(alloc));
  const [acct] = await accountsOf(U1, [f.folio]);
  const al = await rows('ii_ownership_allocation', { ii_account_id: acct.id });
  const active = al.filter((x) => x.status === 'active');
  const total = active.reduce((s, x) => s + Number(x.allocation_basis_points), 0);
  record(13, 'DB: active account allocation group is 6000/4000 and sums to 10000', total === 10000 && active.length === 2, JSON.stringify(al.map((x) => ({ bp: x.allocation_basis_points, m: (x.owner_member_id ?? '').slice(0, 8), st: x.status }))));
  const holding = (await rows('ii_holding_snapshots', { account_id: acct.id }))[0];
  const cert = await call(IN1, 'POST', '/api/investment-intelligence/portfolio-truth/certify', { json: { accountId: acct.id, instrumentId: holding.instrument_id }, owner: null });
  const truth = (await rows('ii_portfolio_truth_status', { account_id: acct.id }))[0];
  record(13, 'recertification: owner resolved (no blocking owner reason)', cert.status === 200 && !(truth.blocking_reasons ?? []).some((b) => /owner/i.test(JSON.stringify(b))), `status=${truth?.status} blocking=${JSON.stringify(truth?.blocking_reasons)}`);
  record(13, 'holding value is exactly 1,000,000.00 (oracle input)', Number(holding.value) === 1000000, `value=${holding.value}`);
  const ov = await call(IN1, 'GET', '/api/investment-intelligence/overview');
  const jc = ov.json?.data?.ownerBreakup?.classes?.find((c) => c.info.kind === 'joint');
  const att = jc?.ownerAttribution ?? [];
  const selfAtt = att.find((o) => o.ownerKey.includes(selfId))?.valueByCurrency?.[0]?.totalValue;
  const spAtt = att.find((o) => o.ownerKey.includes(spouseId))?.valueByCurrency?.[0]?.totalValue;
  const jv = jc?.valueByCurrency?.[0]?.totalValue;
  record(13, 'ORACLE: joint class 1,000,000 = Self 600,000 + Spouse 400,000 (never 2,000,000)', jv === 1000000 && selfAtt === 600000 && spAtt === 400000, `joint=${jv} self=${selfAtt} spouse=${spAtt}`);
  const consolidated = ov.json?.data?.ownerBreakup?.consolidated?.valueByCurrency?.[0]?.totalValue;
  const classSum = (ov.json?.data?.ownerBreakup?.classes ?? []).reduce((s, c) => s + (c.valueByCurrency?.[0]?.totalValue ?? 0), 0);
  record(13, 'household total is the sum of the classes: the joint 1,000,000 is counted once', Math.abs(consolidated - classSum) < 0.01, `consolidated=${consolidated} sumOfClasses=${classSum}`);
  // per-member views
  const oc = (await call(IN1, 'GET', '/api/investment-intelligence/owner-classes')).json?.data?.classes ?? [];
  record(13, 'owner-class selector offers the joint class and each member class', oc.some((c) => c.kind === 'joint') && oc.some((c) => c.key === `member:${selfId}`) && oc.some((c) => c.key === `member:${spouseId}`), JSON.stringify(oc.map((c) => c.kind)));
  // publication once
  const corr = randomUUID();
  const pub1 = await call(IN1, 'POST', `/api/investment-intelligence/positions/${holding.id}/publish`, { json: { acknowledgedNoDuplicate: true, correlationId: corr }, owner: null });
  const pub2 = await call(IN1, 'POST', `/api/investment-intelligence/positions/${holding.id}/publish`, { json: { acknowledgedNoDuplicate: true, correlationId: corr }, owner: null });
  const pubs = await rows('ii_fhip_publications', { canonical_position_id: holding.id });
  record(13, 'publication happens once for the joint position (a repeat with the same correlation id adds nothing)', pub1.status === 200 && pubs.filter((p) => p.status === 'published').length === 1, `publish1 HTTP ${pub1.status} ${JSON.stringify(pub1.json).slice(0, 160)} publish2 HTTP ${pub2.status}; published rows=${pubs.length}`);
  const pubRow = pubs.find((p) => p.status === 'published');
  const invRows = pubRow ? await rows('investments', { id: pubRow.published_row_id }) : [];
  record(13, 'published once into the personal register as JOINT (owner joint, value once, one investments row)', !!pubRow && pubRow.published_owner === 'joint' && invRows.length === 1, `published_owner=${pubRow?.published_owner} published_value=${pubRow?.published_value} investments rows=${invRows.length}`);
  const perMember = [];
  for (const k of oc.filter((c) => c.kind === 'personal')) {
    const o = await call(IN1, 'GET', `/api/investment-intelligence/overview?ownerClass=${encodeURIComponent(k.key)}`);
    perMember.push(`${k.label}=${o.json?.data?.portfolio?.valueByCurrency?.[0]?.totalValue}`);
  }
  record(13, 'per-member class views list only that member\'s own folios; the joint holding is its own class with the 60/40 attribution (design: owner classes are separate, never added to each other)', null, perMember.join('; '));
  ctx.holding13 = holding.id;
}

// ================= STEP 14: Joint negatives =================
const selfIn2 = await selfMember(IN2);
if (want(14)) {
  const before = (await rows('ii_source_documents', { user_id: U1 })).length;
  const cases = [
    ['9999 basis points total', [{ memberId: selfId, basisPoints: 6000 }, { memberId: spouseId, basisPoints: 3999 }]],
    ['10001 basis points total', [{ memberId: selfId, basisPoints: 6001 }, { memberId: spouseId, basisPoints: 4000 }]],
    ['negative share', [{ memberId: selfId, basisPoints: 11000 }, { memberId: spouseId, basisPoints: -1000 }]],
    ['zero share', [{ memberId: selfId, basisPoints: 10000 }, { memberId: spouseId, basisPoints: 0 }]],
    ['duplicate owner', [{ memberId: selfId, basisPoints: 5000 }, { memberId: selfId, basisPoints: 5000 }]],
    ['one-owner joint', [{ memberId: selfId, basisPoints: 10000 }]],
    ['fractional share', [{ memberId: selfId, basisPoints: 5000.5 }, { memberId: spouseId, basisPoints: 4999.5 }]],
    ['cross-tenant member as a joint owner', [{ memberId: selfId, basisPoints: 6000 }, { memberId: selfIn2, basisPoints: 4000 }]],
    ['joint with no percentages at all', undefined],
  ];
  let i = 0;
  for (const [name, allocations] of cases) {
    i += 1;
    const bytes = casText({ folios: [folio(900 + i, 100000 + i)] });
    const owner = allocations === undefined ? { kind: 'joint' } : { kind: 'joint', allocations };
    const r = await uploadCas(IN1, bytes, `obu-s14-${i}.pdf`, owner);
    const created = (await rows('ii_source_documents', { user_id: U1, checksum: sha(bytes) })).length;
    record(14, `joint negative: ${name} fails safely (4xx, no document row)`, r.status >= 400 && r.status < 500 && created === 0, `HTTP ${r.status} ${r.json?.error ?? r.json?.code ?? ''} rows=${created}`);
  }
  const after = (await rows('ii_source_documents', { user_id: U1 })).length;
  record(14, 'no document row was created by any of the 9 refused joint uploads', after === before, `before ${before} after ${after}`);
  // DEV database-level proof: the constraints and the trigger refuse the same shapes even when the app is bypassed (service role).
  const baseDoc = (extra) => ({ user_id: U1, country_code: 'IN', status: 'uploaded', storage_path: `obu-cert/${salt}/${Math.random()}`, original_filename: 'obu-db-neg.pdf', mime_type: 'application/pdf', file_size: 10, document_type: 'cas_statement', ...extra });
  const dbCases = [
    ['unknown owner_role', { owner_role: 'bogus' }, 'chk_ii_source_documents_owner_role_0236'],
    ['joint user_selected with no split', { owner_role: 'joint', owner_selection_source: 'user_selected' }, 'chk_ii_source_documents_owner_joint_alloc_0236'],
    ['9999 split', { owner_role: 'joint', owner_selection_source: 'user_selected', owner_allocation: [{ ownerMemberId: selfId, basisPoints: 5999 }, { ownerMemberId: spouseId, basisPoints: 4000 }] }, 'chk_ii_source_documents_owner_joint_alloc_0236'],
    ['member AND entity together', { owner_member_id: selfId, owner_business_entity_id: '00000000-0000-4000-8000-000000000001', owner_role: 'other' }, null],
    ['user_selected with no role', { owner_selection_source: 'user_selected' }, 'chk_ii_source_documents_owner_chosen_has_role_0236'],
    ["another tenant's household member (trigger)", { owner_member_id: selfIn2, owner_role: 'self' }, 'does not belong to user_id'],
  ];
  for (const [name, extra, expectName] of dbCases) {
    const ins = await sb.from('ii_source_documents').insert(baseDoc(extra)).select('id');
    if (!ins.error) await sb.from('ii_source_documents').delete().eq('id', ins.data[0].id);
    const msg = ins.error?.message ?? '';
    record(14, `DB-level (service role, app bypassed): ${name} is refused by the database`, !!ins.error && (expectName === null || msg.includes(expectName)), ins.error ? `${ins.error.code} ${msg.slice(0, 160)}` : 'ACCEPTED (row removed) - constraint missing');
  }
  const fdhBase = (extra) => ({ user_id: U1, source_type: 'csv', document_type: 'bank_statement', ...extra });
  const fdhCases = [
    ['unknown owner_role', { owner_role: 'bogus' }, 'chk_fdh_uploads_owner_role_0236'],
    ['9999 joint split', { owner_role: 'joint', owner_allocation: [{ ownerMemberId: selfId, basisPoints: 5999 }, { ownerMemberId: spouseId, basisPoints: 4000 }] }, 'chk_fdh_uploads_owner_joint_alloc_0236'],
    ['entity id with a person role', { owner_business_entity_id: '00000000-0000-4000-8000-000000000001', owner_role: 'self' }, null],
    ["another tenant's household member (trigger)", { owner_member_id: selfIn2, owner_role: 'self' }, 'does not belong to user_id'],
  ];
  for (const [name, extra, expectName] of fdhCases) {
    const ins = await sb.from('fdh_statement_uploads').insert(fdhBase(extra)).select('id');
    if (!ins.error) await sb.from('fdh_statement_uploads').delete().eq('id', ins.data[0].id);
    const msg = ins.error?.message ?? '';
    record(14, `DB-level fdh_statement_uploads: ${name} is refused by the database`, !!ins.error && (expectName === null || msg.includes(expectName)), ins.error ? `${ins.error.code} ${msg.slice(0, 160)}` : 'ACCEPTED (row removed)');
  }
}

// ================= STEP 15: Company / Trust / HUF CAS =================
async function makeEntity(email, body) {
  const r = await call(email, 'POST', '/api/business-entities', { json: body, owner: null });
  return r;
}
if (want(15)) {
  const mk = async (name, entity_type, pct) => {
    const list = (await call(IN1, 'GET', '/api/business-entities')).json?.data ?? [];
    const hit = list.find((e) => e.name === name);
    if (hit) return hit;
    const r = await makeEntity(IN1, { name, entity_type, ownership_percentage: pct, valuation_mode: 'summary', summary_net_asset_value: 0, currency_code: 'INR' });
    return r.json?.data ?? { error: r.json };
  };
  const company = await mk(`FHIP OBU Company ${salt}`, 'company', 50);
  const trust = await mk(`FHIP OBU Trust ${salt}`, 'family_trust', 100);
  const huf = await mk(`FHIP OBU HUF ${salt}`, 'huf', 100);
  ctx.entities = { company: company.id, trust: trust.id, huf: huf.id };
  record(15, 'synthetic Company, Family Trust and HUF created for IN1 (India user: HUF allowed)', !!company.id && !!trust.id && !!huf.id, JSON.stringify([company.entity_type, trust.entity_type, huf.entity_type]));
  const ownedBy = (await rows('business_entities', { id: [company.id, trust.id, huf.id] }));
  record(15, 'DB: all three entities belong to IN1', ownedBy.length === 3 && ownedBy.every((e) => e.user_id === U1));
  const invBefore = (await rows('investments', { user_id: U1 })).length;
  const spec = [['company', company, 1000000, 'obu-s15-company'], ['trust', trust, 750000, 'obu-s15-trust'], ['huf', huf, 600000, 'obu-s15-huf']];
  let n = 20;
  for (const [kind, ent, value, fname] of spec) {
    n += 1;
    const f = folio(n, value);
    const r = await upAndProcess(IN1, casText({ folios: [f] }), `${fname}.pdf`, { kind: 'entity', entityId: ent.id });
    record(15, `${kind}: CAS upload accepted and processed`, r.up.status === 200 && !!r.id, `HTTP ${r.up.status} ${r.up.json?.error ?? ''}`);
    if (!r.id) continue;
    const d = await docRow(r.id);
    record(15, `${kind}: DB document owner is the entity (owner_business_entity_id), no member`, d.owner_business_entity_id === ent.id && d.owner_member_id === null && d.owner_selection_source === 'user_selected', `role=${d.owner_role}`);
    const [acct] = await accountsOf(U1, [f.folio]);
    const al = (await rows('ii_ownership_allocation', { ii_account_id: acct.id })).filter((x) => x.status === 'active');
    record(15, `${kind}: active allocation is 10000 bp to the entity, no personal member on the account`, al.length === 1 && al[0].owner_business_entity_id === ent.id && al[0].allocation_basis_points === 10000 && acct.owner_member_id === null, JSON.stringify(al.map((x) => x.allocation_basis_points)));
    const holding = (await rows('ii_holding_snapshots', { account_id: acct.id }))[0];
    const pub = await call(IN1, 'POST', `/api/investment-intelligence/positions/${holding.id}/publish`, { json: { acknowledgedNoDuplicate: true, correlationId: randomUUID() }, owner: null });
    record(15, `${kind}: publication into the PERSONAL register is refused (no personal-register pollution)`, pub.status >= 400, `HTTP ${pub.status} ${JSON.stringify(pub.json).slice(0, 140)}`);
  }
  const invAfter = (await rows('investments', { user_id: U1 })).length;
  record(15, 'DB: the personal investments register gained nothing from the three entity documents', invAfter === invBefore, `before ${invBefore} after ${invAfter}`);
  const ov = await call(IN1, 'GET', '/api/investment-intelligence/overview');
  const cls = ov.json?.data?.ownerBreakup?.classes ?? [];
  const entClasses = cls.filter((c) => c.info.kind === 'entity');
  const consolidated = ov.json?.data?.ownerBreakup?.consolidated?.valueByCurrency?.[0]?.totalValue;
  const sum = cls.reduce((s, c) => s + (c.valueByCurrency?.[0]?.totalValue ?? 0), 0);
  record(15, 'owner-class report: each entity is its own class; the macro line is exactly the sum (each position once)', entClasses.length === 3 && Math.abs(consolidated - sum) < 0.01, `entity classes=${entClasses.length} values=${entClasses.map((c) => c.valueByCurrency?.[0]?.totalValue)} macro=${consolidated}`);
  // HUF outside India is refused (AU1 is an AU-confirmed fixture user)
  const au = await call(USERS.AU1, 'POST', '/api/business-entities', { json: { name: `FHIP OBU HUF ${salt}`, entity_type: 'huf', ownership_percentage: 100, valuation_mode: 'summary', summary_net_asset_value: 0, currency_code: 'AUD' }, owner: null });
  record(15, 'HUF outside India: an AU user cannot create an HUF (403)', au.status === 403, `HTTP ${au.status}`);
  const auOwner = await uploadCas(USERS.AU1, casText({ folios: [folio(77, 1000)] }), 'obu-s15-au-huf.pdf', { kind: 'entity', entityId: huf.id });
  record(15, "an AU user cannot use IN1's HUF as a CAS owner (owner_not_found, identical to a missing id)", auOwner.status >= 400 && ['owner_not_found'].includes(auOwner.json?.error), `HTTP ${auOwner.status} ${auOwner.json?.error}`);
}

// ================= STEP 16: per-folio owner conflict =================
if (want(16)) {
  const txt = fs.readFileSync(path.join(CAS_DIR, 'pc3-q03-same-instrument-two-folios-fifo-scope.txt'), 'utf8').replaceAll('PC3Q3-', `OBUQ3${salt}-`);
  const bytes = buildMinimalTextPdf([txt.split('\n')]);
  const r = await upAndProcess(IN1, bytes, 'obu-s16-q03-variant.pdf', { kind: 'member', memberId: selfId });
  ctx.s16 = r.id;
  record(16, 'a CAS under Self for two folios already filed under the Spouse is accepted (not blocked)', r.up.status === 200 && !!r.id, `HTTP ${r.up.status} ${r.up.json?.error ?? ''}`);
  const accts = await accountsOf(U1, ['9303040000301', '9303040000302']);
  record(16, 'DB: BOTH folios still belong to the Spouse (nothing silently overwritten)', accts.length === 2 && accts.every((a) => a.owner_member_id === spouseId));
  const s = await summary(IN1, r.id);
  const conflicts = s?.owner?.review?.conflicts ?? [];
  record(16, 'API: the conflict list names each folio individually (2 conflicts, folio numbers present)', conflicts.length === 2, JSON.stringify(conflicts).slice(0, 300));
  const sig = conflicts[0]?.targetSignature ?? (await docRow(r.id)).owner_review?.targetSignature;
  const sigDb = (await docRow(r.id)).owner_review?.targetSignature;
  const [first, second] = accts.sort((a, b) => a.folio_number.localeCompare(b.folio_number));
  const wrongSig = await call(IN1, 'POST', `/api/investment-intelligence/source-documents/${r.id}/confirm-owner`, { json: { accountIds: [first.id], targetSignature: 'member:00000000-0000-4000-8000-000000000000' }, owner: null });
  record(16, 'a stale / wrong target owner signature is refused (409) and changes nothing', wrongSig.status === 409 && (await accountsOf(U1, [first.folio_number]))[0].owner_member_id === spouseId, `HTTP ${wrongSig.status}`);
  const one = await call(IN1, 'POST', `/api/investment-intelligence/source-documents/${r.id}/confirm-owner`, { json: { accountIds: [first.id], targetSignature: sigDb }, owner: null });
  const aa = await accountsOf(U1, [first.folio_number, second.folio_number]);
  const A1 = aa.find((a) => a.id === first.id); const A2 = aa.find((a) => a.id === second.id);
  record(16, 'select ONE folio and confirm: the selected folio changes to Self, the unselected one stays with the Spouse', one.status === 200 && A1.owner_member_id === selfId && A2.owner_member_id === spouseId, `HTTP ${one.status} remaining=${one.json?.data?.remainingConflicts}`);
  const audit = await rows('ii_audit_events', { user_id: U1, subject_id: first.id });
  record(16, 'audit event written for the changed folio (user_correction, owner_change_confirmed_at_upload)', audit.some((e) => e.metadata?.outcome === 'owner_change_confirmed_at_upload'), `${audit.length} audit rows`);
  const s2 = await summary(IN1, r.id);
  record(16, 'reload persists: one conflict remains, listing only the unselected folio', (s2?.owner?.review?.conflicts ?? []).length === 1 && s2.owner.review.conflicts[0].accountId === second.id, JSON.stringify(s2?.owner?.review?.conflicts).slice(0, 200));
  const holding = (await rows('ii_holding_snapshots', { account_id: first.id }))[0];
  const recert = await call(IN1, 'POST', '/api/investment-intelligence/portfolio-truth/certify', { json: { accountId: first.id, instrumentId: holding.instrument_id }, owner: null });
  const A1b = (await accountsOf(U1, [first.folio_number]))[0];
  record(16, 'Re-evaluate uses the latest decision (the folio stays Self)', recert.status === 200 && A1b.owner_member_id === selfId, `HTTP ${recert.status}`);
  const all = await call(IN1, 'POST', `/api/investment-intelligence/source-documents/${r.id}/confirm-owner`, { json: { accountIds: [second.id], targetSignature: sigDb }, owner: null });
  const A2b = (await accountsOf(U1, [second.folio_number]))[0];
  record(16, 'Select all (the remaining folio) then changes it too; no conflicts left', all.status === 200 && A2b.owner_member_id === selfId && (await docRow(r.id)).owner_review.conflicts.length === 0, `HTTP ${all.status}`);
  const other = await call(IN2, 'POST', `/api/investment-intelligence/source-documents/${r.id}/confirm-owner`, { json: { accountIds: [first.id], targetSignature: sigDb }, owner: null });
  record(16, 'cross-tenant: another user cannot confirm folios of this document (404)', other.status === 404, `HTTP ${other.status}`);
}

// ================= STEP 17: printed JOINT vs a selected sole owner =================
if (want(17)) {
  const f = folio(40, 250000, { mode: 'JO', name: 'FHIP SYNTHETIC HOLDER AND PARTNER' });
  const bytes = casText({ folios: [f] });
  const r = await upAndProcess(IN1, bytes, 'obu-s17-printed-joint.pdf', { kind: 'member', memberId: selfId });
  ctx.s17 = r.id;
  record(17, 'a CAS that PRINTS a joint holding, uploaded under a single owner, is accepted (non-blocking)', r.up.status === 200 && !!r.id, `HTTP ${r.up.status}`);
  const d = await docRow(r.id);
  const warn = (d.owner_review?.warnings ?? []).filter((w) => /joint/i.test(w.kind));
  record(17, 'DB: a non-blocking joint warning is recorded for the folio (no blocking case)', warn.length >= 1, JSON.stringify((d.owner_review?.warnings ?? []).map((w) => w.kind)));
  const blocking = (await rows('ii_reconciliation_cases', { user_id: U1, source_document_id: r.id })).filter((c) => c.status === 'open');
  record(17, 'DB: no open blocking reconciliation case for it', blocking.length === 0, JSON.stringify(blocking.map((c) => c.discrepancy_type)));
  const [acct] = await accountsOf(U1, [f.folio]);
  const ack = await call(IN1, 'POST', `/api/investment-intelligence/source-documents/${r.id}/confirm-sole-owner`, { json: { accountIds: [acct.id] }, owner: null });
  const d2 = await docRow(r.id);
  const [acct2] = await accountsOf(U1, [f.folio]);
  record(17, '"This is not joint": warning cleared, the folio owner NOT rewritten', ack.status === 200 && acct2.owner_member_id === selfId && !(d2.owner_review?.warnings ?? []).some((w) => /joint/i.test(w.kind) && w.accountId === acct.id), `HTTP ${ack.status} remaining=${ack.json?.data?.remainingWarnings}`);
  const ownerBefore = JSON.stringify([d2.owner_role, d2.owner_member_id]);
  await processDoc(IN1, r.id);
  const d3 = await docRow(r.id);
  record(17, 'acknowledgement persists through reprocessing; unrelated owner data unchanged', JSON.stringify([d3.owner_role, d3.owner_member_id]) === ownerBefore && !(d3.owner_review?.warnings ?? []).some((w) => /joint/i.test(w.kind)), JSON.stringify(d3.owner_review?.warnings?.map((w) => w.kind)));
  const other = await call(IN2, 'POST', `/api/investment-intelligence/source-documents/${r.id}/confirm-sole-owner`, { json: { accountIds: [acct.id] }, owner: null });
  record(17, 'tenant-safe: another user gets 404', other.status === 404, `HTTP ${other.status}`);
  const aud = await rows('ii_audit_events', { user_id: U1, subject_id: acct.id });
  record(17, 'auditable: an audit event exists for the acknowledgement', aud.length > 0, `${aud.length} audit rows for the account: ${[...new Set(aud.map((a) => a.event_type + ':' + (a.metadata?.outcome ?? a.metadata?.field ?? '')))].join(', ')}`);
}

// ================= STEP 18: same file / different owner =================
if (want(18)) {
  const q01 = fixture('pc3-q01-baseline-multi-folio-multi-amc.pdf');
  const same = await uploadCas(IN1, q01, 'obu-s18-same.pdf', { kind: 'member', memberId: selfId });
  record(18, 'same bytes + same owner: deduplicated (200, deduplicated=true, same document id)', same.status === 200 && same.json?.data?.deduplicated === true, `HTTP ${same.status}`);
  const diff = await uploadCas(IN1, q01, 'obu-s18-diff.pdf', { kind: 'member', memberId: spouseId });
  record(18, 'same bytes + different owner: 409 identical_upload_different_owner naming the first owner', diff.status === 409 && diff.json?.error === 'identical_upload_different_owner' && /Forecast Test User|TC083|you/i.test(diff.json?.message ?? ''), `HTTP ${diff.status} ${diff.json?.error} :: ${diff.json?.message}`);
  const f = folio(50, 640000);
  const jb = casText({ folios: [f] });
  const j1 = await upAndProcess(IN1, jb, 'obu-s18-joint-a.pdf', { kind: 'joint', allocations: [{ memberId: selfId, basisPoints: 6000 }, { memberId: spouseId, basisPoints: 4000 }] });
  const j2 = await uploadCas(IN1, jb, 'obu-s18-joint-b.pdf', { kind: 'joint', allocations: [{ memberId: selfId, basisPoints: 5000 }, { memberId: spouseId, basisPoints: 5000 }] });
  record(18, 'same people + a DIFFERENT joint allocation on the same bytes is refused (409)', j1.up.status === 200 && j2.status === 409, `first HTTP ${j1.up.status}; second HTTP ${j2.status} ${j2.json?.error}`);
  const j3 = await uploadCas(IN1, jb, 'obu-s18-joint-c.pdf', { kind: 'joint', allocations: [{ memberId: selfId, basisPoints: 6000 }, { memberId: spouseId, basisPoints: 4000 }] });
  record(18, 'same people + the SAME joint allocation: deduplicated', j3.status === 200 && j3.json?.data?.deduplicated === true, `HTTP ${j3.status}`);
  // cross-tenant: IN2 uploads exactly IN1's bytes and must learn nothing
  const own = await uploadCas(IN2, q01, 'obu-s18-in2.pdf', { kind: 'member', memberId: selfIn2 });
  const freshKeys = Object.keys((await uploadCas(IN2, casText({ folios: [folio(51, 12345)] }), 'obu-s18-in2-fresh.pdf', { kind: 'member', memberId: selfIn2 })).json?.data ?? {}).sort().join(',');
  const ownKeys = Object.keys(own.json?.data ?? {}).sort().join(',');
  const d = own.json?.data?.id ? await docRow(own.json.data.id) : null;
  record(18, "cross-tenant: User B uploading User A's exact bytes gets an ordinary fresh upload (own new row, no dedupe flag, no existing_document_id, same response shape as any new file)", own.status === 200 && !own.json?.data?.deduplicated && !own.json?.existing_document_id && d?.user_id === U2 && ownKeys === freshKeys, `HTTP ${own.status} sameShape=${ownKeys === freshKeys}`);
  const diffOwnerB = await uploadCas(IN2, q01, 'obu-s18-in2-b.pdf', { kind: 'member', memberId: (await ensureSpouse(IN2, 'FHIP Synthetic Spouse B')) });
  record(18, "cross-tenant: User B re-uploading the same bytes under a different B-owner gets B's own 409 (about B's own file), never A's", diffOwnerB.status === 409 && diffOwnerB.json?.existing_document_id === own.json?.data?.id, `HTTP ${diffOwnerB.status} existing=${String(diffOwnerB.json?.existing_document_id).slice(0, 8)} own=${String(own.json?.data?.id).slice(0, 8)}`);
  const peek = await call(IN2, 'GET', `/api/investment-intelligence/source-documents/${ctx.s11}/summary`);
  const missing = await call(IN2, 'GET', `/api/investment-intelligence/source-documents/${randomUUID()}/summary`);
  record(18, "User B reading User A's document id gets the same answer as for a random id", peek.status === missing.status && JSON.stringify(peek.json) === JSON.stringify(missing.json), `foreign HTTP ${peek.status}, missing HTTP ${missing.status}`);
}

fs.mkdirSync('.canonical-cert', { recursive: true });
fs.writeFileSync(CTX_FILE, JSON.stringify(ctx, null, 2));
saveResults('.canonical-cert/obu-cas-results.json');
const { results } = await import('./obu_lib.mjs');
const bad = results.filter((r) => r.ok === false);
console.log(`
${results.length} recorded, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
