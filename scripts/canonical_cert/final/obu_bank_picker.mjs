/**
 * Owner-before-upload DEV certification: "which account is this statement for?" (spec steps 23 and 24, bank CSV).
 *   node scripts/canonical_cert/final/obu_bank_picker.mjs
 * Actors: AU3 = forecast.tc015 (ledger OBU3), AU4 = forecast.tc024 (cross-tenant). Localhost app on port 3991, DEV only.
 */
import { randomUUID } from 'node:crypto';
import { call, db, hostGuard, record, saveResults, results, selfMember } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const sb = await db();
const AU3 = 'forecast.tc015@example.test';
const AU4 = 'forecast.tc024@example.test';
const salt = String(Math.floor(1000 + Math.random() * 9000));
const uid = async (email) => (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email)?.id;
const U3 = await uid(AU3);
const U4 = await uid(AU4);
let seq = 0;
const csv = () => {
  seq += 1;
  return Buffer.from(['Date,Description,Debit Amount,Credit Amount,Balance', `01/03/2026,PICK ${salt} ${seq} A,10.00,,990.00`, `02/03/2026,PICK ${salt} ${seq} B,,50.00,1040.00`, ''].join('\n'));
};
const self3 = await selfMember(AU3);
const self4 = await selfMember(AU4);
const up = (email, owner, extra = '', cur = 'AUD') => call(email, 'POST', `/api/financial-data-hub/bank-csv/upload?country_code=AU&currency_code=${cur}${extra}`, { body: csv(), contentType: 'text/csv', owner: { kind: 'member', memberId: email === AU3 ? self3 : self4 } });
const doc = async (id) => (await sb.from('fdh_statement_uploads').select('*').eq('id', id).single()).data;
const accounts = async (uid2) => ((await sb.from('fdh_financial_accounts').select('*').eq('user_id', uid2)).data ?? []);
const resolve = (email, id, body = {}) => call(email, 'POST', `/api/financial-data-hub/bank-statements/${id}/resolve-account`, { json: body, owner: null });
const reviewItems = async (docId) => (await sb.from('fdh_review_items').select('*').eq('statement_upload_id', docId)).data ?? [];

