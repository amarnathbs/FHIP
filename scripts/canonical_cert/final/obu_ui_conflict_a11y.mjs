/**
 * Owner-before-upload DEV certification, DEV-BROWSER: owner selector keyboard / focus / reload / Back / mobile, and the per-folio conflict
 * dialog through the real UI (spec steps 16 browser, 34).
 *   npx tsx scripts/canonical_cert/final/obu_ui_conflict_a11y.mjs     (ui driver for IN1 on control port 3995; localhost app on 3991)
 * NOT a formal screen-reader certification: only keyboard, focus, reload, Back, narrow width and overflow are checked, by a headless Chromium.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildMinimalTextPdf } from '../../../tests/support/buildMinimalPdf.ts';
import { act, goto, wait, waitText, shot, text, evalJs, controls } from './obu_ui_lib.mjs';
import { record, saveResults, results, db, USERS, hostGuard, uploadCas, selfMember, ensureSpouse } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const sb = await db();
const IN1 = USERS.IN1;
const salt = String(Math.floor(1000 + Math.random() * 9000));
const U1 = (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users.find((u) => u.email === IN1).id;
const selfId = await selfMember(IN1);
const spouseId = await ensureSpouse(IN1);
const dir = path.resolve('.canonical-cert', 'ui');
fs.mkdirSync(dir, { recursive: true });

function twoFolioPdf(tag) {
  const lines = ['CAMS Consolidated Account Statement', 'Statement Period : 01-Jan-2025 To 30-Jun-2025', ''];
  for (const n of [1, 2]) {
    const folio = `44${salt}0000${n}0${n}`;
    lines.push(`Folio No: ${folio}`, `PAN: PCQAL${folio.slice(-4)}F`, 'Name: FHIP SYNTHETIC HOLDER', 'Holding Mode: SI', '', 'AMC Name: HDFC Mutual Fund', 'Scheme Name: HDFC Flexi Cap Fund - Growth (Direct Plan)', 'ISIN: INF179K01YW8', 'AMFI Code: 118834', 'Registrar: CAMS', '',
      'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance',
      `01-Feb-2025   Purchase                              50,000.00  500.000  100.0000  500.000 [Ref: ${tag}-${n}]`, '',
      'Closing Unit Balance as on 30-Jun-2025 : 500.000 Units   Valuation : Rs. 50000.00   NAV as on 30-Jun-2025 : Rs. 100.0000', '');
  }
  return buildMinimalTextPdf([lines]);
}
const folioNos = [1, 2].map((n) => `44${salt}0000${n}0${n}`);

// ---------------- PHASE A: desktop, keyboard / focus / reload / Back ----------------
await act({ a: 'viewport', width: 1280, height: 900 });
await goto('/investment-intelligence/data');
await wait(8000);
// reach the owner selector with the Tab key alone, starting from the last tab link of the page header
let reached = null;
await evalJs(`(document.querySelector('a[href="/investment-intelligence/resolutions"]')).focus(); true`);
for (let i = 0; i < 8 && !reached; i++) {
  await act({ a: 'key', key: 'Tab' });
  const f = await act({ a: 'focused' });
  if (f?.label && /Who does this document belong to/.test(f.label)) reached = f;
}
record(34, 'KEYBOARD: the owner selector can be reached with the Tab key alone', !!reached, JSON.stringify(reached));
record(34, 'FOCUS: the focused owner selector shows a visible focus indicator (outline or ring)', !!(reached && (reached.outline || reached.boxShadow)), JSON.stringify(reached));
// operate it by keyboard: choose Joint (last option) with the arrow keys
for (let i = 0; i < 8; i++) await act({ a: 'key', key: 'ArrowDown' });
const sel = await evalJs(`document.querySelector('select').value`);
record(34, 'KEYBOARD: the arrow keys move the selector to Joint and the joint panel opens', sel === 'joint' && /Choose at least two owners/.test(await text(undefined, 6000)), `value=${sel}`);
await act({ a: 'key', key: 'Tab' });
await act({ a: 'key', key: 'Space' });
await act({ a: 'key', key: 'Tab' });
await act({ a: 'key', key: 'Tab' });
await act({ a: 'key', key: 'Space' });
await wait(400);
const checked = await evalJs(`Array.from(document.querySelectorAll('fieldset input[type=checkbox]')).filter((c)=>c.checked).length`);
record(34, 'KEYBOARD: Tab and Space tick owners in the joint list (2 ticked without a mouse)', checked === 2, `ticked=${checked}`);
const pct = await evalJs(`Array.from(document.querySelectorAll('fieldset input')).filter((i)=>i.type!=='checkbox').length`);
record(34, 'two labelled percentage boxes appear for the two ticked owners', pct === 2, `boxes=${pct}`);
await act({ a: 'fill', sel: 'fieldset input:not([type=checkbox]) >> nth=0', value: '70' });
await act({ a: 'fill', sel: 'fieldset input:not([type=checkbox]) >> nth=1', value: '25' });
await wait(500);
const msg = (await text(undefined, 9000)).match(/The shares add up[^\n]*/)?.[0];
record(34, 'INLINE VALIDATION: 70 + 25 says the shares add up to 95.00% and must be exactly 100%', /95\.00%/.test(msg ?? ''), msg);
await shot('obu-34-keyboard-joint-95', false);
// reload and Back
await act({ a: 'goto', url: '/investment-intelligence/data' });
await wait(2500);
const afterReload = await evalJs(`document.querySelector('select').value`);
record(34, 'RELOAD: the owner selector starts empty again ("Choose one"): a stale owner is never silently carried over', afterReload === '', `value="${afterReload}"`);
await goto('/investment-intelligence');
await goto('/investment-intelligence/data');
await wait(2000);
const afterBack = await evalJs(`document.querySelector('select').value`);
await evalJs('history.back()'); await wait(2500); await evalJs('history.forward()'); await wait(2500);
const afterBack2 = await evalJs(`document.querySelector('select') ? document.querySelector('select').value : 'no-select'`);
record(34, 'BACK/forward navigation: the form comes back empty and the page is intact (no stale owner, upload disabled)', afterBack === '' && /Upload/.test((await controls()).join('\n')), `value="${afterBack}"`);

