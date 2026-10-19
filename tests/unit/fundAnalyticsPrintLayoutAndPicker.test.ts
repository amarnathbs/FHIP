// Fund analytics: the print layout (PO 19-10-2026, "a lot of empty space in the report") and the fund picker ("Clear all" / "Select the 10 largest").
//
// UNIT-TESTED here: the markup contract (one fund collapses the comparison into one compact block; two or more keep the full section), the print stylesheet
// contract (no forced page break before a fund or the comparison, kept-together pieces are small, the named page declares its header and footer boxes), the
// picker rules (exact selections, never above the maximum) and the printed "made" time zone. The REAL page counts and fill of 1, 2, 4 and 10 funds are
// measured in Chromium by scripts/print/faPrintLayoutCheck.ts (see docs/reports/FUND_ANALYTICS_PRINT_LAYOUT_AND_PICKER_REPORT_2026-10-19.md); they are not asserted here.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FundAnalyticsPrintDocument, { comparisonPossible } from '@/components/reports/FundAnalyticsPrintDocument';
import { FundPickPanel } from '@/components/reports/FundPickPanel';
import { formatDateTimeMinutes, isKnownTimeZone } from '@/lib/engines/date';
import { versionMadeLinePrint } from '@/lib/engines/nav2/reportWording';
import { evaluatePrintLayout, type PdfPageMetrics, type PrintLayoutRules } from '@/lib/reports/printLayoutRules';
import { boxDisabled, clearAll, largestIds, selectLargest, toggleFund, type PickState } from '@/lib/reports/fundPicker';
import { FUND_ANALYTICS_TITLE_FALLBACK, fundAnalyticsPrintTitle } from '@/lib/reports/fundAnalyticsPrintTitle';
import { pdfHeaderTemplate } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer';
import { buildPrintFixture } from '../../scripts/nav2_print_fixtures';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const version = { versionNumber: 2, createdAt: '2026-10-19T11:08:00.000Z' };

const one = buildPrintFixture({ funds: 1 }).report;
const two = buildPrintFixture({ funds: 2 }).report;
const four = buildPrintFixture({ funds: 4 }).report;
const html = (report: typeof one, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report, version, ...extra }));

describe('ONE fund: the comparison is one compact block, not a page of its own', () => {
  const h = html(one);
  it('no comparison is possible, and the section is the compact "none" block', () => {
    expect(comparisonPossible(one)).toBe(false);
    expect(h).toContain('data-fa-comparison="none"');
    expect(h).toContain('fa-comparison fa-comparison-none');
    expect(count(h, '<section class="fa-comparison')).toBe(1);
  });
  it('NOTHING is dropped: the three "not applicable" lines, the two-funds sentence and the risk-free method note are all printed, once each', () => {
    const text = h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(count(text, 'Ranked by CAGR, 1 year')).toBe(1);
    expect(count(text, 'Ranked by CAGR, 3 year')).toBe(1);
    expect(count(text, 'Ranked by CAGR, 5 year')).toBe(1);
    expect(count(text, 'You need at least two funds to compare how they move together.')).toBe(1);
    expect(count(text, 'Comparing your funds')).toBe(1);
    expect(h).toContain('How this was calculated');
    expect(count(text, 'converted to a daily rate')).toBe(1);
  });
  it('the method note sits INSIDE the same section as the "two funds" sentence (one block that flows after the fund), not in a section of its own', () => {
    const section = h.slice(h.indexOf('<section class="fa-comparison'));
    expect(section.indexOf('You need at least two funds')).toBeGreaterThan(0);
    expect(section.indexOf('How this was calculated')).toBeGreaterThan(section.indexOf('You need at least two funds'));
    expect(section).toContain('data-fa-calc="true"');
    expect(section.indexOf('</section>')).toBeGreaterThan(section.indexOf('data-fa-calc="true"'));
  });
  it('a fund has a head and a body; a one-fund report adds no "returns, risk and your own money" tag (the cover and the head already name the only fund)', () => {
    expect(count(h, 'class="fa-fund-head"')).toBe(1);
    expect(count(h, 'class="fa-fund-body"')).toBe(1);
    expect(count(h, 'class="fa-block"')).toBe(5);
    expect(h).not.toContain('data-fa-body-tag');
  });
  it('dates stay day first; no ISO date anywhere', () => {
    expect(h.replace(/<[^>]+>/g, ' ')).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });
});

