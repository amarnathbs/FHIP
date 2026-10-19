// Probe: the Fund analytics document rendered on the SERVER (renderToStaticMarkup, as the route does) and printed by Chromium with the page's own
// @page rules; the running header text of page 1 can then be read from the PDF. Proves the margin-box version line survives server rendering
// (a quote escaped to &quot; inside a <style> child would be invalid CSS and the header would be empty).
//   npx tsx scripts/print/faSsrHeaderProbe.ts <outDir>      (needs <outDir>/out.css: the compiled app stylesheet)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import FundAnalyticsPrintDocument from '../../components/reports/FundAnalyticsPrintDocument';
import { buildPrintFixture } from '../nav2_print_fixtures';

async function main() {
  const out = process.argv[2];
  mkdirSync(out, { recursive: true });
  const { report } = buildPrintFixture({ funds: 1 });
  const body = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report, version: { versionNumber: 2, createdAt: '2026-10-19T11:08:00.000Z' }, timeZone: 'Australia/Sydney' }));
  writeFileSync(path.join(out, 'ssr.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FHIP | Financial Health</title><link rel="stylesheet" href="out.css"></head><body>${body}</body></html>`);
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto(pathToFileURL(path.join(out, 'ssr.html')).href);
  await p.emulateMedia({ media: 'print' });
  writeFileSync(path.join(out, 'ssr.pdf'), await p.pdf({ preferCSSPageSize: true, format: 'A4' }));
  await b.close();
}
void main();
