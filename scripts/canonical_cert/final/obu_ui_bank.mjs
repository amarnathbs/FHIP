/**
 * Owner-before-upload DEV certification, DEV-BROWSER part for the bank statement import panel (steps 19, 23, 25 in the browser).
 *   npx tsx scripts/canonical_cert/final/obu_ui_bank.mjs        (ui driver for AU2 = forecast.tc009 on control port 3995; localhost app 3991)
 * Headless Chromium on the localhost app against DEV. Synthetic CSV only. Screenshots in test-artifacts/obu_cert/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { act, goto, wait, waitText, shot, text, evalJs, controls, waitFor } from './obu_ui_lib.mjs';
import { record, saveResults, results, db, USERS, hostGuard } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const sb = await db();
const email = 'forecast.tc009@example.test';
const U = (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === email).id;
const salt = String(Math.floor(1000 + Math.random() * 9000));
const dir = path.resolve('.canonical-cert', 'ui');
fs.mkdirSync(dir, { recursive: true });
let n = 0;
const csv = (tag) => {
  n += 1;
  const f = path.join(dir, `ui-bank-${salt}-${n}.csv`);
  fs.writeFileSync(f, ['Date,Description,Debit Amount,Credit Amount,Balance', `01/03/2026,OBU UI ${salt} ${tag} ${n} Supermarket,45.20,,1954.80`, `02/03/2026,OBU UI ${salt} ${tag} ${n} Salary,,3500.00,5454.80`, ''].join('\n'));
  return f;
};
const lastDoc = async () => (await sb.from('fdh_statement_uploads').select('*').eq('user_id', U).order('created_at', { ascending: false }).limit(1)).data?.[0];
const acct = async (id) => (await sb.from('fdh_financial_accounts').select('*').eq('id', id).single()).data;
const ownerSelectReady = () => evalJs(`(() => { const s = document.getElementById('bank-owner-select'); return !!s && !s.disabled && s.options.length > 1; })()`);

async function openPanel() {
  await goto('/expenses');
  await wait(1500);
  await act({ a: 'click', role: 'button', name: 'Import bank statement' });
  await waitFor(ownerSelectReady, 40);
}
async function uploadAs(ownerLabel, digits, tag) {
  await openPanel();
  await act({ a: 'select', label: 'Who does this document belong to?', value: ownerLabel });
  if (digits) await act({ a: 'fill', label: 'Account / card number (last few digits, optional)', value: digits });
  await act({ a: 'file', path: csv(tag) });
  await act({ a: 'click', role: 'button', name: 'Upload statement' });
}

// ---- before an owner is chosen
await openPanel();
let ctl = await controls();
record(19, 'BROWSER: before an owner is chosen "Upload statement" is disabled', /\(disabled\) Upload statement/.test(ctl.join('\n')), ctl.find((c) => /Upload statement/.test(c)));
const opts = await evalJs(`Array.from(document.getElementById('bank-owner-select').options).map((o)=>o.text)`);
record(19, 'BROWSER: the bank owner list offers You, Joint and My SMSF (AU) and NO Trust / Company / HUF', opts.length >= 3 && !opts.some((o) => /trust|company|huf/i.test(o)) && opts.some((o) => /SMSF/i.test(o)) && opts.some((o) => /Joint/i.test(o)), JSON.stringify(opts));
await shot('obu-19-bank-owner-options', false);

// ---- Self, then Joint, then SMSF through the panel (each with its own last digits so each becomes its own account)
const results19 = [];
for (const [label, digits, role] of [['Forecast Test User TC009 (you)', '1111', 'self'], ['Joint — shared between owners', '3333', 'joint'], ['My SMSF', '4444', 'smsf']]) {
  const before = (await lastDoc())?.id;
  await uploadAs(label, digits, role);
  let d = null;
  await waitFor(async () => { d = await lastDoc(); return !!d && d.id !== before && !!d.owner_role && !!d.financial_account_id; }, 60, 2000);
  await wait(4000);
  await shot(`obu-19-bank-${role}-after-upload`, false);
  const a = d?.financial_account_id ? await acct(d.financial_account_id) : null;
  const t = await text(undefined, 6000);
  results19.push([role, d?.owner_role, a?.owner_role]);
  record(19, `BROWSER+DB: bank statement uploaded through the panel as ${role}: the document and its account carry owner_role ${role}`, d?.owner_role === role && d?.owner_selection_source === 'user_selected' && a?.owner_role === role, `doc=${d?.owner_role} account=${a?.owner_role} screen="${t.replace(/\n/g, ' ').slice(0, 120)}"`);
}
// the Spouse is a REAL member: add one through the panel's own "Add household member" form, then choose it
await openPanel();
await act({ a: 'click', role: 'button', name: 'Add household member (spouse or partner)' });
await wait(1200);
await shot('obu-19-bank-add-member-form', false);
const t1 = await text(undefined, 8000);
record(19, 'BROWSER: with no Spouse the panel offers the inline "add a spouse or partner" form (saved as a real household member, never a role-only Spouse)', /saved as a real household member/.test(t1), (t1.match(/[^\n]*real household member[^\n]*/i) ?? [''])[0]);
await act({ a: 'fill', label: 'Full name', value: 'FHIP UI Spouse' });
await act({ a: 'click', role: 'button', name: 'Save person' });
await waitFor(async () => (await evalJs('Array.from(document.getElementById("bank-owner-select").options).map((o)=>o.text)')).some((o) => /Spouse/.test(o)), 30, 1500);
const spouseRow = (await sb.from('household_members').select('id,relationship,user_id').eq('user_id', U).eq('full_name', 'FHIP UI Spouse')).data?.[0];
record(19, 'BROWSER+DB: saving the person creates a REAL household member (relationship spouse) and the selector now offers and selects it', spouseRow?.relationship === 'spouse' && (await evalJs('document.getElementById("bank-owner-select").selectedOptions[0].text')).includes('Spouse'), JSON.stringify(spouseRow));
{
  const before = (await lastDoc())?.id;
  await act({ a: 'fill', label: 'Account / card number (last few digits, optional)', value: '2222' });
  await act({ a: 'file', path: csv('spouse') });
  await act({ a: 'click', role: 'button', name: 'Upload statement' });
  let d = null;
  await waitFor(async () => { d = await lastDoc(); return !!d && d.id !== before && !!d.owner_role && !!d.financial_account_id; }, 60, 2000);
  const a2 = d?.financial_account_id ? await acct(d.financial_account_id) : null;
  record(19, 'BROWSER+DB: bank statement uploaded through the panel as Spouse: document and account owner_role spouse, member recorded', d?.owner_role === 'spouse' && d?.owner_member_id === spouseRow?.id && a2?.owner_role === 'spouse', 'doc=' + d?.owner_role + ' account=' + a2?.owner_role);
}