describe('two or more funds that CAN be compared keep the full section, and each body opens with a tag naming its fund', () => {
  const h = html(four);
  it('4 funds: the comparison is possible and rendered in its full form with rankings, the correlation block and the method note', () => {
    expect(comparisonPossible(four)).toBe(true);
    expect(h).toContain('data-fa-comparison="full"');
    expect(h).not.toContain('fa-comparison-none');
    expect(count(h, 'class="fa-rank"')).toBe(four.comparison.rankings.length);
    expect(count(h, 'class="fa-corr')).toBe(1);
    expect(h).toContain('data-fa-calc="true"');
  });
  it('every fund has a head and a body, and from the second fund on a page may begin with a body, so the body names its fund', () => {
    expect(count(h, 'class="fa-fund-head"')).toBe(4);
    expect(count(h, 'class="fa-fund-body"')).toBe(4);
    expect(count(h, 'class="fa-block"')).toBe(20);
    expect(count(h, 'data-fa-body-tag="true"')).toBe(4);
    for (const s of four.schemes) expect(h).toContain(`${s.schemeName}: returns, risk and your own money`);
  });
  it('2 funds with nothing rankable but one correlation: still the full section (a correlation exists), never silently dropped', () => {
    expect(comparisonPossible(two)).toBe(true);
    expect(html(two)).toContain('data-fa-comparison="full"');
  });
  it('comparisonPossible: false only when no ranking has a group AND no pair has a correlation', () => {
    const none = { comparison: { ...one.comparison, correlations: [], correlationsSkippedReason: null } };
    expect(comparisonPossible(none)).toBe(false);
    expect(comparisonPossible({ comparison: { ...four.comparison, correlationsSkippedReason: 'skipped', rankings: [] } })).toBe(false);
  });
  it('the compact form (more than 5 funds) keeps one ranking block and one correlation block', () => {
    const six = html(buildPrintFixture({ funds: 6 }).report);
    expect(six).toContain('data-fa-comparison="compact"');
    expect(count(six, 'class="fa-rank"')).toBe(1);
    expect(count(six, 'class="fa-corr')).toBe(1);
  }, 30_000);
});

describe('the print stylesheet (source contract)', () => {
  const css = read('app/globals.css');
  const block = css.slice(css.indexOf('.fa-doc {'), css.indexOf('/* Net Worth Statements', css.indexOf('.fa-doc {')));
  const rulesWith = (prop: RegExp): string[] =>
    [...block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => prop.test(m[2])).flatMap((m) => m[1].split(',').map((s) => s.trim()));

  it('NO fund and NO comparison section forces a page break before it (a single fund must not spend a page on the comparison)', () => {
    const forced = rulesWith(/break-before:\s*page/);
    expect(forced.filter((s) => /\.fa-comparison\b|\.fa-fund\b|\.fa-one\b|\.fa-cover\b/.test(s) && !/sheet/.test(s))).toEqual([]);
  });
  it('NEGATIVE CONTROL: the previous stylesheet (one rule forcing a break before every fund and the comparison) is caught by the same matcher', () => {
    const previous = '.fa-doc .fa-fund,\n.fa-doc .fa-comparison { break-before: page; page-break-before: always; }';
    const forced = [...previous.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => /break-before:\s*page/.test(m[2])).flatMap((m) => m[1].split(',').map((s) => s.trim()));
    expect(forced.filter((s) => /\.fa-comparison\b|\.fa-fund\b/.test(s))).toEqual(['.fa-doc .fa-fund', '.fa-doc .fa-comparison']);
  });
  it('a fund head, each block of a fund body, each ranking, the method note and the comparison heading are kept whole; tables and rows are not forced together', () => {
    const avoided = rulesWith(/break-inside:\s*avoid/);
    for (const s of ['.fa-doc .fa-fund-head', '.fa-doc .fa-block', '.fa-doc .fa-keep', '.fa-doc .fa-rank', '.fa-doc .fa-calc', '.fa-doc .fa-comparison-head', '.fa-doc .fa-comparison-none', '.fa-doc .fa-chart', '.fa-doc .fa-table tr']) expect(avoided, s).toContain(s);
    expect(avoided).not.toContain('.fa-doc .fa-table');
    expect(avoided).not.toContain('.fa-doc .fa-fund');
  });
  it("the last line of a kept piece does not glue it to the next piece (a chart caption once tied a fund's head to its body and Chromium moved both)", () => {
    expect(block).toMatch(/\.fa-doc \.fa-fund-head \.fa-chart \.fa-sub[\s\S]*?break-after: auto/);
  });
  it('the named page declares the four margin boxes (Chromium then prints none of its own) and takes its version line from the document', () => {
    const page = block.slice(block.indexOf('@page fa {'));
    for (const box of ['@top-left', '@top-right', '@bottom-left', '@bottom-right']) expect(page).toContain(box);
    expect(page).toContain('var(--fa-print-version');
  });
  it('the screen rules are untouched: the screen frame is as before and the new fund and comparison spacing sits inside @media print', () => {
    expect(block).toContain('@media screen {\n  .fa-doc { box-shadow: 0 0 0 1px #dde3ea; padding: 16mm; margin-top: 8mm; margin-bottom: 8mm; }');
    const at = block.indexOf('.fa-doc .fa-one > .fa-fund-head');
    expect(at).toBeGreaterThan(block.indexOf('@media print', block.indexOf('@media screen')));
  });
});