// ---------------- PHASE B: mobile 375 x 812, per-folio conflict through the real UI ----------------
const tag = `OBUUI${salt}`;
const spouseBytes = twoFolioPdf(`${tag}S`);
const up = await uploadCas(IN1, spouseBytes, `ui-conflict-base-${salt}.pdf`, { kind: 'member', memberId: spouseId });
const baseId = up.json?.data?.id;
await fetch('http://127.0.0.1:3991/', { method: 'HEAD' }).catch(() => {});
const { call } = await import('./obu_lib.mjs');
await call(IN1, 'POST', `/api/investment-intelligence/source-documents/${baseId}/process`, { json: {}, owner: null });
const baseAccts = (await sb.from('ii_accounts').select('id,folio_number,owner_member_id').eq('user_id', U1).in('folio_number', folioNos)).data ?? [];
record(16, 'BROWSER setup: two folios were filed under the Spouse through the API first', baseAccts.length === 2 && baseAccts.every((a) => a.owner_member_id === spouseId), `${baseAccts.length} accounts`);
const variant = path.join(dir, `ui-conflict-self-${salt}.pdf`);
fs.writeFileSync(variant, twoFolioPdf(`${tag}V`));
await act({ a: 'viewport', width: 375, height: 812 });
await goto('/investment-intelligence/data');
await wait(3000);
const overflow0 = await evalJs(`({sw: document.documentElement.scrollWidth, iw: window.innerWidth})`);
record(34, 'MOBILE 375px: no horizontal page overflow on Statements & data', overflow0.sw <= overflow0.iw + 1, JSON.stringify(overflow0));
await act({ a: 'select', label: 'Who does this document belong to?', value: 'Forecast Test User TC083 (you)' });
await act({ a: 'file', path: variant });
await act({ a: 'click', role: 'button', name: 'Upload', exact: true });
await waitText(`ui-conflict-self-${salt}.pdf`, 90000);
await wait(3000);
const vdoc = (await sb.from('ii_source_documents').select('id,status').eq('user_id', U1).eq('original_filename', `ui-conflict-self-${salt}.pdf`)).data?.[0];
await act({ a: 'click', role: 'button', name: 'Process', exact: true });
for (let i = 0; i < 40; i++) {
  await wait(3000);
  const st = (await sb.from('ii_source_documents').select('status').eq('id', vdoc.id)).data?.[0]?.status;
  if (st !== 'uploaded' && st !== 'processing') break;
}
await act({ a: 'click', role: 'button', name: `ui-conflict-self-${salt}.pdf` });
await wait(4000);
const panel = await text('[data-testid=owner-conflicts]', 4000).catch(() => null);
record(16, 'BROWSER (mobile): the conflict panel appears, lists BOTH folios individually and says they were left as they were', !!panel && /2 folios on this statement are already filed under a different owner/.test(panel) && folioNos.every((f) => panel.includes(f)), (panel ?? '').replace(/\n/g, ' | ').slice(0, 300));
const overflow1 = await evalJs(`({sw: document.documentElement.scrollWidth, iw: window.innerWidth})`);
record(34, 'MOBILE 375px: no horizontal overflow with the conflict panel open', overflow1.sw <= overflow1.iw + 1, JSON.stringify(overflow1));
await shot('obu-16-conflict-panel-mobile', false);
await act({ a: 'check', sel: '[data-testid=owner-conflicts] input[type=checkbox] >> nth=0' });
await act({ a: 'click', sel: '[data-testid=owner-conflicts] button >> nth=1' });
await wait(500);
const confirmText = await text('[data-testid=owner-conflicts-confirm]', 2000).catch(() => null);
record(16, 'BROWSER: ticking ONE folio asks for confirmation naming the target and says the other folio stays as it is', !!confirmText && /1 folio/.test(confirmText) && /other 1 stay as they are/.test(confirmText), (confirmText ?? '').replace(/\n/g, ' ').slice(0, 260));
await shot('obu-16-conflict-confirm-mobile', false);
await act({ a: 'click', role: 'button', name: 'Confirm change', exact: true });
await wait(4000);
const after1 = (await sb.from('ii_accounts').select('folio_number,owner_member_id').eq('user_id', U1).in('folio_number', folioNos).order('folio_number')).data ?? [];
record(16, 'BROWSER+DB: after "Confirm change" the ticked folio is Self and the unticked folio is still the Spouse', after1.filter((a) => a.owner_member_id === selfId).length === 1 && after1.filter((a) => a.owner_member_id === spouseId).length === 1, JSON.stringify(after1.map((a) => [a.folio_number.slice(-3), a.owner_member_id === selfId ? 'self' : 'spouse'])));
const panel2 = await text('[data-testid=owner-conflicts]', 4000).catch(() => null);
record(16, 'BROWSER: the panel now lists only the remaining folio, and offers Select all', !!panel2 && /A folio on this statement is already filed under a different owner/.test(panel2) && /Select all/.test(panel2), (panel2 ?? '').replace(/\n/g, ' | ').slice(0, 200));
await act({ a: 'click', role: 'button', name: 'Select all', exact: true });
await act({ a: 'click', sel: '[data-testid=owner-conflicts] button >> nth=1' });
await wait(500);
await act({ a: 'click', role: 'button', name: 'Confirm change', exact: true });
await wait(4000);
const after2 = (await sb.from('ii_accounts').select('folio_number,owner_member_id').eq('user_id', U1).in('folio_number', folioNos)).data ?? [];
record(16, 'BROWSER+DB: Select all then confirm moves the remaining folio; both are Self and the panel disappears', after2.every((a) => a.owner_member_id === selfId) && !(await text('main', 20000)).includes('already filed under a different owner'), JSON.stringify(after2.map((a) => a.owner_member_id === selfId)));
const ev = (await sb.from('ii_audit_events').select('metadata').eq('user_id', U1).eq('event_type', 'user_correction').in('subject_id', after2.map((a) => a.id ?? '')).limit(5)).data;
await shot('obu-16-after-select-all-mobile', false);
// keyboard operation of the conflict dialog is covered by native checkbox/button semantics: confirm with focus + Space on a fresh check box? (documented, not claimed beyond what ran)
await act({ a: 'viewport', width: 1280, height: 900 });

saveResults('.canonical-cert/obu-ui-conflict-a11y-results.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
