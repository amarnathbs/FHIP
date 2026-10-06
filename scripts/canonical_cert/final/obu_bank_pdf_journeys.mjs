/**
 * Owner-before-upload DEV certification: BANK PDF (spec steps 20 and 22) and the malware-admission boundary (step 28).
 *   npx tsx scripts/canonical_cert/final/obu_bank_pdf_journeys.mjs
 * Actor: AU3 = forecast.tc015 (ledger OBU3). Synthetic PDFs from the repository's own generators (tests/support). Port 3991, DEV only.
 */
import { buildBankPdfFixture } from '../../../tests/support/buildBankPdfFixture.ts';
import { buildEncryptedTextPdf } from '../../../tests/support/buildEncryptedCamsPdf.ts';
import { buildTruncatedPdf } from '../../../tests/support/buildMinimalPdf.ts';
import { call, db, hostGuard, record, saveResults, results, selfMember, ensureSpouse } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const sb = await db();
const AU3 = 'forecast.tc015@example.test';
const U3 = (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === AU3).id;
const self = await selfMember(AU3);
const spouse = await ensureSpouse(AU3, 'FHIP Synthetic Spouse AU3');
const salt = String(Math.floor(1000 + Math.random() * 9000));
let seq = 0;
const CBA = { brand: ['Commonwealth Bank of Australia', 'Statement of Account'], cols: 'Date Transaction Details Debit Credit Balance' };
const ANZ = { brand: ['Australia and New Zealand Banking Group', 'Account Statement'], cols: 'Date Narrative Amount Balance' };
function pdf(bank, accountLine) {
  seq += 1;
  const txns = bank === ANZ
    ? [{ date: '01/08/2026', description: `EFTPOS COLES ${salt}${seq}`, amount: '-45.20', balance: '954.80' }, { date: '03/08/2026', description: 'SALARY XYZ PTY LTD', amount: '500.00', balance: '1,454.80' }]
    : [{ date: '1 Aug 2026', description: `CARD PURCHASE WOOLWORTHS ${salt}${seq}`, amount: '45.20 DR', balance: '954.80' }, { date: '3 Aug 2026', description: 'SALARY XYZ PTY LTD', amount: '500.00 CR', balance: '1,454.80' }];
  return new Uint8Array(buildBankPdfFixture({
    brandLines: bank.brand, columnHeaderLine: bank.cols, accountLine,
    openingBalanceLine: 'Opening Balance: $1,000.00', closingBalanceLine: bank === ANZ ? 'Closing Balance: $1,454.80' : 'Closing Balance: $1,454.80', transactions: txns,
  }));
}
const up = (bytes, owner, extra = '') => call(AU3, 'POST', `/api/financial-data-hub/bank-pdf/upload?country_code=AU&currency_code=AUD${extra}`, { body: Buffer.from(bytes), contentType: 'application/pdf', owner });
const doc = async (id) => (await sb.from('fdh_statement_uploads').select('*').eq('id', id).single()).data;
const acct = async (id) => (await sb.from('fdh_financial_accounts').select('*').eq('id', id).single()).data;
const processDoc = (id) => call(AU3, 'POST', `/api/financial-data-hub/bank-pdf/${id}/process`, { json: {}, owner: null });
const resolve = (id, body = {}) => call(AU3, 'POST', `/api/financial-data-hub/bank-statements/${id}/resolve-account`, { json: body, owner: null });
/** what the UI does after an upload: ask the server to resolve the account; if it only suggests, accept the suggestion */
async function settle(id) {
  const first = await resolve(id, {});
  if (first.json?.data?.status === 'assigned') return { how: first.json.data.how, resolved: first };
  const sug = first.json?.data?.suggestion;
  if (sug?.last_digits) {
    const acc = await resolve(id, { new_account_digits: sug.last_digits });
    return { how: acc.json?.data?.how ?? 'new_account:' + acc.status, resolved: acc, suggestion: sug };
  }
  return { how: 'needs_choice', resolved: first };
}
const O = { self: { kind: 'member', memberId: self }, spouse: { kind: 'member', memberId: spouse }, joint: { kind: 'joint' }, smsf: { kind: 'smsf' } };

