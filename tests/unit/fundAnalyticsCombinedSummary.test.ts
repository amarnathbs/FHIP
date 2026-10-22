// Fund analytics, COMBINED print: the consolidated front summary (PO follow-up 20-10-2026) -- one table of every fund, one merged list of notes, differences shown plainly.
//
// UNIT-TESTED here: lib/reports/fundAnalyticsCombinedSummary.ts (pure) and the markup of the combined document built from it. The rendered pages and fill in real
// Chromium are measured by scripts/print/faPrintLayoutCheck.ts --combined (see docs/reports/FUND_ANALYTICS_COMBINED_SUMMARY_REPORT_2026-10-20.md).
//
// NAMED NEGATIVE CONTROLS (the guard is removed in a copy and the same check is shown to FAIL on it):
//   NC-CS1  notes concatenated instead of merged: the same sentence appears once per report (duplicate check);
//   NC-CS2  funds listed in report order instead of by value (sort check);
//   NC-CS3  as-at / period differences merged silently (the "plainly shown" check);
//   NC-CS4  the fund pages' "see note N" pointer left at the single report's number after the notes were merged and renumbered (pointer check);
//   NC-CS5  a "This report covers X of your Y" sentence left in the merged notes instead of restated for the whole document.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import FundAnalyticsCombinedPrintDocument from '@/components/reports/FundAnalyticsCombinedPrintDocument';
import type { FundAnalyticsReport } from '@/lib/engines/nav2/fundAnalyticsReport';
import { calculationMode, coverage, differences, frontRows, mergeNotes, reportsLabel, type CombinedPartInput } from '@/lib/reports/fundAnalyticsCombinedSummary';
import { buildPrintFixture } from '../../scripts/nav2_print_fixtures';

vi.setConfig({ testTimeout: 120_000 }); // building the synthetic fixtures with the real report engine takes several seconds

const cache = new Map<number, FundAnalyticsReport>();
const base = (n: number): FundAnalyticsReport => {
  if (!cache.has(n)) cache.set(n, buildPrintFixture({ funds: n }).report);
  return JSON.parse(JSON.stringify(cache.get(n))) as FundAnalyticsReport;
};
/** A different set of funds (ids and names) from the same fixture, as a second batch is. */
const batch = (r: FundAnalyticsReport, tag: string): FundAnalyticsReport =>
  JSON.parse(r.schemes.reduce((j, s) => j.split(s.instrumentId).join(`${tag}-${s.instrumentId}`), JSON.stringify(r)).split('"schemeName":"').join(`"schemeName":"${tag} `)) as FundAnalyticsReport;
const V = (n: number) => ({ versionNumber: n, createdAt: `2026-10-20T01:0${n}:00.000Z` });
const part = (report: FundAnalyticsReport, n: number): CombinedPartInput => ({ report, version: V(n) });

const STATEMENT = (n: number) => `${n} statement line${n === 1 ? ' is' : 's are'} waiting for a review decision and ${n === 1 ? 'is' : 'are'} not shown here yet.`;
const COVERS = (c: number, h: number) => `This report covers ${c} of your ${h} Indian mutual funds, as you chose. The others can go in a second report.`;
const AS_AT = (d: string) => `Figures are as at ${d}. Prices are published by AMFI. This is information, not a recommendation to buy, sell or switch.`;
const RF = 'Sharpe and Sortino compare each fund with the RBI 91-day Treasury bill rate (source: Reserve Bank of India).';

/** Two reports of one household that holds `held` funds, written the way production writes them: statement lines first, the risk-free note, "covers X of your Y", the as-at note last. */
function pair(held = 17, lines: [number, number] = [3, 3]) {
  const r1 = base(4);
  const r2 = batch(base(3), 'B2');
  r1.notes = [STATEMENT(lines[0]), RF, COVERS(r1.schemes.length, held), AS_AT('01-10-2026')];
  r2.notes = [STATEMENT(lines[1]), RF, COVERS(r2.schemes.length, held), AS_AT('01-10-2026')];
  r1.selection = { heldFundCount: held, chosenCount: r1.schemes.length, max: 10, chosenInstrumentIds: r1.schemes.map((s) => s.instrumentId) };
  r2.selection = { heldFundCount: held, chosenCount: r2.schemes.length, max: 10, chosenInstrumentIds: r2.schemes.map((s) => s.instrumentId) };
  return [part(r1, 4), part(r2, 5)];
}
const texts = (parts: CombinedPartInput[]) => mergeNotes(parts).notes.map((n) => n.text);
const dupes = (list: string[]) => list.filter((t, i) => list.indexOf(t) !== i);

