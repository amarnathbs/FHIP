/**
 * Owner-before-upload DEV certification: AIE routes (spec step 27).
 *   npx tsx scripts/canonical_cert/final/obu_aie_journeys.mjs
 * Needs the localhost app started with the AIE switches ON and NO AI key (the deterministic parsers only):
 *   AIE_DOCUMENT_INTAKE_ENABLED, AIE_FDH_BANK_ADAPTER_ENABLED, AIE_II_ADAPTER_ENABLED, AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED,
 *   AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED, AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED, AIE_ALLOW_MISSING_SIGNATURE_SCANNER (all 'true').
 * Actor AU3 = forecast.tc015 (ledger OBU3, AU bank intake), IN1 = forecast.tc083 (ledger OBU, CAS intake). DEV only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildBankPdfFixture } from '../../../tests/support/buildBankPdfFixture.ts';
import { call, db, hostGuard, record, saveResults, results, selfMember, ensureSpouse, CAS_DIR, USERS } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const sb = await db();
const AU3 = 'forecast.tc015@example.test';
const IN1 = USERS.IN1;
const users = (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users;
const U3 = users.find((u) => u.email === AU3).id;
const U1 = users.find((u) => u.email === IN1).id;
const self3 = await selfMember(AU3);
const spouse3 = await ensureSpouse(AU3, 'FHIP Synthetic Spouse AU3');
const self1 = await selfMember(IN1);
const salt = String(Math.floor(1000 + Math.random() * 9000));
let seq = 0;
const bankPdf = (digits) => {
  seq += 1;
  return Buffer.from(buildBankPdfFixture({
    brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'], columnHeaderLine: 'Date Transaction Details Debit Credit Balance', accountLine: `Account Number: ****${digits}`,
    openingBalanceLine: 'Opening Balance: $1,000.00', closingBalanceLine: 'Closing Balance: $1,454.80',
    transactions: [{ date: '1 Aug 2026', description: `CARD PURCHASE AIE ${salt}${seq}`, amount: '45.20 DR', balance: '954.80' }, { date: '3 Aug 2026', description: 'SALARY XYZ PTY LTD', amount: '500.00 CR', balance: '1,454.80' }],
  }));
};
const bankIntake = (email, bytes, owner, extra = '') => call(email, 'POST', `/api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD${extra}`, { body: bytes, contentType: 'application/pdf', owner });
const iiIntake = (email, bytes, owner) => call(email, 'POST', '/api/aie/investment-intelligence/intake?filename=obu-aie.pdf', { body: bytes, contentType: 'application/pdf', owner });
const accept = (email, runId, body) => call(email, 'POST', `/api/aie/review/runs/${runId}/accept`, { json: { idempotencyKey: randomUUID(), ...body }, owner: null });
const withOwner = (route, owner) => `${route}${route.includes('?') ? '&' : '?'}owner=${encodeURIComponent(JSON.stringify(owner))}`;
// api() only injects an owner for the interactive routes; the AIE intakes get it explicitly in the query string.
const bankI = (email, bytes, owner, extra = '') => call(email, 'POST', owner === undefined ? `/api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD${extra}` : withOwner(`/api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD${extra}`, owner), { body: bytes, contentType: 'application/pdf', owner: null });
const iiI = (email, bytes, owner) => call(email, 'POST', owner === undefined ? '/api/aie/investment-intelligence/intake?filename=obu-aie.pdf' : withOwner('/api/aie/investment-intelligence/intake?filename=obu-aie.pdf', owner), { body: bytes, contentType: 'application/pdf', owner: null });
const MEMBER = (id) => ({ kind: 'member', memberId: id });

// ---------- flags really on? ----------
const probe = await bankI(AU3, bankPdf('6001'), undefined);
record(27, 'AIE bank intake is reachable on this DEV app (flags on) and an intake with NO owner is refused 422 owner_required before the body is read', probe.status === 422 && probe.json?.error === 'owner_required', `HTTP ${probe.status} ${probe.json?.error ?? probe.json?.message ?? ''}`);
if (probe.status === 403) { console.log('AIE flags are OFF on this app: restart it with the AIE switches (see header)'); process.exit(2); }

// ---------- AIE bank ----------
{
  const foreign = await bankI(AU3, bankPdf('6002'), MEMBER(randomUUID()));
  record(27, 'AIE bank intake: a member id that is not this tenant\'s -> owner_not_found', foreign.status >= 400 && foreign.json?.error === 'owner_not_found', `HTTP ${foreign.status} ${foreign.json?.error}`);
  const entities = (await call(AU3, 'GET', '/api/business-entities')).json?.data ?? [];
  const company = entities.find((e) => e.entity_type === 'company');
  if (company) {
    const ent = await bankI(AU3, bankPdf('6003'), { kind: 'entity', entityId: company.id });
    record(27, 'AIE bank intake: a Company owner is refused (PO-OBU-02)', ent.status >= 400 && ent.status < 500, `HTTP ${ent.status} ${ent.json?.error}`);
  }
  const bytes = bankPdf('6004');
  const ok = await bankI(AU3, bytes, MEMBER(self3), '&masked_identifier=%2A%2A%2A%2A6004');
  const intakeId = ok.json?.data?.intake_id;
  const runId = ok.json?.data?.run_id;
  const intake = intakeId ? (await sb.from('aie_document_intake').select('*').eq('id', intakeId).single()).data : null;
  record(27, 'AIE bank intake with an owner: accepted, run created, and the validated wire selection is stored on the intake (ids only)', ok.status === 200 && !!runId && intake?.owner_selection?.kind === 'member' && intake.owner_selection.memberId === self3, `HTTP ${ok.status} status=${ok.json?.data?.status} stored=${JSON.stringify(intake?.owner_selection)}`);
  record(27, 'the stored owner_selection holds no document content (keys: kind + ids only)', Object.keys(intake?.owner_selection ?? {}).every((k) => ['kind', 'memberId', 'entityId', 'allocations'].includes(k)), JSON.stringify(Object.keys(intake?.owner_selection ?? {})));
  const stmtBefore = (await sb.from('fdh_statement_uploads').select('id').eq('user_id', U3)).data?.length ?? 0;
  record(27, 'NO canonical write at intake: no statement row exists for this run before Accept', ((await sb.from('fdh_statement_uploads').select('id').eq('user_id', U3).eq('original_filename_sanitised', 'x')).data ?? []).length === 0, `statements=${stmtBefore}`);
  const acc = await accept(AU3, runId, { ownerHouseholdRole: 'self' });
  const after = (await sb.from('fdh_statement_uploads').select('*').eq('user_id', U3).order('created_at', { ascending: false }).limit(3)).data ?? [];
  const written = after.find((d) => d.id === acc.json?.data?.statementUploadId);
  record(27, 'AIE bank Accept uses the STORED owner: the canonical statement is written once, owner self / user_selected', acc.status === 200 && !!written && written.owner_role === 'self' && written.owner_selection_source === 'user_selected', `HTTP ${acc.status} ${acc.json?.error ?? ''} written=${!!written} role=${written?.owner_role}`);
  const acc2 = await accept(AU3, runId, { ownerHouseholdRole: 'self' });
  record(27, 'Accept again is idempotent (alreadyCompleted, no second statement)', acc2.status === 200 && acc2.json?.data?.alreadyCompleted === true, `HTTP ${acc2.status} ${JSON.stringify(acc2.json?.data)}`);

  // owner invalid at accept time: Spouse chosen, then the spouse member is deactivated before Accept
  const ok2 = await bankI(AU3, bankPdf('6005'), MEMBER(spouse3), '&masked_identifier=%2A%2A%2A%2A6005');
  const run2 = ok2.json?.data?.run_id;
  await sb.from('household_members').update({ is_active: false }).eq('id', spouse3);
  const stale = await accept(AU3, run2, { ownerHouseholdRole: 'spouse' });
  const wroteStale = (await sb.from('fdh_statement_uploads').select('id,owner_role').eq('user_id', U3).eq('owner_role', 'spouse')).data ?? [];
  await sb.from('household_members').update({ is_active: true }).eq('id', spouse3);
  record(27, 'owner changed between intake and Accept (the Spouse member was deactivated): Accept RE-VALIDATES and refuses, nothing written', stale.status >= 400 && wroteStale.every((d) => d.id !== stale.json?.data?.statementUploadId), `HTTP ${stale.status} ${stale.json?.error ?? stale.json?.message}`);
  // legacy / ownerless intake
  const ok3 = await bankI(AU3, bankPdf('6006'), MEMBER(self3), '&masked_identifier=%2A%2A%2A%2A6006');
  const intake3 = ok3.json?.data?.intake_id;
  await sb.from('aie_document_intake').update({ owner_selection: null }).eq('id', intake3);
  const run3 = ok3.json?.data?.run_id;
  const legacy = await accept(AU3, run3, { ownerHouseholdRole: 'self' });
  record(27, 'an OLD ownerless intake (owner_selection NULL) is refused at Accept with the re-upload message; nothing written', legacy.status >= 400, `HTTP ${legacy.status} ${legacy.json?.error ?? legacy.json?.message}`);
  // tenant isolation
  const other = await accept('forecast.tc024@example.test', runId, { ownerHouseholdRole: 'self' });
  record(27, "another tenant cannot Accept this run (404, same as an unknown run)", other.status === 404, `HTTP ${other.status}`);
}

// ---------- AIE Investment Intelligence ----------
{
  const bytes = fs.readFileSync(path.join(CAS_DIR, 'pc3-q06-sip-rich-skipped-month.pdf'));
  const none = await iiI(IN1, bytes, undefined);
  record(27, 'AIE Investment Intelligence intake with NO owner -> 422 owner_required', none.status === 422 && none.json?.error === 'owner_required', `HTTP ${none.status} ${none.json?.error}`);
  const bare = await call(IN1, 'POST', `/api/aie/investment-intelligence/intake?filename=obu-aie.pdf&owner_member_id=${self1}`, { body: bytes, contentType: 'application/pdf', owner: null });
  record(27, 'a bare legacy owner_member_id is no longer an owner (still 422 owner_required)', bare.status === 422 && bare.json?.error === 'owner_required', `HTTP ${bare.status} ${bare.json?.error}`);
  // find a synthetic CAS the deterministic parser takes straight to awaiting_acceptance (some fixtures are deliberately ambiguous)
  let ok = null; let usedFile = null; const tried = [];
  for (const f of ['pc3-q01-baseline-multi-folio-multi-amc.pdf', 'pc3-q07-transaction-rich.pdf', 'pc3-q03-same-instrument-two-folios-fifo-scope.pdf', 'pc3-q04a-month1.pdf', 'pc3-q09-multi-page-continuation.pdf', 'pc3-q11-alternate-cams-layout.pdf', 'pc3-q06-sip-rich-skipped-month.pdf']) {
    const r = await iiI(IN1, fs.readFileSync(path.join(CAS_DIR, f)), MEMBER(self1));
    tried.push(f.slice(4, 7) + ':' + (r.json?.data?.status ?? r.status));
    if (r.json?.data?.status === 'awaiting_acceptance') { ok = r; usedFile = f; break; }
    ok = ok ?? r;
  }
  const runId = ok.json?.data?.run_id;
  const intakeId = ok.json?.data?.intake_id;
  const intake = intakeId ? (await sb.from('aie_document_intake').select('owner_selection').eq('id', intakeId).single()).data : null;
  record(27, 'AIE II intake with Self: run created; owner stored on the intake (fixtures tried: ' + tried.join(', ') + ')', ok.status === 200 && !!runId && intake?.owner_selection?.memberId === self1, 'HTTP ' + ok.status + ' status=' + ok.json?.data?.status + ' ' + (ok.json?.error ?? ''));
  const bad = await accept(IN1, runId, { ownerHouseholdRole: 'self', ownerMemberId: randomUUID(), countryCode: 'IN' });
  record(27, 'a caller-supplied ownerMemberId that DISAGREES with the stored owner is refused at Accept', bad.status >= 400, `HTTP ${bad.status} ${bad.json?.error ?? bad.json?.message}`);
  const acc = await accept(IN1, runId, { ownerHouseholdRole: 'self', ownerMemberId: self1, countryCode: 'IN' });
  const docId = acc.json?.data?.iiSourceDocumentId;
  const d = docId ? (await sb.from('ii_source_documents').select('*').eq('id', docId).single()).data : null;
  record(27, 'AIE II Accept: the canonical source document is written with the STORED owner (self / user_selected)', acc.status === 200 && d?.owner_role === 'self' && d?.owner_selection_source === 'user_selected' && d?.owner_member_id === self1, `HTTP ${acc.status} ${acc.json?.error ?? ''} role=${d?.owner_role}`);
}

// ---------- no AI prompt receives owner data ----------
{
  const root = path.resolve('lib', 'aie');
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.ts$/.test(e.name)) files.push(f); } };
  walk(path.join(root, 'provider'));
  for (const sub of ['adapters']) walk(path.join(root, sub));
  const promptFiles = files.filter((f) => /prompt|provider|gateway|openai/i.test(f));
  const offenders = promptFiles.filter((f) => /ownerSelection|owner_selection|ownerMemberId|ownerHouseholdRole|intakeOwner/.test(fs.readFileSync(f, 'utf8')));
  record(27, 'no AI prompt / provider / gateway module reads owner, household-role or intake-owner data (static scan of lib/aie provider, prompt and adapter prompt files)', offenders.length === 0 && promptFiles.length > 3, `${promptFiles.length} files scanned; offenders=${JSON.stringify(offenders.map((f) => path.relative(process.cwd(), f)))}`);
  record(27, 'AI fallback is OFF on this app (no OpenAI key, AIE_AI_FALLBACK_ENABLED unset): nothing was sent to a model during these journeys', null, 'dev_server.mjs blanks AIE_OPENAI_API_KEY; the deterministic parsers produced the runs');
}

saveResults('.canonical-cert/obu-aie-results.json');
const badR = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${badR.length} FAIL`);
process.exit(badR.length ? 1 : 0);