// ================= STEP 20: bank PDF, Self / Spouse / Joint / SMSF =================
const made = {};
let n = 0;
for (const [role, wire] of Object.entries(O)) {
  n += 1;
  const digits = String(5000 + n);
  const r = await up(pdf(CBA, `Account Number: ****${digits}`), wire);
  const id = r.json?.data?.document_id;
  record(20, `Bank PDF as ${role}: accepted (owner chosen first)`, r.status === 200 && !!id, `HTTP ${r.status} resolution=${r.json?.data?.account_resolution} ${r.json?.error ?? ''}`);
  if (!id) continue;
  const d = await doc(id);
  let how = 'created at upload';
  if (r.json?.data?.account_resolution === 'ambiguous') how = (await settle(id)).how;
  const pr = await processDoc(id);
  const d2 = await doc(id);
  const a = d2.financial_account_id ? await acct(d2.financial_account_id) : null;
  record(20, `${role}: DB document owner ${role} / user_selected; the account it ended on carries the same owner_role; account linked (${how})`, d.owner_role === role && d.owner_selection_source === 'user_selected' && !!a && a.owner_role === role, JSON.stringify({ doc: d.owner_role, acct: a?.owner_role, how, processing: pr.status, status: d2.processing_status }));
  made[role] = { id, accountId: d2.financial_account_id, digits };
  const tx = (await sb.from('fdh_transactions').select('financial_account_id').eq('statement_upload_id', id)).data ?? [];
  record(20, `${role}: transactions were read and sit on the owner's account`, tx.length >= 2 && tx.every((t) => t.financial_account_id === d2.financial_account_id), `${tx.length} transactions`);
}
const accts = (await sb.from('fdh_financial_accounts').select('owner_role,institution_id,masked_identifier').eq('user_id', U3)).data ?? [];
record(20, 'bank PDF: the four owner roles produced four separate accounts and only last digits are stored', ['self', 'spouse', 'joint', 'smsf'].every((r) => accts.some((a) => a.owner_role === r)) && accts.every((a) => !(a.masked_identifier ?? '').replace(/\D/g, '').match(/\d{7,}/)), JSON.stringify(accts.map((a) => [a.owner_role, !!a.institution_id, a.masked_identifier])));
record(20, 'SMSF bank PDF: owner attribution only (AU); personal totals isolation is proved in step 31 (SMSF cash-flow integration is deferred downstream, PARTIAL)', null, '');