describe('the running header and footer of the print path', () => {
  it('the document carries the version line for the page header; the headless-renderer path switches the page margin boxes off (it draws its own)', () => {
    const browser = html(one, { timeZone: 'Australia/Sydney' });
    const server = html(one, { serverRender: true });
    expect(browser).toContain('<style>html{--fa-print-version:"Version 2, made 19-10-2026, 10:08 pm"}</style>'); // a real quote, not &quot; (React would escape a text child)
    expect(browser).not.toContain('&quot;');
    expect(browser).not.toContain('@top-left{content:none}');
    expect(server).toContain('@top-left{content:none}');
    expect(server).toContain('@bottom-right{content:none}');
  });
});

describe("the printed 'made' time uses the viewer's time zone, and says UTC when there is none", () => {
  it('the same stored instant: Sydney as the screen shows it (10:08 pm, 19-10-2026), Kolkata, and a late-evening UTC time that crosses midnight in Sydney', () => {
    expect(versionMadeLinePrint(2, '2026-10-19T11:08:00.000Z', 'INR', 'Australia/Sydney')).toBe('Version 2, made 19-10-2026, 10:08 pm');
    expect(versionMadeLinePrint(2, '2026-10-19T11:08:00.000Z', 'INR', 'Asia/Kolkata')).toBe('Version 2, made 19-10-2026, 4:38 pm');
    expect(formatDateTimeMinutes('2026-10-19T20:30:00.000Z', 'INR', 'Australia/Sydney')).toBe('20-10-2026, 7:30 am'); // the DATE moves with the zone too
    expect(formatDateTimeMinutes('2026-10-19T20:30:00.000Z', 'AUD', 'Australia/Sydney')).toBe('20/10/2026, 7:30 am');
  });
  it('NEGATIVE CONTROL: with no viewer zone the old bare "11:08 am" (UTC, unlabelled) is gone: the line says UTC', () => {
    const line = versionMadeLinePrint(2, '2026-10-19T11:08:00.000Z', 'INR', null);
    expect(line).toBe('Version 2, made 19-10-2026, 11:08 am UTC');
    expect(line).not.toBe('Version 2, made 19-10-2026, 11:08 am');
    expect(versionMadeLinePrint(2, '2026-10-19T11:08:00.000Z', 'INR', undefined)).toContain('UTC');
  });
  it("the printed cover shows the viewer-zone line, and the headless renderer's own header is labelled UTC", () => {
    expect(html(one, { timeZone: 'Australia/Sydney' })).toContain('<p class="fa-version">Version 2, made 19-10-2026, 10:08 pm</p>');
    expect(html(one)).toContain('<p class="fa-version">Version 2, made 19-10-2026, 11:08 am UTC</p>');
    expect(pdfHeaderTemplate(version)).toContain('made 19-10-2026, 11:08 am UTC');
  });
  it('only a real time zone name is accepted from the address (anything else is ignored, never put into a format call)', () => {
    expect(isKnownTimeZone('Australia/Sydney')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
    for (const bad of ['', null, undefined, 'Not/AZone', '<script>', 'a'.repeat(80), 'Australia/Sydney; drop']) expect(isKnownTimeZone(bad as never), String(bad)).toBe(false);
  });
  it('the print route reads the zone from the address and the screen sends it', () => {
    expect(read('app/(print)/reports/fund-analytics/print/page.tsx')).toMatch(/isKnownTimeZone\(tz\) \? tz : null/);
    expect(read('components/reports/FundAnalyticsReportClient.tsx')).toContain('&tz=${encodeURIComponent(viewerTz)}');
  });
});

// ---- the picker ------------------------------------------------------------------------------------------------------------------
const candidates = Array.from({ length: 25 }, (_, i) => ({ instrumentId: `f${String(i + 1).padStart(2, '0')}`, schemeName: `Fund ${i + 1}`, currentValue: i === 7 ? null : 100000 - i * 1000 }));
const suggested = candidates.filter((c) => c.currentValue !== null).slice(0, 10).map((c) => c.instrumentId);
const start: PickState = { max: 10, heldFundCount: 25, candidates, chosen: suggested, suggested };

describe('the fund picker rules (pure)', () => {
  it('"Clear all" leaves nothing ticked; "Select the 10 largest" then restores EXACTLY the default 10', () => {
    const cleared = clearAll(start);
    expect(cleared.chosen).toEqual([]);
    expect(selectLargest(cleared).chosen).toEqual(suggested);
    expect(selectLargest(cleared).chosen).toHaveLength(10);
  });
  it('after a custom choice, "Select the 10 largest" replaces it with the default (it does not add to it)', () => {
    const custom = { ...start, chosen: ['f20', 'f21', 'f22'] };
    expect(selectLargest(custom).chosen).toEqual(suggested);
  });
  it('the second report for "the rest" (preselected funds 11 to 20) is also reset by "Select the 10 largest" to the default, and cleared by "Clear all"', () => {
    const rest = { ...start, chosen: candidates.slice(10, 20).map((c) => c.instrumentId) };
    expect(selectLargest(rest).chosen).toEqual(suggested);
    expect(clearAll(rest).chosen).toEqual([]);
  });
  it('a box is refused once 10 are ticked; unticking one frees a place; a fund not in the list or already ticked changes nothing', () => {
    expect(toggleFund(start, 'f12', true)).toBe(start);
    expect(toggleFund(start, 'f12', true).chosen).toHaveLength(10);
    const freed = toggleFund(start, suggested[2], false);
    expect(freed.chosen).toHaveLength(9);
    expect(toggleFund(freed, 'f12', true).chosen).toHaveLength(10);
    expect(toggleFund(freed, 'zzz', true)).toBe(freed);
    expect(toggleFund(freed, suggested[0], true)).toBe(freed);
  });
  it('NEGATIVE CONTROL: a picker that simply appended every tick would go over 10; this one never does, over every one of the 25 funds ticked in order', () => {
    const naive = candidates.reduce((chosen: string[], c) => [...chosen, c.instrumentId], []);
    expect(naive.length).toBeGreaterThan(10);
    let p = clearAll(start);
    for (const c of candidates) p = toggleFund(p, c.instrumentId, true);
    expect(p.chosen).toHaveLength(10);
    expect(p.chosen).toEqual(candidates.slice(0, 10).map((c) => c.instrumentId));
  });
  it('the boxes beyond the maximum are disabled, but a ticked box is never disabled (it can always be unticked)', () => {
    expect(boxDisabled(start, 'f12')).toBe(true);
    expect(boxDisabled(start, suggested[0])).toBe(false);
    expect(boxDisabled(clearAll(start), 'f12')).toBe(false);
  });
  it('a suggestion with an unknown or repeated id, or longer than the maximum, still yields a valid selection; with no suggestion the largest by value are used', () => {
    const messy = { ...start, suggested: ['f01', 'f01', 'nope', ...suggested, 'f12'] };
    expect(selectLargest(messy).chosen).toHaveLength(10);
    expect(new Set(selectLargest(messy).chosen).size).toBe(10);
    const none = { ...start, suggested: [] };
    expect(selectLargest(none).chosen).toEqual(largestIds(candidates, 10));
    expect(largestIds(candidates, 10)).toEqual(suggested); // fund 8 has no value and is last, the rest are in value order
  });
});

describe('the picker panel (static render)', () => {
  const panel = (pick: PickState) => renderToStaticMarkup(createElement(FundPickPanel, { pick, onChange: () => {}, busy: false, onGenerate: () => {} }));
  it('has real buttons "Clear all" and "Select the 10 largest", the live "N of 10 chosen" counter, and the Generate button', () => {
    const h = panel(start);
    expect(h).toMatch(/<button[^>]*type="button"[^>]*>Clear all<\/button>/);
    expect(h).toMatch(/<button[^>]*type="button"[^>]*>Select the 10 largest<\/button>/);
    expect(h).toContain('10 of 10 chosen');
    expect(h).toContain('aria-live="polite"');
    expect(h).toContain('Generate a report for these funds');
    expect(h).toContain('Choose up to 10 funds for this report');
  });
  it('44 px targets and a focus ring come from the shared Btn; Clear all is off when nothing is ticked; Generate is off when nothing is ticked', () => {
    const empty = panel(clearAll(start));
    expect(empty).toContain('0 of 10 chosen');
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Clear all<\/button>/);
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>Generate a report for these funds<\/button>/);
    const h = panel(start);
    expect(h).toContain('min-h-11');
    expect(h).toContain('focus-visible:');
    expect(h).toContain('flex flex-wrap gap-2');
  });
  it('with 10 ticked, the other 15 boxes are disabled and the 10 ticked are not; the buttons are in the page before the list', () => {
    const h = panel(start);
    expect(count(h, 'type="checkbox"')).toBe(25);
    expect(count(h, 'checked=""')).toBe(10);
    expect(count(h, 'disabled=""')).toBe(15);
    expect(h.indexOf('Select the 10 largest')).toBeLessThan(h.indexOf('type="checkbox"'));
  });
  it('the screen uses the panel and keeps the default-selection and idempotency logic as it was (suggested ids, 10 cap, same attempt key)', () => {
    const client = read('components/reports/FundAnalyticsReportClient.tsx');
    expect(client).toContain('<FundPickPanel');
    expect(client).toContain('suggested: d.suggestedIds');
    expect(client).toContain('.slice(0, d.max)');
    expect(client).toContain("'Idempotency-Key': attemptKey.current");
    expect(client).toContain('preselect.current');
  });
});