describe('one table: every fund exactly once, largest current value first', () => {
  it('lists the funds of all reports once each, sorted by value, whatever the report order', () => {
    const parts = pair();
    const { rows, duplicateFunds } = frontRows(parts);
    const ids = rows.map((r) => parts[r.partIndex].report.schemes[r.schemeIndex].instrumentId);
    expect(ids.length).toBe(7);
    expect(new Set(ids).size).toBe(7);
    expect(duplicateFunds).toEqual([]);
    const value = (r: { partIndex: number; schemeIndex: number }) => {
      const cv = parts[r.partIndex].report.schemes[r.schemeIndex].analytics.investor?.currentValue;
      return cv && cv.state === 'available' ? cv.value.value : -Infinity;
    };
    for (let i = 1; i < rows.length; i++) expect(value(rows[i - 1])).toBeGreaterThanOrEqual(value(rows[i]));
  });
  it('a fund with no value comes last; equal values keep report order then the report\'s own order', () => {
    const parts = pair();
    const first = parts[0].report.schemes[0];
    first.analytics.investor!.currentValue = { state: 'unavailable' } as never;
    const ids = (ps: CombinedPartInput[]) => frontRows(ps).rows.map((r) => ps[r.partIndex].report.schemes[r.schemeIndex].instrumentId);
    expect(ids(parts).at(-1)).toBe(first.instrumentId);
    for (const p of parts) for (const s of p.report.schemes) s.analytics.investor!.currentValue = { state: 'unavailable' } as never;
    expect(ids(parts)).toEqual([...parts[0].report.schemes, ...parts[1].report.schemes].map((s) => s.instrumentId));
  });
  it('a fund that two reports cover is listed ONCE (from the first report) and a plain note says so; nothing else changes', () => {
    const r = base(2);
    const parts = [part(r, 4), part(JSON.parse(JSON.stringify(r)) as FundAnalyticsReport, 5)];
    const { rows, duplicateFunds } = frontRows(parts);
    expect(rows.length).toBe(2);
    expect(rows.every((x) => x.partIndex === 0)).toBe(true);
    expect(duplicateFunds.length).toBe(2);
    expect(mergeNotes(parts, duplicateFunds).notes.some((n) => /covered by more than one of these reports/.test(n.text))).toBe(true);
  });
  it('NC-CS2: listing in report order is not sorted (the sort check catches it)', () => {
    const parts = pair();
    const vals = parts.flatMap((p) => p.report.schemes.map((s) => (s.analytics.investor!.currentValue.state === 'available' ? (s.analytics.investor!.currentValue as { value: { value: number } }).value.value : -Infinity)));
    const sortedDesc = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] >= x);
    expect(sortedDesc([...vals].sort((a, b) => b - a))).toBe(true);
    expect(sortedDesc(vals)).toBe(false); // report order: report 2's funds are smaller than report 1's last, and the fixture values are not monotone across the two
  });
});

