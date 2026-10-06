/**
 * Owner-before-upload DEV certification, DEV-BROWSER: every other import panel asks for the owner first (step 26 in the browser, gate only).
 *   npx tsx scripts/canonical_cert/final/obu_ui_panels.mjs      (ui driver for AU2 on control port 3995; localhost app 3991)
 * For each panel: open it, find the owner selector, check its options for that flow and that the upload button stays disabled with a file
 * chosen but NO owner (the owner is demanded BEFORE the file is sent). No upload is made. DEV only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { act, goto, wait, shot, evalJs, controls, waitFor } from './obu_ui_lib.mjs';
import { record, saveResults, results, hostGuard } from './obu_lib.mjs';

console.log('DEV host verified:', hostGuard());
const dir = path.resolve('.canonical-cert', 'ui');
fs.mkdirSync(dir, { recursive: true });
const csv = path.join(dir, 'panel-gate.csv');
fs.writeFileSync(csv, 'Date,Description,Amount\n01/03/2026,PANEL GATE,1.00\n');
const pdfFile = path.join(dir, 'panel-gate.pdf');
fs.writeFileSync(pdfFile, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const panels = [
  { step: 26, name: 'payslip (Income)', url: '/income', openName: 'Import from Payslip', uploadName: 'Upload payslip', open: /import.*payslip|payslip/i, file: pdfFile, expectOpts: [/you/i], forbid: [/trust|company|huf|joint|smsf/i] },
  { step: 26, name: 'liability (Liabilities)', url: '/liabilities', openName: 'Import Statement', pre: ['Credit Card Statement'], uploadName: null, open: /import/i, file: csv, expectOpts: [/you/i, /joint/i, /smsf/i], forbid: [/trust|company|huf/i] },
  { step: 26, name: 'retirement (Retirement)', url: '/retirement', openName: null, uploadName: 'Upload and read statement', open: /import|statement/i, file: csv, expectOpts: [/you/i], forbid: [/trust|company|huf|joint|smsf/i] },
  { step: 26, name: 'AU investment (Investments)', url: '/investments', openName: 'Import Australian Investment Statement', uploadName: 'Upload statement', open: /import|statement/i, file: csv, expectOpts: [/you/i, /joint/i], forbid: [/trust|company|huf|smsf/i] },
];
for (const p of panels) {
  try {
    await goto(p.url);
    await wait(2500);
    if (p.openName) { await act({ a: 'click', role: 'button', name: p.openName }); await wait(1500); }
    for (const pre of p.pre ?? []) { await act({ a: 'click', role: 'button', name: pre }); await wait(1500); }
    await waitFor(async () => evalJs("Array.from(document.querySelectorAll('select')).some((s) => !s.disabled && s.options.length > 1 && /who does this document/i.test((s.labels && s.labels[0] ? s.labels[0].innerText : '')))"), 40, 1500);
    const sels = await evalJs("Array.from(document.querySelectorAll('select')).map((s)=>({id:s.id,label:(s.labels&&s.labels[0]?s.labels[0].innerText:'').trim().slice(0,60),opts:Array.from(s.options).map((o)=>o.text)}))");
    const ownerSel = sels.find((s) => /who does this document belong to/i.test(s.label));
    record(p.step, 'BROWSER ' + p.name + ': the owner selector "Who does this document belong to?" is on the panel', !!ownerSel, JSON.stringify(ownerSel ?? sels.map((s) => s.label)).slice(0, 220));
    if (ownerSel) {
      const o = ownerSel.opts.join(' | ');
      record(p.step, 'BROWSER ' + p.name + ': the owner options match the flow policy', p.expectOpts.every((r) => r.test(o)) && p.forbid.every((r) => !r.test(o)), o);
      await act({ a: 'file', path: p.file });
      await wait(800);
      const ctl2 = await controls();
      const upload = p.uploadName ? ctl2.find((c) => c.endsWith(p.uploadName)) : ctl2.find((c) => /^button/.test(c) && /\(disabled\)/.test(c) && /upload|read|extract/i.test(c));
      record(p.step, 'BROWSER ' + p.name + ': with a file chosen but NO owner the upload button is disabled', !!upload && /\(disabled\)/.test(upload), upload ?? 'no upload button found');
    }
    await shot(`obu-26-panel-${p.name.split(' ')[0]}`, false);
  } catch (e) {
    record(p.step, `BROWSER ${p.name}: panel check ran`, false, String(e.message).slice(0, 300));
  }
}
saveResults('.canonical-cert/obu-ui-panels-results.json');
const bad = results.filter((r) => r.ok === false);
console.log(`\n${results.length} recorded, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