// ---- recorded Chromium measurements (scripts/print/faPrintLayoutCheck.ts, 19-10-2026): the rule that judges the real PDFs also judges these ------------------
describe('recorded page fill of the real PDFs: the previous layout FAILS the blank-space rule, the new one passes', () => {
  /** How far down the text area the last ink reaches, per page, as measured in Chromium from the PDF itself. */
  const fills = {
    before: { 'funds-1': [63, 88, 38], 'funds-4': [71, 88, 88, 88, 88, 61], 'funds-10+longnames': [98, 13, 90, 88, 90, 88, 90, 88, 90, 88, 90, 88, 97, 11] },
    after: { 'funds-1': [95, 94], 'funds-4': [89, 91, 91, 91, 94, 42], 'funds-10+longnames': [90, 93, 89, 91, 89, 91, 89, 93, 89, 91, 89, 94] },
  } as const;
  const pages = (f: readonly number[]): PdfPageMetrics[] => f.map((p, i) => ({ page: i + 1, widthPt: 595, heightPt: 842, landscape: false, filledFrac: p / 100, items: [] }));
  const rules = (minFilledFrac: number): PrintLayoutRules => ({ minPages: 1, maxPages: 60, minFilledFrac, chapterStartHeadings: [], minFontPt: 7.4, rowTolerancePt: 14, rowPairs: [], marginBandMm: 21, forbiddenText: [], forbiddenInMargins: [], requirePageNumbers: false });
  const blank = (f: readonly number[], min: number) => evaluatePrintLayout(pages(f), rules(min)).filter((x) => x.rule === 'blank-space');

  it('one fund: 3 pages, the first 63% full, before; 2 pages, 95% and 94% full, after (no page but the last under 65%)', () => {
    expect(blank(fills.before['funds-1'], 0.65).map((x) => x.page)).toEqual([1]);
    expect(blank(fills.after['funds-1'], 0.65)).toEqual([]);
    expect(fills.before['funds-1']).toHaveLength(3);
    expect(fills.after['funds-1']).toHaveLength(2);
  });
  it('the Product Owner 10-fund shape: 14 pages with a page 13% full (a lone Note 4 and "How to read") and one 11% full, before; 12 pages, every one 89% full or more, after', () => {
    expect(blank(fills.before['funds-10+longnames'], 0.5).map((x) => x.page)).toEqual([2]);
    expect(blank(fills.after['funds-10+longnames'], 0.85)).toEqual([]);
    expect(fills.before['funds-10+longnames']).toHaveLength(14);
    expect(fills.after['funds-10+longnames']).toHaveLength(12);
  });
  it('4 funds: the same 6 pages, but the summary page goes from 71% to 89% full and the last page from 61% to a natural 42% tail', () => {
    expect(blank(fills.before['funds-4'], 0.8).map((x) => x.page)).toEqual([1]);
    expect(blank(fills.after['funds-4'], 0.85)).toEqual([]);
  });
});