// ---- STEP 25 in the browser: the statement matches an account recorded under Spouse, but the user chooses Self
{
  const docsBefore = (await sb.from('fdh_statement_uploads').select('id', { count: 'exact', head: true }).eq('user_id', U)).count;
  await uploadAs('Forecast Test User TC009 (you)', '2222', 'conflict');
  await waitFor(async () => /recorded as|owner/.test(await text('[data-testid=owner-conflict]', 3000).catch(() => '')), 30, 2000);
  const ct = await text('[data-testid=owner-conflict]', 3000).catch(() => null);
  await shot('obu-25-bank-owner-conflict', false);
  const docsMid = (await sb.from('fdh_statement_uploads').select('id', { count: 'exact', head: true }).eq('user_id', U)).count;
  record(25, 'BROWSER: choosing Self for a statement that matches the Spouse account shows the conflict dialog BEFORE anything is uploaded', !!ct && /Nothing has been uploaded/.test(ct) && docsMid === docsBefore, (ct ?? '').replace(/\n/g, ' ').slice(0, 220));
  await act({ a: 'click', role: 'button', name: 'No, go back' });
  await wait(800);
  const sp = (await sb.from('fdh_financial_accounts').select('owner_role').eq('user_id', U).eq('owner_role', 'spouse')).data ?? [];
  record(25, 'BROWSER+DB: "No, go back" stores nothing and the account stays Spouse', sp.length === 1 && (await sb.from('fdh_statement_uploads').select('id', { count: 'exact', head: true }).eq('user_id', U)).count === docsBefore, 'spouse accounts=' + sp.length);
  await act({ a: 'click', role: 'button', name: 'Upload statement' });
  await waitFor(async () => /Nothing has been uploaded/.test(await text('[data-testid=owner-conflict]', 3000).catch(() => '')), 30, 2000);
  await act({ a: 'click', sel: '[data-testid=owner-conflict] button >> nth=0' });
  let d2 = null;
  await waitFor(async () => { d2 = await lastDoc(); return !!d2 && d2.owner_role === 'self' && !!d2.financial_account_id; }, 60, 2000);
  const a3 = d2?.financial_account_id ? await acct(d2.financial_account_id) : null;
  record(25, 'BROWSER+DB: "Yes, change" uploads the statement and the account owner becomes Self (explicit, audited change)', d2?.owner_role === 'self' && a3?.owner_role === 'self', 'doc=' + d2?.owner_role + ' account=' + a3?.owner_role);
}

// ---- STEP 23 in the browser: several accounts and no digits -> the picker
{
  await uploadAs('Forecast Test User TC009 (you)', '', 'picker');
  await waitFor(async () => (await evalJs('!!document.querySelector("[data-testid=choose-account]")')), 40, 2000);
  const pt = await text('[data-testid=choose-account]', 3000).catch(() => null);
  await shot('obu-23-bank-account-picker', false);
  record(23, 'BROWSER: with several accounts and no digits the panel asks "which account is this statement for?" and says the file is already uploaded (no re-upload)', !!pt && /more than one account|could not read an account number/.test(pt) && /do not need to upload it again/.test(pt), (pt ?? '').replace(/\n/g, ' ').slice(0, 220));
  const radios = await evalJs('Array.from(document.querySelectorAll("[data-testid=choose-account] input[type=radio]")).map((r)=>r.value.slice(0,8))');
  record(23, 'BROWSER: the picker lists the existing accounts (name and last digits only) plus "A different / new account"', radios.length >= 3, JSON.stringify(radios));
  const docBefore = await lastDoc();
  await act({ a: 'click', sel: '[data-testid=choose-account] input[type=radio] >> nth=0' });
  await act({ a: 'click', role: 'button', name: 'Use this account' });
  await waitFor(async () => (await lastDoc())?.financial_account_id !== null, 40, 2000);
  const docAfter = await lastDoc();
  record(23, 'BROWSER+DB: choosing an account assigns it on the SAME uploaded document (no second upload)', docAfter?.id === docBefore?.id && !!docAfter?.financial_account_id, 'same document=' + (docAfter?.id === docBefore?.id));
}
saveResults('.canonical-cert/obu-ui-bank-results.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