// ---------------- 23: CSV account picker ----------------
// (a) known adapter bank, no digits, no account yet
const r1 = await up(AU3);
record(23, 'CSV, no digits, no existing account: a new account is created and linked (no picker needed, no forced re-upload)', r1.status === 200 && r1.json?.data?.account_resolution === 'created' && !!r1.json?.data?.financial_account_id, `HTTP ${r1.status} ${r1.json?.data?.account_resolution}`);
const A1 = r1.json?.data?.financial_account_id;
// (b) one existing account, still no digits
const r2 = await up(AU3);
record(23, 'CSV, no digits, exactly ONE existing account: reused silently, linked to that account', r2.status === 200 && r2.json?.data?.account_resolution === 'reused' && r2.json?.data?.financial_account_id === A1, `HTTP ${r2.status} ${r2.json?.data?.account_resolution}`);
// (c) a second account (declared digits) makes the next digit-less upload ambiguous
const r3 = await up(AU3, null, '&masked_identifier=%2A%2A%2A%2A7777');
const A2 = r3.json?.data?.financial_account_id;
record(23, 'CSV with declared last digits 7777: a NEW separate account is created (not merged into the first)', r3.status === 200 && r3.json?.data?.account_resolution === 'created' && A2 && A2 !== A1, `HTTP ${r3.status} ${r3.json?.data?.account_resolution}`);
const r4 = await up(AU3);
const D4 = r4.json?.data?.document_id;
record(23, 'CSV, no digits, MULTIPLE accounts: ambiguous (never silently guessed); the document is not linked and a blocking review item is open', r4.status === 200 && r4.json?.data?.account_resolution === 'ambiguous' && (await doc(D4)).financial_account_id === null && (await reviewItems(D4)).some((x) => x.status === 'open'), `HTTP ${r4.status} ${r4.json?.data?.account_resolution}`);
const probe = await resolve(AU3, D4, {});
record(23, 'picker: resolving with no choice answers needs_choice and lists the candidate accounts (display name + last digits only)', probe.status === 200 && probe.json?.data?.status === 'needs_choice' && (probe.json.data.candidates ?? []).length >= 2 && !JSON.stringify(probe.json).match(/\d{7,}/), JSON.stringify(probe.json?.data).slice(0, 260));
const pick = await resolve(AU3, D4, { account_id: A2 });
const d4 = await doc(D4);
record(23, 'picker: choosing an existing account assigns it on the SAME document (no re-upload); the review item closes', pick.status === 200 && pick.json?.data?.status === 'assigned' && d4.financial_account_id === A2 && !(await reviewItems(D4)).some((x) => x.status === 'open'), `HTTP ${pick.status} how=${pick.json?.data?.how} status=${d4.processing_status}`);
const r5 = await up(AU3);
const D5 = r5.json?.data?.document_id;
const neu = await resolve(AU3, D5, { new_account_digits: '8888', new_account_name: 'FHIP Synthetic Savings' });
const d5 = await doc(D5);
const newAcct = d5.financial_account_id ? (await sb.from('fdh_financial_accounts').select('*').eq('id', d5.financial_account_id).single()).data : null;
record(23, 'picker: "a different / new account" with last digits creates the account and assigns it on the same document', neu.status === 200 && !!newAcct && newAcct.id !== A1 && newAcct.id !== A2 && /8888$/.test(newAcct.masked_identifier ?? ''), `HTTP ${neu.status} masked=${newAcct?.masked_identifier}`);
record(23, 'privacy: no stored account identifier is longer than 6 digits (last digits only)', (await accounts(U3)).every((a) => !(a.masked_identifier ?? '').replace(/\D/g, '').match(/\d{7,}/)), JSON.stringify((await accounts(U3)).map((a) => a.masked_identifier)));
const badDigits = await resolve(AU3, (await up(AU3)).json?.data?.document_id, { new_account_digits: '1234567890' });
record(23, 'privacy: a FULL account number (10 digits) is refused, never stored', badDigits.status >= 400, `HTTP ${badDigits.status} ${badDigits.json?.code ?? badDigits.json?.error}`);

