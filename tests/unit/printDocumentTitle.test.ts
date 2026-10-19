import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  GENERIC_APP_TITLE,
  applyPrintDocumentTitle,
  dayMonthYearInWords,
  fileNameSafe,
  forecastReportPrintTitle,
  isPrintTitleFileNameSafe,
  monthYearInWords,
  netWorthStatementPrintTitle,
  netWorthStatementViewLabel,
  reportPrintTitle,
} from '@/lib/reports/printDocumentTitle';
import { createPrintTabController, type PrintWindowLike } from '@/lib/reports/printTab';

// PO observation 20-10-2026: every "Save as PDF" proposed "FHIP _ Financial Health.pdf" (the page <title>). Each print page now sets a
// per report and per period title, month in words, safe as a Windows file name.

const WINDOWS_REJECTED = /[\\/:*?"<>|]/;

describe('print document titles: the format per page', () => {
  it('Monthly Report', () => {
    expect(reportPrintTitle({ reportTypeCode: 'monthly_financial_health', reportMonth: '2026-10-01', versionNumber: 1 })).toBe('FHIP Monthly Report - October 2026');
  });
  it('other report types the report print route shows', () => {
    expect(reportPrintTitle({ reportTypeCode: 'goal_progress', reportMonth: '2026-03-01' })).toBe('FHIP Goal Progress Report - March 2026');
    expect(reportPrintTitle({ reportTypeCode: 'financial_health_score', reportMonth: '2026-12-01' })).toBe('FHIP Financial Health Score Report - December 2026');
    expect(reportPrintTitle({ reportTypeCode: 'net_worth', reportMonth: '2027-01-01' })).toBe('FHIP Net Worth Report - January 2027');
  });
  it('a revision is named so it does not share the first version file name', () => {
    expect(reportPrintTitle({ reportTypeCode: 'monthly_financial_health', reportMonth: '2026-10-01', versionNumber: 2 })).toBe('FHIP Monthly Report - October 2026 (version 2)');
  });
  it('falls back to the as-at date, then to the report name alone, never to an invented month', () => {
    expect(reportPrintTitle({ reportTypeCode: 'monthly_financial_health', reportMonth: null, asOfDate: '2026-10-20' })).toBe('FHIP Monthly Report - 20 October 2026');
    expect(reportPrintTitle({ reportTypeCode: 'monthly_financial_health', reportMonth: 'garbage', asOfDate: undefined })).toBe('FHIP Monthly Report');
    expect(reportPrintTitle({ reportTypeCode: 'something_new', reportMonth: '2026-10-01' })).toBe('FHIP Report - October 2026');
  });
  it('Net Worth Statement: as-at date day first, month in words', () => {
    expect(netWorthStatementPrintTitle({ asAt: '2026-10-20' })).toBe('FHIP Net Worth Statement - 20 October 2026');
    expect(netWorthStatementPrintTitle({ asAt: '2026-01-05', viewLabel: null })).toBe('FHIP Net Worth Statement - 5 January 2026');
  });
  it('Net Worth Statement: family, all and entity views are told apart', () => {
    const entities = [{ entityId: 'e1', name: 'Smith Family Trust' }];
    expect(netWorthStatementPrintTitle({ asAt: '2026-10-20', viewLabel: netWorthStatementViewLabel('family', entities) })).toBe('FHIP Net Worth Statement - Family - 20 October 2026');
    expect(netWorthStatementPrintTitle({ asAt: '2026-10-20', viewLabel: netWorthStatementViewLabel('all', entities) })).toBe('FHIP Net Worth Statement - All statements - 20 October 2026');
    expect(netWorthStatementPrintTitle({ asAt: '2026-10-20', viewLabel: netWorthStatementViewLabel({ entity: 'e1' }, entities) })).toBe('FHIP Net Worth Statement - Smith Family Trust - 20 October 2026');
    expect(netWorthStatementViewLabel('personal', entities)).toBeNull();
  });
  it('Net Worth Statement without a usable date keeps the name only', () => {
    expect(netWorthStatementPrintTitle({ asAt: undefined })).toBe('FHIP Net Worth Statement');
  });
  it('Consolidated Forecast Report: month of the build date, in the reporting currency home timezone', () => {
    expect(forecastReportPrintTitle({ generatedAt: '2026-10-20T03:00:00.000Z', currency: 'AUD' })).toBe('FHIP Consolidated Forecast Report - October 2026');
    // 20:30 UTC on 31 October is already 1 November in Kolkata and in Sydney.
    expect(forecastReportPrintTitle({ generatedAt: '2026-10-31T20:30:00.000Z', currency: 'INR' })).toBe('FHIP Consolidated Forecast Report - November 2026');
    expect(forecastReportPrintTitle({ generatedAt: '2026-10-31T10:30:00.000Z', currency: 'INR' })).toBe('FHIP Consolidated Forecast Report - October 2026');
    expect(forecastReportPrintTitle({ generatedAt: null })).toBe('FHIP Consolidated Forecast Report');
  });
  it('date-only values are read without a timezone shift', () => {
    expect(monthYearInWords('2026-10-01', 'INR')).toBe('October 2026');
    expect(dayMonthYearInWords('2026-12-31', 'AUD')).toBe('31 December 2026');
    expect(dayMonthYearInWords('2026-13-01')).toBeNull();
  });
});

describe('print document titles: file-name safety', () => {
  const samples = [
    reportPrintTitle({ reportTypeCode: 'monthly_financial_health', reportMonth: '2026-10-01', versionNumber: 3 }),
    reportPrintTitle({ reportTypeCode: 'goal_progress', reportMonth: null, asOfDate: '2026-02-28' }),
    netWorthStatementPrintTitle({ asAt: '2026-10-20' }),
    netWorthStatementPrintTitle({ asAt: '2026-10-20', viewLabel: 'Smith / Jones: Trust* "Pty"? <Ltd> | A\\B.' }),
    forecastReportPrintTitle({ generatedAt: '2026-10-20T03:00:00.000Z' }),
  ];
  it.each(samples)('%s has no character Windows rejects and no trailing dot or space', (t) => {
    expect(t).not.toMatch(WINDOWS_REJECTED);
    expect(t).not.toMatch(/[. ]$/);
    expect(isPrintTitleFileNameSafe(t)).toBe(true);
  });
  it('an entity name with unsafe characters is cleaned, not dropped', () => {
    expect(netWorthStatementPrintTitle({ asAt: '2026-10-20', viewLabel: 'Smith/Jones: Trust' })).toBe('FHIP Net Worth Statement - Smith Jones Trust - 20 October 2026');
  });
  it('NEGATIVE CONTROL: the old generic title, and unsafe names, are rejected by the same check', () => {
    expect(isPrintTitleFileNameSafe(GENERIC_APP_TITLE)).toBe(false);
    expect(isPrintTitleFileNameSafe('FHIP Monthly Report: October 2026')).toBe(false);
    expect(isPrintTitleFileNameSafe('FHIP Monthly Report - 20/10/2026')).toBe(false);
    expect(isPrintTitleFileNameSafe('Monthly Report - October 2026')).toBe(false);
    expect(fileNameSafe('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });
});

describe('the title is in place before the print dialog opens', () => {
  function fakeWindow() {
    const calls: string[] = [];
    const doc = { title: GENERIC_APP_TITLE };
    const w: PrintWindowLike = {
      name: '',
      opener: null,
      print: () => calls.push(`print:${doc.title}`),
      close: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return { w, doc, calls };
  }
  it('beforePrint sets the title for the button and for the automatic print', () => {
    const { w, doc, calls } = fakeWindow();
    const title = 'FHIP Monthly Report - October 2026';
    const timers: Array<() => void> = [];
    const c = createPrintTabController(w, { autoPrint: true, schedule: (fn) => { timers.push(fn); return () => undefined; }, beforePrint: () => applyPrintDocumentTitle(doc, title) });
    c.start();
    timers[0]();
    c.print();
    expect(calls).toEqual([`print:${title}`, `print:${title}`]);
  });
  it('NEGATIVE CONTROL: without beforePrint the dialog would see the generic title', () => {
    const { w, calls } = fakeWindow();
    createPrintTabController(w, { autoPrint: false }).print();
    expect(calls).toEqual([`print:${GENERIC_APP_TITLE}`]);
  });
  it('a failing title setter never stops the print dialog', () => {
    const { w, calls } = fakeWindow();
    createPrintTabController(w, { autoPrint: false, beforePrint: () => { throw new Error('x'); } }).print();
    expect(calls).toHaveLength(1);
  });
  it('applyPrintDocumentTitle only changes a different title', () => {
    const doc = { title: 'x' };
    expect(applyPrintDocumentTitle(doc, 'FHIP Net Worth Statement - 20 October 2026')).toBe(true);
    expect(applyPrintDocumentTitle(doc, 'FHIP Net Worth Statement - 20 October 2026')).toBe(false);
    expect(applyPrintDocumentTitle(doc, '')).toBe(false);
  });
});

// ---- Every print page (other than Fund analytics, whose page another branch owns) carries a descriptive title ---------------------------

const ROOT = path.resolve(__dirname, '..', '..');
const PRINT_PAGES: Record<string, { builder: string; fallback: RegExp }> = {
  'app/(print)/reports/[id]/print/page.tsx': { builder: 'reportPrintTitle(', fallback: /title: 'FHIP Report'/ },
  'app/(print)/reports/net-worth-statement/print/page.tsx': { builder: 'netWorthStatementPrintTitle(', fallback: /title: 'FHIP Net Worth Statement'/ },
  'app/(print)/forecast/report/print/page.tsx': { builder: 'forecastReportPrintTitle(', fallback: /title: 'FHIP Consolidated Forecast Report'/ },
};

/** What a print page must contain to get a per-report file name; returns the list of problems. */
function titleProblems(source: string, spec: { builder: string; fallback: RegExp }): string[] {
  const problems: string[] = [];
  if (!source.includes(spec.builder)) problems.push('does not build the print title');
  if (!source.includes('<PrintDocumentTitle')) problems.push('does not render <PrintDocumentTitle>');
  if (source.includes('<PrintTabToolbar') && !/documentTitle=\{/.test(source)) problems.push('PrintTabToolbar has no documentTitle');
  if (!spec.fallback.test(source)) problems.push('has no static fallback title');
  if (source.includes(GENERIC_APP_TITLE)) problems.push('uses the generic title');
  return problems;
}

describe('every print page sets a descriptive title', () => {
  for (const [file, spec] of Object.entries(PRINT_PAGES)) {
    it(file, () => {
      expect(titleProblems(fs.readFileSync(path.join(ROOT, file), 'utf8'), spec)).toEqual([]);
    });
  }
  it('the list covers every print page under app/(print) except Fund analytics', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'page.tsx') found.push(path.relative(ROOT, p).split(path.sep).join('/'));
      }
    };
    walk(path.join(ROOT, 'app', '(print)'));
    const others = found.filter((f) => !f.includes('/fund-analytics/')).sort();
    expect(others).toEqual(Object.keys(PRINT_PAGES).sort());
  });
  it('NEGATIVE CONTROL: a print page that still has the generic title and no setter is flagged', () => {
    const oldPage = "export const metadata = { title: 'FHIP | Financial Health' };\nexport default function P(){ return <PrintTabToolbar autoPrint={false} parentHref='/' parentLabel='x' />; }";
    expect(titleProblems(oldPage, PRINT_PAGES['app/(print)/reports/[id]/print/page.tsx']).length).toBeGreaterThanOrEqual(4);
  });
});