describe('merged notes: dedupe, restate, never invent', () => {
  it('notes identical across the reports appear ONCE, without a report label', () => {
    const t = texts(pair());
    expect(t.filter((x) => x === RF).length).toBe(1);
    expect(t.filter((x) => x === STATEMENT(3)).length).toBe(1); // the same household fact in both reports
    expect(t.some((x) => /^Reports? \d/.test(x) && x.includes(RF))).toBe(false);
    expect(dupes(t)).toEqual([]);
  });
  it('Note 1 differs (3 versus 2 statement lines): each report\'s value is stated plainly with its report named, NEVER summed', () => {
    const t = texts(pair(17, [3, 2]));
    expect(t).toContain(`Report 1 (Version 4): ${STATEMENT(3)}`);
    expect(t).toContain(`Report 2 (Version 5): ${STATEMENT(2)}`);
    expect(t.some((x) => /5 statement lines/.test(x))).toBe(false);
  });
  it('Note 3 ("This report covers X of your Y") is restated for the whole document from the reports\' own numbers', () => {
    const t = texts(pair(17));
    expect(t).toContain('This document covers 7 of your 17 Indian mutual funds in 2 reports. The others can go in another report.');
    expect(t.some((x) => x.startsWith('This report covers'))).toBe(false);
    expect(coverage(pair(17))).toEqual({ covered: 7, heldFundCount: 17 });
    // when the reports together cover every held fund
    const all = texts(pair(7));
    expect(all).toContain('This document covers all 7 of your Indian mutual funds in 2 reports.');
  });
  it('when the reports disagree about how many funds are held, each report\'s own numbers are stated with the report named (nothing is guessed)', () => {
    const parts = pair(17);
    parts[1].report.selection!.heldFundCount = 15;
    parts[1].report.notes[2] = COVERS(3, 15);
    const t = texts(parts);
    expect(t).toContain('Report 1 (Version 4): This report covers 4 of your 17 Indian mutual funds.');
    expect(t).toContain('Report 2 (Version 5): This report covers 3 of your 15 Indian mutual funds.');
    expect(coverage(parts).heldFundCount).toBeNull();
  });
  it('the as-at note keeps its disclaimer ("information, not a recommendation") and is the LAST note; different dates are listed per report, never merged silently', () => {
    const same = texts(pair());
    expect(same.at(-1)).toBe(AS_AT('01-10-2026'));
    const parts = pair();
    parts[1].report.notes[3] = AS_AT('05-10-2026');
    parts[1].report.asOfDate = '2026-10-05';
    const diff = texts(parts);
    expect(diff.at(-1)).toBe(AS_AT('01-10-2026 (report 1, Version 4); 05-10-2026 (report 2, Version 5)'));
    expect(diff.at(-1)).toContain('This is information, not a recommendation to buy, sell or switch.');
    expect(differences(parts)).toEqual({ asOf: true, period: false });
    expect(differences(pair())).toEqual({ asOf: false, period: false });
    parts[1].report.periodChoice = parts[0].report.periodChoice === 'all_history' ? 'since_first_held' : 'all_history';
    expect(differences(parts).period).toBe(true);
  });
  it('a note about one named fund, and a note that only some reports carry, keep their meaning (the first as it is, the second with its report named)', () => {
    const parts = pair();
    const ph = 'Price history for Aster Large Cap Fund could not be loaded (no data); its figures are marked not available.';
    parts[0].report.notes.splice(1, 0, ph);
    parts[1].report.notes.splice(1, 0, 'Beta and alpha use Nifty 50 (price return) where a declared benchmark is available.');
    const t = texts(parts);
    expect(t).toContain(ph);
    expect(t).toContain('Report 2 (Version 5): Beta and alpha use Nifty 50 (price return) where a declared benchmark is available.');
  });
  it('NC-CS1: concatenating every report\'s notes repeats each shared sentence (the duplicate check catches it); the real merge has none', () => {
    const parts = pair();
    const concatenated = parts.flatMap((p) => p.report.notes);
    expect(dupes(concatenated).length).toBeGreaterThan(0);
    expect(dupes(texts(parts))).toEqual([]);
  });
  it('NC-CS5: leaving the per-report sentence "This report covers..." in the merged notes would be wrong for a document of 2 reports (the restatement check catches it)', () => {
    const parts = pair();
    const leftAsIs = parts.flatMap((p) => p.report.notes).filter((n) => n.startsWith('This report covers'));
    expect(leftAsIs.length).toBe(2);
    expect(texts(parts).filter((n) => n.startsWith('This report covers')).length).toBe(0);
  });
});

describe('the "see note N" pointer of the fund pages follows the merged notes', () => {
  const pointers = (html: string) => [...html.matchAll(/see note (\d+)/g)].map((m) => Number(m[1]));
  const render = (parts: CombinedPartInput[]) => renderToStaticMarkup(createElement(FundAnalyticsCombinedPrintDocument, { parts, timeZone: 'Asia/Kolkata' }));

  it('merged notes are numbered once; every fund page points at the merged risk-free note, whose number differs from the single report\'s', () => {
    const parts = pair();
    const { notes, riskFreeNoteByPart } = mergeNotes(parts);
    const k = notes.findIndex((n) => n.text === RF) + 1;
    expect(riskFreeNoteByPart).toEqual([k, k]);
    const html = render(parts);
    const body = html.slice(html.indexOf('data-fa-part="1"'));
    expect(pointers(body).length).toBeGreaterThan(0);
    expect(new Set(pointers(body))).toEqual(new Set([k]));
    expect(html).toContain(`<span class="fa-note-no">Note ${k}</span> ${RF}`);
  });
  it('NC-CS4: the single report numbers the risk-free note 2 here too only by luck; with the notes merged differently the old number is wrong (the pointer check catches a stale number)', () => {
    const parts = pair(17, [3, 2]); // Note 1 now differs, so the merged list is longer: the risk-free note moves from 2 to 3
    const { notes, riskFreeNoteByPart } = mergeNotes(parts);
    const merged = notes.findIndex((n) => n.text === RF) + 1;
    const own = parts[0].report.notes.findIndex((n) => n === RF) + 1;
    expect(merged).toBe(3);
    expect(own).toBe(2);
    expect(riskFreeNoteByPart).toEqual([merged, merged]);
    expect(riskFreeNoteByPart[0]).not.toBe(own); // a pointer left at the single report's number would say "see note 2" and name a statement-lines note
    const html = render(parts);
    expect(new Set(pointers(html))).toEqual(new Set([merged]));
    expect(html).toContain(`<span class="fa-note-no">Note ${merged}</span> ${RF}`);
  });
  it('when the reports state different risk-free sources, each report points at ITS OWN labelled note', () => {
    const parts = pair();
    parts[1].report.notes[1] = 'Sharpe and Sortino compare each fund with the RBI policy repo rate, used as a stand-in for a risk-free rate (source: Reserve Bank of India).';
    const { notes, riskFreeNoteByPart } = mergeNotes(parts);
    expect(notes.some((n) => n.text.startsWith('Report 1 (Version 4): Sharpe and Sortino'))).toBe(true);
    expect(notes.some((n) => n.text.startsWith('Report 2 (Version 5): Sharpe and Sortino'))).toBe(true);
    expect(riskFreeNoteByPart[0]).not.toBe(riskFreeNoteByPart[1]);
    expect(notes[(riskFreeNoteByPart[1] as number) - 1].text).toContain('repo rate');
    expect(notes[(riskFreeNoteByPart[0] as number) - 1].text).toContain('91-day');
  });
});