// ================= STEP 22: account picker with a synthetic PDF =================
const cbaInst = (await sb.from('fdh_financial_accounts').select('institution_id').eq('user_id', U3).not('institution_id', 'is', null).limit(1)).data?.[0]?.institution_id ?? null;
// (1) one exact match
const e1 = await up(pdf(CBA, `Account Number: ****${made.self?.digits ?? '5001'}`), O.self);
const e1id = e1.json?.data?.document_id;
const e1s = await settle(e1id);
record(22, 'PDF, ONE exact match (printed digits = the Self CBA account): assigned to that account on the same document, no question asked', (await doc(e1id)).financial_account_id === made.self.accountId && e1s.how === 'auto_printed_identifier', `upload=${e1.json?.data?.account_resolution} how=${e1s.how}`);
// (2) full account number printed
const full = await up(pdf(CBA, 'Account Number: 062000 1234 5678 9012'), O.self);
const fullId = full.json?.data?.document_id;
const fp = await resolve(fullId, {});
const dumpFull = JSON.stringify([full.json, fp.json, await doc(fullId), (await sb.from('fdh_financial_accounts').select('*').eq('user_id', U3)).data]);
record(22, 'PDF printing a FULL account number: no full number in any API answer, document row or account row (trailing digits only)', !/0620001234567890|062000 1234|123456789012|1234 5678 9012|0620001234|34567890/.test(dumpFull), `suggestion=${JSON.stringify(fp.json?.data?.suggestion)}`);
// (3) no match
const nm = await up(pdf(CBA, 'Account Number: ****9999'), O.self);
const nmId = nm.json?.data?.document_id;
const nmRes = await resolve(nmId, {});
record(22, 'PDF, NO match (printed ****9999): not guessed; picker lists the existing accounts and suggests "add as a new account" with the bank name and ****9999', nmRes.json?.data?.status === 'needs_choice' && (nmRes.json?.data?.candidates ?? []).length >= 2 && nmRes.json?.data?.suggestion?.last_digits === '9999' && /Commonwealth/i.test(nmRes.json?.data?.suggestion?.institution_name ?? ''), JSON.stringify(nmRes.json?.data).slice(0, 360));
const nmNew = await resolve(nmId, { new_account_digits: '9999', new_account_name: 'FHIP Synthetic PDF Account' });
const nmAcct = (await doc(nmId)).financial_account_id;
const nmA = nmAcct ? await acct(nmAcct) : null;
record(22, 'accepting the suggestion creates the account (bank from the certified adapter, never free text) with the chosen OWNER, and links it', nmNew.status === 200 && !!nmA && nmA.owner_role === 'self', `HTTP ${nmNew.status} institution=${!!nmA?.institution_id} owner=${nmA?.owner_role}`);
// (4) multiple matches + bank-name tie-break
const anzPdf = await up(pdf(ANZ, `Account Number: ****${made.self?.digits ?? '5001'}`), O.self);
const anzId = anzPdf.json?.data?.document_id;
const anzS = await settle(anzId);
const anzAcct = (await doc(anzId)).financial_account_id;
record(22, 'bank-name tie-break: an ANZ PDF printing the same last digits as the CBA account does NOT take the CBA account (asked, or a separate account)', anzAcct !== made.self.accountId, `how=${anzS.how} sameAsCba=${anzAcct === made.self.accountId}`);
const again = await up(pdf(CBA, `Account Number: ****${made.self?.digits ?? '5001'}`), O.self);
const againId = again.json?.data?.document_id;
const againS = await settle(againId);
record(22, 'with both banks holding that last-digit pair, a CBA PDF still picks the CBA account (the bank name narrows the matches)', (await doc(againId)).financial_account_id === made.self.accountId, `how=${againS.how}`);
// (5) unrecognised / unreadable
const noBrand = Buffer.from(buildBankPdfFixture({ brandLines: ['Some Unknown Credit Union', 'Statement'], columnHeaderLine: 'Date Description Amount Balance', transactions: [{ date: '1 Aug 2026', description: 'X', amount: '1.00', balance: '2.00' }] }));
const nb = await up(noBrand, O.self);
const nbId = nb.json?.data?.document_id;
const nbS = nbId ? await resolve(nbId, {}) : null;
record(22, 'PDF from an unrecognised bank: owner still demanded and recorded; no bank or digits are invented (no suggestion). FINDING: with exactly one institution-less account the existing rule attaches it to that account (auto_single_account) without asking', nb.status === 200 && (nbS?.json?.data?.suggestion ?? null) === null && (await doc(nbId)).owner_role === 'self', `upload=${nb.json?.data?.account_resolution} resolve=${JSON.stringify(nbS?.json?.data).slice(0, 200)}`);
const corrupt = await up(new Uint8Array(buildTruncatedPdf()), O.self);
const cid = corrupt.json?.data?.document_id;
const cr = cid ? await resolve(cid, {}) : null;
record(22, 'unreadable (truncated) PDF: no account guessed; refused or the user is asked', corrupt.status >= 400 || (cid && (cr?.json?.data?.suggestion ?? null) === null), `HTTP ${corrupt.status} ${corrupt.json?.error ?? ''} resolve=${cr?.json?.data?.status}`);
// (6) password-protected
const enc = buildEncryptedTextPdf([[...CBA.brand, 'Account Number: ****5001', 'Opening Balance: $1,000.00', CBA.cols, '1 Aug 2026  CARD PURCHASE WOOLWORTHS 1234   45.20 DR   954.80']], 'obu-pass');
const ep = await up(new Uint8Array(enc.bytes), O.self);
const epId = ep.json?.data?.document_id;
const epRes = epId ? await resolve(epId, {}) : null;
record(22, 'password-protected PDF: reported as password required; nothing (bank, digits) is taken from a locked file', ep.json?.data?.password_required === true && (epRes?.json?.data?.suggestion ?? null) === null && epRes?.json?.data?.how !== 'auto_printed_identifier', `password_required=${ep.json?.data?.password_required} resolve=${JSON.stringify(epRes?.json?.data).slice(0, 200)}`);

// ================= STEP 28: malware admission boundary (live) =================
// The statement prints the digits of the SPOUSE's CBA account. If the identity reader parses it, the answer is auto_printed_identifier
// to that account. If the admission guard stops the reader, nothing printed may influence the answer.
const bl = await up(pdf(CBA, 'Account Number: ****' + made.spouse.digits), O.spouse);
const blId = bl.json?.data?.document_id;
const upd = await sb.from('fdh_statement_uploads').update({ malware_scan_status: 'malicious', financial_account_id: null }).eq('id', blId);
const blRes = await resolve(blId, {});
record(28, 'live: a document whose malware scan is "malicious" is NOT parsed by the bank identity reader (the printed digits do not select the account; no suggestion)', !upd.error && blRes.json?.data?.how !== 'auto_printed_identifier' && blRes.json?.data?.financial_account_id !== made.spouse.accountId && (blRes.json?.data?.suggestion ?? null) === null, 'update=' + (upd.error?.message ?? 'ok') + ' ' + JSON.stringify(blRes.json).slice(0, 240));
await sb.from('fdh_statement_uploads').update({ malware_scan_status: 'not_required', financial_account_id: null }).eq('id', blId);
const okRes = await resolve(blId, {});
record(28, 'CONTROL: the same document with the scan state restored IS read: the printed digits select the Spouse account (auto_printed_identifier), so the refusal above was the admission guard', okRes.json?.data?.how === 'auto_printed_identifier' && okRes.json?.data?.financial_account_id === made.spouse.accountId, JSON.stringify(okRes.json).slice(0, 240));

saveResults('.canonical-cert/obu-bank-pdf-results.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
globalThis.process.exit(bad.length ? 1 : 0);
