/**
 * PO decision 18-10-2026 ("yes, use the print flow"): the Monthly Report and the Consolidated Forecasting Report no longer offer a
 * server "Export PDF (premium)" button (Amplify has no Chromium at runtime). They offer ONE button, "Print / Save as PDF", that opens
 * the print view in its own tab from the click handler (lib/reports/printTab.ts), free on every plan. The server export routes and
 * their typed errors stay in place, unused by these buttons, for a hosted renderer later.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReportActions } from '@/components/reports/ReportActions';
import { ForecastReportActions } from '@/components/forecast/ForecastReportActions';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** What a button regression looks like: a call to a server export route, or a label that promises a premium server PDF. */
export function serverExportButtonViolations(src: string): string[] {
  const code = strip(src);
  const out: string[] = [];
  if (/\/exports['"`?\s]|api\/forecast\/report\/export|api\/report-exports/.test(code)) out.push('calls a server export route');
  if (/Export PDF/i.test(code)) out.push('has an "Export PDF" label');
  if (/\(premium\)/i.test(code)) out.push('says "(premium)"');
  if (/\bfetch\(/.test(code)) out.push('fetches');
  return out;
}

describe('Monthly Report actions', () => {
  const markup = renderToStaticMarkup(createElement(ReportActions, { reportId: 'rep-1' }));

  it('has exactly ONE action, "Print / Save as PDF", which opens the print route with print=1 (no second button doing the same thing)', () => {
    expect((markup.match(/<a /g) ?? []).length).toBe(1);
    expect(markup).not.toContain('<button');
    expect(markup).toContain('Print / Save as PDF');
    expect(markup).toContain('href="/reports/rep-1/print?print=1"');
    expect(markup).toContain('target="_blank"'); // the no-JavaScript fallback; with JavaScript the click opens the named window from the handler
    expect(markup).toContain('no-print');
  });

  it('no longer says premium and no longer promises a server PDF', () => {
    expect(markup).not.toMatch(/premium|Export PDF|Generating PDF|Download PDF/i);
    expect(markup).toContain('Free on every plan');
  });

  it('uses the print-tab opener (window.open from the click handler), not the server export', () => {
    const src = read('components/reports/ReportActions.tsx');
    expect(src).toContain("from '@/components/reports/OpenPrintTabLink'");
    expect(serverExportButtonViolations(src)).toEqual([]);
    const opener = read('components/reports/OpenPrintTabLink.tsx');
    expect(opener).toContain('openPrintTab(window, href, windowName)');
  });
});

describe('Consolidated Forecasting Report actions', () => {
  it('one "Print / Save as PDF" link to the forecast print route (scenario carried, encoded); no Export PDF button', () => {
    const m = renderToStaticMarkup(createElement(ForecastReportActions, { scenario: 'down turn/1' }));
    expect(m).toContain('href="/forecast/report/print?print=1&amp;scenario=down%20turn%2F1"');
    expect(m).not.toMatch(/Export PDF|premium|<button/i);
    expect(renderToStaticMarkup(createElement(ForecastReportActions, {}))).toContain('href="/forecast/report/print?print=1"');
    expect(serverExportButtonViolations(read('components/forecast/ForecastReportActions.tsx'))).toEqual([]);
  });
});

describe('NEGATIVE CONTROL: the scanner really fails on the old buttons', () => {
  it('flags a server export call, an "Export PDF (premium)" label and a fetch', () => {
    const old = "const res = await fetch(`/api/reports/${id}/exports`, { method: 'POST' }); return <button>Export PDF (premium)</button>;";
    expect(serverExportButtonViolations(old).sort()).toEqual(['calls a server export route', 'fetches', 'has an "Export PDF" label', 'says "(premium)"'].sort());
    const oldForecast = "fetch('/api/forecast/report/export'); <button>Export PDF</button>";
    expect(serverExportButtonViolations(oldForecast).length).toBeGreaterThan(1);
  });
});

describe('copy on the Reports page', () => {
  const page = read('app/(app)/reports/page.tsx');
  it('no longer promises a premium server PDF: browser printing and saving as PDF are free on every plan', () => {
    expect(page).not.toMatch(/require a premium plan|request an export/);
    expect(page).toContain('Save as PDF');
    expect(page).toMatch(/free on every plan/);
    expect(page).toContain('Server-generated PDF and CSV downloads are not available yet');
  });
});

describe('the server export routes and their typed errors stay in place (documented: hosted renderer later)', () => {
  it('both routes still exist and still return typed errors', () => {
    for (const f of ['app/api/reports/[id]/exports/route.ts', 'app/api/forecast/report/export/route.ts', 'lib/services/reportExportFailure.ts']) expect(existsSync(path.join(ROOT, f)), f).toBe(true);
    expect(read('lib/services/reportExportFailure.ts')).toMatch(/code/);
  });
  it('the print routes the buttons open accept the print=1 marker', () => {
    expect(read('app/(print)/reports/[id]/print/page.tsx')).toContain("print === '1'");
    expect(read('app/(print)/forecast/report/print/page.tsx')).toContain("print === '1'");
  });
});