// ---------------- 24: reassignment ----------------
const again = await resolve(AU3, D4, { account_id: A2 });
record(24, 'idempotent: choosing the SAME account again succeeds and changes nothing', again.status === 200 && (await doc(D4)).financial_account_id === A2, `HTTP ${again.status} how=${again.json?.data?.how}`);
const other = await resolve(AU3, D4, { account_id: A1 });
record(24, 'a DIFFERENT account after assignment is refused 409 already_assigned_to_other; the link is unchanged', other.status === 409 && other.json?.error === 'already_assigned_to_other' && (await doc(D4)).financial_account_id === A2, `HTTP ${other.status} ${other.json?.error}`);
// race
const r6 = await up(AU3);
const D6 = r6.json?.data?.document_id;
const [x, y] = await Promise.all([resolve(AU3, D6, { account_id: A1 }), resolve(AU3, D6, { account_id: A2 })]);
const winner = (await doc(D6)).financial_account_id;
const oks = [x, y].filter((r) => r.status === 200).length;
record(24, 'race: two simultaneous different choices -> exactly one winner, the other 409, and the stored link is the winner', oks === 1 && [x, y].some((r) => r.status === 409) && [A1, A2].includes(winner) && (winner === A1) === (x.status === 200), `statuses ${x.status}/${y.status}, winner ${String(winner).slice(0, 8)}`);
// wrong currency
const inr = await call(AU3, 'POST', '/api/financial-data-hub/bank-csv/upload?country_code=AU&currency_code=INR&masked_identifier=%2A%2A%2A%2A9999', { body: csv(), contentType: 'text/csv', owner: { kind: 'member', memberId: self3 } });
const INRacct = inr.json?.data?.financial_account_id;
const r7 = await up(AU3);
const D7 = r7.json?.data?.document_id;
const wc = await resolve(AU3, D7, { account_id: INRacct });
record(24, 'wrong currency: an INR account cannot be chosen for an AUD statement (refused, nothing linked)', !!INRacct && wc.status >= 400 && wc.status < 500 && (await doc(D7)).financial_account_id === null, `HTTP ${wc.status} ${wc.json?.code ?? ''}`);
// closed account
const closeId = A1;
await sb.from('fdh_financial_accounts').update({ status: 'closed', closed_at: '2026-03-31' }).eq('id', closeId);
const cl = await resolve(AU3, D7, { account_id: closeId });
record(24, 'closed account: refused, nothing linked', cl.status >= 400 && cl.status < 500 && (await doc(D7)).financial_account_id === null, `HTTP ${cl.status} ${cl.json?.code ?? ''}`);
await sb.from('fdh_financial_accounts').update({ status: 'active', closed_at: null }).eq('id', closeId);
// cross-tenant
const missingDoc = await resolve(AU4, randomUUID(), { account_id: A2 });
const foreignDoc = await resolve(AU4, D7, { account_id: A2 });
record(24, "cross-tenant: User B resolving User A's statement gets exactly the answer a random statement id gets (404)", foreignDoc.status === 404 && missingDoc.status === 404 && JSON.stringify(foreignDoc.json) === JSON.stringify(missingDoc.json), `foreign ${foreignDoc.status} missing ${missingDoc.status}`);
await up(AU4, null, '&masked_identifier=%2A%2A%2A%2A1212');
await up(AU4, null, '&masked_identifier=%2A%2A%2A%2A3434');
const own4r = await up(AU4);
const own4 = own4r.json?.data?.document_id;
record(24, 'precondition for the cross-tenant account probe: User B has two accounts and an ambiguous statement', own4r.json?.data?.account_resolution === 'ambiguous', own4r.json?.data?.account_resolution);
const foreignAcct = await resolve(AU4, own4, { account_id: A2 });
const missingAcct = await resolve(AU4, own4, { account_id: randomUUID() });
record(24, "cross-tenant: User B choosing User A's account is indistinguishable from a random account id (404, identical body)", foreignAcct.status === 404 && missingAcct.status === 404 && JSON.stringify(foreignAcct.json) === JSON.stringify(missingAcct.json), `foreign ${foreignAcct.status} missing ${missingAcct.status}`);
// review state returns to processing through declared transitions
const r8 = await up(AU3);
const D8 = r8.json?.data?.document_id;
const before8 = await doc(D8);
await resolve(AU3, D8, { account_id: A2 });
const after8 = await doc(D8);
record(24, 'an unresolved statement returns to normal processing once an account is assigned (declared transition; the blocking review item closes)', after8.financial_account_id === A2 && !(await reviewItems(D8)).some((x2) => x2.status === 'open' && /ambiguous/.test(x2.title_code ?? '')), `status ${before8.processing_status} -> ${after8.processing_status}`);
const det = await call(AU3, 'POST', `/api/financial-data-hub/bank-csv/${D8}/detect`, { owner: null });
const pr = await call(AU3, 'POST', `/api/financial-data-hub/bank-csv/${D8}/process`, { owner: null });
const tx = (await sb.from('fdh_transactions').select('financial_account_id').eq('statement_upload_id', D8)).data ?? [];
record(24, 'after assignment the same document processes and its transactions land on the chosen account', det.status < 300 && pr.status < 300 && tx.length === 2 && tx.every((t) => t.financial_account_id === A2), `detect ${det.status} process ${pr.status} txns ${tx.length}`);

saveResults('.canonical-cert/obu-bank-picker-results.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
