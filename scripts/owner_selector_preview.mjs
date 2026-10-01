// Owner-before-upload (Phase 1) -- renders the REAL OwnerSelector component to
// static HTML for each state worth reviewing, so the PO can look at the UX
// without running the app. It bundles components/ownership/OwnerSelector.tsx
// with esbuild (automatic JSX, '@' alias) and renders it with
// react-dom/server's renderToStaticMarkup, using the component's `preview` prop
// (which skips the network fetch and seeds the options).
//
// This is a server render: it shows the markup and initial state, not the
// interaction. Interaction is covered by the unit tests for the joint-entry
// logic (tests/unit/ownerBeforeUploadSelection.test.ts) and was NOT exercised in
// a live browser (no authenticated session was available).
//
// Run: node scripts/owner_selector_preview.mjs
// Writes: docs/ownership/owner_selector_preview.html

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(path.join(ROOT, 'package.json'));

// Inside the repo tree (not os.tmpdir) so the bundle's `react` import resolves from the same node_modules.
const outDir = fs.mkdtempSync(path.join(ROOT, '.tmp-owner-selector-'));
const outFile = path.join(outDir, 'bundle.mjs');
await build({
  entryPoints: [path.join(ROOT, 'components/ownership/OwnerSelector.tsx')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  alias: { '@': ROOT },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'error',
});

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { OwnerSelector } = await import(pathToFileURL(outFile).href);

const M = { self: 'a1111111-1111-4111-8111-111111111111', spouse: 'a2222222-2222-4222-8222-222222222222' };
const E = { trust: 'e1111111-1111-4111-8111-111111111111', huf: 'e2222222-2222-4222-8222-222222222222' };

const casIndia = {
  flow: 'ii_cas',
  members: [
    { id: M.self, label: 'Anil Sharma', detail: 'You', ownerRole: 'self' },
    { id: M.spouse, label: 'Priya Sharma', detail: 'Spouse', ownerRole: 'spouse' },
  ],
  entities: [
    { id: E.trust, label: 'Sharma Family Trust', detail: 'Family trust', entityType: 'family_trust' },
    { id: E.huf, label: 'Sharma HUF', detail: 'HUF', entityType: 'huf' },
  ],
  joint: { available: true, requiresPercentages: true, candidateCount: 4 },
  smsf: { available: false },
  entityNotice: null,
};
const bankAu = {
  flow: 'bank',
  members: casIndia.members,
  entities: [],
  joint: { available: true, requiresPercentages: false, candidateCount: 2 },
  smsf: { available: true },
  entityNotice: 'Trust, HUF and company statements cannot be imported here yet: bank transactions are counted in your household spending and income, and entity money must stay separate from your personal totals.',
};

const rowsFor = (checked) => [
  { key: `member:${M.self}`, checked: checked.self !== undefined, percentText: checked.self ?? '' },
  { key: `member:${M.spouse}`, checked: checked.spouse !== undefined, percentText: checked.spouse ?? '' },
  { key: `entity:${E.trust}`, checked: checked.trust !== undefined, percentText: checked.trust ?? '' },
  { key: `entity:${E.huf}`, checked: checked.huf !== undefined, percentText: checked.huf ?? '' },
];

const states = [
  { title: 'India CAS upload: nothing chosen yet (Upload stays disabled)', props: { flow: 'ii_cas', value: null, preview: { options: casIndia } } },
  { title: 'India CAS upload: Joint with a valid 60 / 40 split (sent as 6000 + 4000 basis points)', props: { flow: 'ii_cas', value: { kind: 'joint' }, preview: { options: casIndia, jointRows: rowsFor({ self: '60', spouse: '40' }) } } },
  { title: 'India CAS upload: Joint with shares that do not add up (Upload stays disabled)', props: { flow: 'ii_cas', value: { kind: 'joint' }, preview: { options: casIndia, jointRows: rowsFor({ self: '60', spouse: '30' }) } } },
  { title: 'Bank upload (Australia): joint has no percentages; SMSF offered; entities not offered, with the reason', props: { flow: 'bank', value: { kind: 'joint' }, preview: { options: bankAu } } },
];

const cards = states
  .map((s) => {
    const html = renderToStaticMarkup(React.createElement(OwnerSelector, { ...s.props, onChange: () => {}, idPrefix: 'p' + states.indexOf(s) }));
    return `<section><h2>${s.title}</h2><div class="card">${html}</div></section>`;
  })
  .join('\n');

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Owner selector preview</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body{font-family:system-ui,sans-serif;margin:24px;background:#f9fafb;color:#111827}
  h1{font-size:18px} h2{font-size:13px;margin:24px 0 8px;color:#374151}
  .card{max-width:640px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px}
  .text-muted{color:#6b7280} .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
</style></head><body>
<h1>Owner-before-upload, Phase 1 &mdash; the shared owner selector (server-rendered states)</h1>
<p class="text-muted" style="font-size:12px">Rendered from the real component by scripts/owner_selector_preview.mjs. Markup and initial state only; not an interactive or live-browser check.</p>
${cards}
</body></html>`;

const target = path.join(ROOT, 'docs', 'ownership', 'owner_selector_preview.html');
fs.writeFileSync(target, page);
console.log('wrote', target, `(${page.length} bytes, ${states.length} states)`);
fs.rmSync(outDir, { recursive: true, force: true });