// ---- the document title = the default file name of "Save as PDF" ----------------------------------------------------------------------
describe('the print page title names the report (the browser proposes it as the PDF file name)', () => {
  it('as-at month in words and the version number; the same month for every period; day-first numbers never appear', () => {
    expect(fundAnalyticsPrintTitle('2026-10-19', 3)).toBe('FHIP Fund Analytics - October 2026 - Version 3');
    expect(fundAnalyticsPrintTitle('2027-01-01', 12)).toBe('FHIP Fund Analytics - January 2027 - Version 12');
    expect(fundAnalyticsPrintTitle('2026-12-31', 1)).toBe('FHIP Fund Analytics - December 2026 - Version 1'); // read as written: no zone moves the month
    expect(fundAnalyticsPrintTitle('2026-10-19', 3)).not.toMatch(/\d{1,2}[-/]\d{1,2}/);
  });
  it('is safe as a file name: no slash, backslash, colon, pipe, quote, asterisk, question mark, angle bracket', () => {
    for (let m = 1; m <= 12; m++) expect(fundAnalyticsPrintTitle(`2026-${String(m).padStart(2, '0')}-15`, 7)).not.toMatch(/[\/:|"*?<>]/);
  });
  it('NEGATIVE CONTROL: the old title was the same for every report; two different reports now differ, and a bad input falls back to the plain name', () => {
    expect(fundAnalyticsPrintTitle('2026-10-19', 3)).not.toBe(fundAnalyticsPrintTitle('2026-10-19', 4));
    expect(fundAnalyticsPrintTitle('2026-10-19', 3)).not.toBe(fundAnalyticsPrintTitle('2026-09-19', 3));
    for (const bad of [[null, 3], ['2026-13-01', 3], ['junk', 3], ['2026-10-19', 0], ['2026-10-19', null], ['2026-10-19', 1.5]] as const) expect(fundAnalyticsPrintTitle(bad[0], bad[1]), String(bad)).toBe(FUND_ANALYTICS_TITLE_FALLBACK);
  });
  it('the print page sets it through generateMetadata for the person\'s own path only (the single-use render token is never spent for a title)', () => {
    const src = read('app/(print)/reports/fund-analytics/print/page.tsx');
    expect(src).toContain('export async function generateMetadata');
    const meta = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('export default async function'));
    expect(meta).toContain('fundAnalyticsPrintTitle(found.report.asOfDate, found.summary.versionNumber)');
    expect(meta).toContain('if (token || (!id && ids === undefined)) return fallback;');
    expect(meta).not.toContain('resolveNav2RenderToken');
    expect(meta).toContain('title: { absolute:');
  });
});
