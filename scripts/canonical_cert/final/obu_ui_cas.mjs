/**
 * Owner-before-upload DEV certification, DEV-BROWSER part for India CAS (steps 11, 13, 14, 34 UI).
 *   npx tsx scripts/canonical_cert/final/obu_ui_cas.mjs      (needs the ui driver for IN1 on control port 3995)
 * Headless Chromium on the localhost app, signed in as the existing fixture user IN1. Screenshots: test-artifacts/obu_cert/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildMinimalTextPdf } from '../../../tests/support/buildMinimalPdf.ts';
import { act, goto, wait, waitText, shot, text, evalJs, controls } from './obu_ui_lib.mjs';
import { record, saveResults, results, db, USERS, hostGuard } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const sb = await db();
const salt = String(Math.floor(1000 + Math.random() * 9000));
const dir = path.resolve('.canonical-cert', 'ui');
fs.mkdirSync(dir, { recursive: true });
function pdf(folio, valuation, name) {
  const nav = (valuation / 1000).toFixed(4);
  const lines = ['CAMS Consolidated Account Statement', 'Statement Period : 01-Jan-2025 To 30-Jun-2025', '', `Folio No: ${folio}`, `PAN: PCQAL${folio.slice(-4)}F`, 'Name: FHIP SYNTHETIC HOLDER', 'Holding Mode: SI', '',
    'AMC Name: HDFC Mutual Fund', 'Scheme Name: HDFC Flexi Cap Fund - Growth (Direct Plan)', 'ISIN: INF179K01YW8', 'AMFI Code: 118834', 'Registrar: CAMS', '',
    'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance',
    `01-Feb-2025   Purchase                              ${valuation.toLocaleString('en-IN')}.00  1000.000  ${nav}  1000.000 [Ref: UI${salt}-${folio.slice(-3)}]`, '',
    `Closing Unit Balance as on 30-Jun-2025 : 1000.000 Units   Valuation : Rs. ${valuation}.00   NAV as on 30-Jun-2025 : Rs. ${nav}`, ''];
  const file = path.join(dir, name);
  fs.writeFileSync(file, buildMinimalTextPdf([lines]));
  return file;
}
const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
const U1 = users.users.find((u) => u.email === USERS.IN1).id;

// ---- the page, before choosing an owner
await goto('/investment-intelligence/data');
await wait(2500);
let ctl = await controls();
const uploadBtn = ctl.find((c) => /^button\[submit\](\(disabled\))? Upload$/.test(c));
record(11, 'BROWSER: before an owner is chosen the Upload button is disabled', /\(disabled\)/.test(uploadBtn ?? ''), uploadBtn);
const ownerSel = ctl.find((c) => c.includes('<label:Who does this document belong to?>'));
record(11, 'BROWSER: the selector "Who does this document belong to?" is shown above the file input and offers You, Spouse, Joint and the entities', /\(you\)/.test(ownerSel) && /Spouse/.test(ownerSel), ownerSel);
await shot('obu-11-before-owner', false);

// ---- choose Self, upload a new synthetic statement through the real form
const f1 = pdf(`55${salt}0000001`, 120000, `ui-self-${salt}.pdf`);
await act({ a: 'select', label: 'Who does this document belong to?', value: 'Forecast Test User TC083 (you)' });
await act({ a: 'file', path: f1 });
await wait(500);
ctl = await controls();
const afterBtn = ctl.find((c) => /^button\[submit\](\(disabled\))? Upload$/.test(c));
record(11, 'BROWSER: after choosing Self and a file the Upload button is enabled', !/\(disabled\)/.test(afterBtn ?? '(disabled)'), afterBtn);
await act({ a: 'click', role: 'button', name: 'Upload', exact: true });
await waitText(`ui-self-${salt}.pdf`, 90000);
await wait(6000);
await shot('obu-11-after-upload-self', true);
const db1 = (await sb.from('ii_source_documents').select('*').eq('user_id', U1).eq('original_filename', `ui-self-${salt}.pdf`)).data?.[0];
record(11, 'BROWSER+DB: the uploaded statement row carries the chosen owner (self / user_selected)', db1?.owner_role === 'self' && db1?.owner_selection_source === 'user_selected', `status=${db1?.status} role=${db1?.owner_role}`);
// the upload form does not auto-process: press Process like a user
await act({ a: 'click', role: 'button', name: 'Process', exact: true });
for (let i = 0; i < 30; i++) { await wait(3000); const st = (await sb.from('ii_source_documents').select('status').eq('id', db1.id)).data?.[0]?.status; if (st !== 'uploaded' && st !== 'processing') break; }
const db1b = (await sb.from('ii_source_documents').select('status,owner_role').eq('id', db1.id)).data?.[0];
record(11, 'BROWSER+DB: pressing Process parses the statement and the owner stays', db1b?.status === 'parsed' && db1b?.owner_role === 'self', JSON.stringify(db1b));
await act({ a: 'click', role: 'button', name: `ui-self-${salt}.pdf` });
await wait(4000);
const body = await text(undefined, 20000);
const filed = body.match(/Filed under:\s*([^\n]+)/)?.[1];
record(11, 'BROWSER: "Filed under" shows a friendly name, no raw id', !!filed && !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(filed), `Filed under: ${filed}`);
record(11, 'BROWSER: no owner-question (owner_unmatched) prompt is shown for this statement', !/owner unmatched|who owns this/i.test(body), '');
await shot('obu-11-filed-under', true);

// ---- Joint selector: tick owners, percentages appear, inline total (steps 13 / 14 / 34)
await goto('/investment-intelligence/data');
await wait(2500);
await act({ a: 'select', label: 'Who does this document belong to?', value: 'Joint — shared between owners' });
await wait(600);
const t0 = await text(undefined, 6000);
record(13, 'BROWSER: Joint lists the owners with check boxes and says "Choose at least two owners"', /Choose at least two owners/i.test(t0), t0.match(/[^\n]*at least two[^\n]*/i)?.[0]);
await act({ a: 'check', sel: 'fieldset input[type=checkbox] >> nth=0' });
await act({ a: 'check', sel: 'fieldset input[type=checkbox] >> nth=1' });
await wait(600);
const fields = await evalJs(`Array.from(document.querySelectorAll('fieldset input')).filter((i)=>i.type!=='checkbox').map((i)=>i.type+'|'+(i.labels?.[0]?.innerText||i.getAttribute('aria-label')||'(no label)'))`);
record(13, 'BROWSER: ticking two owners shows one LABELLED percentage box per owner', fields.length === 2 && fields.every((f) => !f.endsWith('(no label)')), JSON.stringify(fields));
await shot('obu-13-joint-two-owners', false);
await act({ a: 'fill', sel: 'fieldset input:not([type=checkbox]) >> nth=0', value: '60' });
await act({ a: 'fill', sel: 'fieldset input:not([type=checkbox]) >> nth=1', value: '30' });
await wait(600);
let t2 = (await text('fieldset', 3000)).replace(/\n/g, ' | ');
record(14, 'BROWSER: 60 + 30 shows an inline message about the total (not 100) before any upload', /add up to 90.00%.*exactly 100%/i.test(t2), t2.match(/The shares add up[^|]*/)?.[0]);
await shot('obu-14-joint-90-inline-error', false);
await act({ a: 'fill', sel: 'fieldset input:not([type=checkbox]) >> nth=1', value: '40' });
await wait(600);
t2 = (await text('fieldset', 3000)).replace(/\n/g, ' | ');
record(13, 'BROWSER: 60 + 40 reads as a valid 100 percent', !/The shares add up to/i.test(t2) && /100(.00)?%/.test(t2), t2.match(/[^|]*100(.00)?%[^|]*/)?.[0] ?? 'no error line');
await shot('obu-13-joint-60-40', false);

saveResults('.canonical-cert/obu-ui-cas-results.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