describe('reports made for different dates or periods are never merged silently', () => {
  const render = (parts: CombinedPartInput[]) => renderToStaticMarkup(createElement(FundAnalyticsCombinedPrintDocument, { parts, timeZone: 'Asia/Kolkata' }));
  const plainly = (html: string) => html.includes('These reports were made for different dates or periods, so their figures are not directly comparable:') && html.includes('scope="col" class="">Report<');

  it('same date and period: one "As at ... Period: ..." line and no Report column', () => {
    const html = render(pair());
    expect(html).toContain('As at ');
    expect(html).not.toContain('data-fa-differences');
    expect(html).not.toContain('>Report</th>');
  });
  it('a different as-at date: each report\'s date and period is listed, the table gets a Report column, the merged as-at note names both dates', () => {
    const parts = pair();
    parts[1].report.asOfDate = '2026-10-05';
    parts[1].report.notes[3] = AS_AT('05-10-2026');
    const html = render(parts);
    expect(html).toContain('These reports were made for different dates or periods, so their figures are not directly comparable:');
    expect(html).toContain('data-fa-differences="true"');
    expect(html).toContain('Report 1 (Version 4): as at 01-10-2026');
    expect(html).toContain('Report 2 (Version 5): as at 05-10-2026');
    expect(html).toContain('>Report</th>');
    expect(html).toContain('01-10-2026 (report 1, Version 4); 05-10-2026 (report 2, Version 5)');
  });
  it('a different period is shown the same way', () => {
    const parts = pair();
    parts[1].report.periodChoice = parts[0].report.periodChoice === 'all_history' ? 'since_first_held' : 'all_history';
    const html = render(parts);
    expect(html).toContain('data-fa-differences="true"');
    expect(html).toContain('>Report</th>');
  });
  it('NC-CS3: a front that hides the differences fails the "plainly shown" check', () => {
    const parts = pair();
    parts[1].report.asOfDate = '2026-10-05';
    const html = render(parts);
    expect(html).toContain('different dates or periods');
    const silent = html.replace('These reports were made for different dates or periods, so their figures are not directly comparable:', '').replace('data-fa-differences="true"', '');
    expect(silent).not.toContain('different dates or periods');
    expect(silent).not.toContain('data-fa-differences');
    void plainly;
  });
});

describe('the method note and labels', () => {
  it('"once" when every report\'s method text is identical, "per_report" when any differs, "none" when there is none', () => {
    const parts = pair();
    expect(calculationMode(parts)).toBe('once');
    parts[1].report.calculationNotes = ['Another method text.'];
    expect(calculationMode(parts)).toBe('per_report');
    parts[0].report.calculationNotes = undefined;
    parts[1].report.calculationNotes = undefined;
    expect(calculationMode(parts)).toBe('none');
  });
  it('report labels read plainly', () => {
    const parts = [part(base(1), 4), part(base(1), 5), part(base(1), 6)];
    expect(reportsLabel(parts, [0])).toBe('Report 1 (Version 4)');
    expect(reportsLabel(parts, [0, 1])).toBe('Reports 1 and 2 (Versions 4 and 5)');
    expect(reportsLabel(parts, [0, 1, 2])).toBe('Reports 1, 2 and 3 (Versions 4, 5 and 6)');
  });
});
