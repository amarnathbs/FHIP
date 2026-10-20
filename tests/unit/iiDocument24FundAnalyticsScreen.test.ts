/**
 * Document2 (4) F1, F2 (tables), F10, F11, F12 on the Fund analytics SCREEN (Product Owner live review, 20-10-2026).
 *
 *  F1   "Dates used" broke a dd-mm-yyyy date at every hyphen (four lines per range).
 *  F2   the sideways scrollbar of a long table sat at the very bottom of it.
 *  F10  the one-page summary the PDF opens with was missing on the screen.
 *  F11  "What do you need for this to show": a bare "Not applicable".
 *  F12  the two-fund comparison did nothing visible: same fund twice, no reason, no coverage, nothing side by side.
 *
 * The components are rendered to HTML (no browser) and the pure rules are called directly, on the stored report fixture the other NAV2 view
 * tests use (4 funds, 6 pairs). Expected figures are read from the fixture's own stored values, never recomputed by the code under test.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FundAnalyticsReportView, { DatesUsed } from '@/components/reports/FundAnalyticsReportView';
import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';
import { DataTable } from '@/components/ui/DataTable';
import { buildFundAnalyticsSummary, compareTwoFunds, comparisonPickerOptions, defaultComparisonPair, describeComparisonCoverage, rankingPrerequisites } from '@/lib/engines/nav2/fundAnalyticsInsight';
import { percentLabel } from '@/lib/engines/nav2/ownershipShare';
import { hasSidewaysOverflow, mirroredScrollLeft } from '@/lib/ui/dataTable';
import type { FundAnalyticsReport } from '@/lib/engines/nav2/fundAnalyticsReport';

const load = (): FundAnalyticsReport => JSON.parse(readFileSync(path.resolve(__dirname, '..', 'fixtures', 'nav2', 'fund_analytics_report_v5.json'), 'utf8'));
const report = load();
const [CORP, HDFC_LC, GILT, NIPPON] = report.schemes.map((s) => s.instrumentId);
const ctx = { currency: 'INR' as const };
const html = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report }));

describe('F1: a date range in the "Dates used" column is two unbreakable dates', () => {
  it('renders each date in its own non-breaking line, so no width can split it at a hyphen', () => {
    const cell = renderToStaticMarkup(createElement(DatesUsed, { ctx, from: '2025-10-17', to: '2026-10-16' }));
    expect(cell).toBe('<span class="block whitespace-nowrap">17-10-2025</span><span class="block whitespace-nowrap">to 16-10-2026</span>');
    // the widest breakable run in the cell is the 10-character date: it fits a 320 px phone (the narrowest column is far wider than 10 characters of 12 px text)
    expect(Math.max(...cell.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).map((w) => w.length))).toBeLessThanOrEqual(10);
  });

  it('every "Dates used" cell on the report page uses it (no raw "dd-mm-yyyy to dd-mm-yyyy" text left to wrap)', () => {
    const cells = html.match(/<td[^>]*data-testid="dates-used"[^>]*>[\s\S]*?<\/td>/g) ?? [];
    expect(cells.length).toBeGreaterThanOrEqual(report.schemes.length * 3);
    for (const c of cells) if (c.replace(/<[^>]+>/g, '').trim() !== '') expect(c).toMatch(/<span class="block whitespace-nowrap">\d\d-\d\d-\d{4}<\/span><span class="block whitespace-nowrap">to \d\d-\d\d-\d{4}<\/span>/);
  });
});

describe('F2: the table scroll region carries a mirrored scrollbar above the table, only when it overflows', () => {
  it('overflow rule: only a table wider than its box (by more than rounding) shows the top bar; an unmeasured or fitting table shows nothing', () => {
    expect(hasSidewaysOverflow(1400, 900)).toBe(true);
    expect(hasSidewaysOverflow(900, 900)).toBe(false);
    expect(hasSidewaysOverflow(900.5, 900)).toBe(false);
    expect(hasSidewaysOverflow(0, 0)).toBe(false);
    expect(hasSidewaysOverflow(Number.NaN, 900)).toBe(false);
  });
  it('the two bars follow each other without ping-pong: a bar that is already at the position is left alone', () => {
    expect(mirroredScrollLeft(300, 0)).toBe(300);
    expect(mirroredScrollLeft(300, 300)).toBeNull();
    expect(mirroredScrollLeft(300, 299.6)).toBeNull();
  });
  it('the server markup is the same keyboard-focusable, named region as before (the top bar only appears after the browser measures)', () => {
    const t = renderToStaticMarkup(createElement(DataTable, { label: 'Holdings', children: createElement('tbody') } as never));
    expect(t).toMatch(/<div[^>]*class="fhip-table-wrap[^"]*"[^>]*>/);
    expect(t).toMatch(/role="region"/);
    expect(t).toMatch(/tabindex="0"/);
    expect(t).toMatch(/aria-label="Holdings"/);
    expect(t).not.toMatch(/table-top-scrollbar/);
  });
});

describe('F10: the on-screen report opens with the same one-page summary as the PDF', () => {
  const rows = buildFundAnalyticsSummary(report, percentLabel);
  const print = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report }));
  it('shows "Your funds at a glance" with one row per fund, linked to its own section', () => {
    expect(html).toContain('data-testid="fund-summary"');
    expect(html).toContain('Your funds at a glance');
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(html, r.name).toContain(`href="#fund-${r.instrumentId}"`);
      expect(html, r.name).toContain(`id="fund-${r.instrumentId}"`);
    }
  });
  it('every figure on the summary is the very figure the PDF summary prints (one model, two renderings)', () => {
    for (const r of rows) {
      for (const c of [r.valueNow, r.gainLoss, r.xirr, r.cagr3Year]) {
        if (!c || !c.available) continue;
        expect(html, `${r.name} ${c.text}`).toContain(c.text);
        expect(print, `${r.name} ${c.text}`).toContain(c.text);
      }
    }
  });
  it('each summary figure equals the figure in that fund\'s own section of the stored report', () => {
    const b = report.schemes[1];
    const x = b.analytics.investor!.xirr;
    const row = rows.find((r) => r.instrumentId === b.instrumentId)!;
    if (x.state === 'available') expect(row.xirr!.text).toBe(`${(x.value.rate * 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
    else expect(row.xirr!.available).toBe(false);
  });
  it('the print route does not repeat the summary card (it has its own cover)', () => {
    const printMode = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report, printMode: true }));
    expect(printMode).not.toContain('data-testid="fund-summary"');
  });
});

describe('F11: a ranking that cannot show says what is needed for it to show', () => {
  it('the 1 year ranking (not applicable in the stored report) names, fund by fund, the missing prerequisite', () => {
    const lines = rankingPrerequisites(report, '1Y');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/^Not applicable$/);
    const joined = lines.join(' ');
    expect(joined).toMatch(/1 year/);
    expect(joined).toMatch(/to rank it you would need to hold another|has no 1 year CAGR yet|category is not known/);
  });
  it('a horizon that DOES rank has no "what is needed" lines', () => {
    expect(rankingPrerequisites(report, '3Y')).toEqual([]);
  });
  it('the page prints the lines under the unavailable ranking', () => {
    expect(html).toContain('data-testid="ranking-needs"');
    expect(html).toContain('What is needed for this to show');
  });
  it('a lone fund of its kind is told the exact kind to add (category, plan, option)', () => {
    const r = load();
    r.comparison.rankings = r.comparison.rankings.map((x) => (x.horizonId === '3Y' ? { ...x, result: { ...(r.comparison.rankings.find((y) => y.horizonId === '1Y')!.result) } } : x));
    // the gilt fund is the only Gilt fund: it must be told what to add
    const lines = rankingPrerequisites(r, '3Y');
    const gilt = lines.find((l) => l.startsWith('ICICI Prudential Gilt Fund'));
    expect(gilt).toBeDefined();
    expect(gilt).toMatch(/another Gilt Fund fund, direct plan, growth option|has no 3 year CAGR yet/);
  });
});

describe('F12: the two-fund comparison', () => {
  it('the pickers offer each fund once and start on two DIFFERENT funds', () => {
    const options = comparisonPickerOptions(report);
    expect(options).toHaveLength(4);
    const [a, b] = defaultComparisonPair(options);
    expect(a).not.toBe(b);
    const dup = load();
    dup.schemes = [dup.schemes[0], dup.schemes[0], dup.schemes[1]];
    const dupOptions = comparisonPickerOptions(dup);
    expect(dupOptions.map((o) => o.value)).toEqual([CORP, HDFC_LC]);
    expect(defaultComparisonPair(dupOptions)[0]).not.toBe(defaultComparisonPair(dupOptions)[1]);
  });
  it('two DIFFERENT funds that print the same name are told apart by their kind', () => {
    const r = load();
    r.schemes[3] = { ...r.schemes[3], schemeName: r.schemes[1].schemeName, categoryLabel: 'Flexi Cap Fund' };
    const labels = comparisonPickerOptions(r).filter((o) => o.label.startsWith('HDFC Large Cap Fund')).map((o) => o.label);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
  });
  it('the same fund twice is refused with a sentence, not a number', () => {
    const c = compareTwoFunds(report, HDFC_LC, HDFC_LC);
    expect(c.status).toBe('invalid');
    expect(c.status === 'invalid' && c.message).toMatch(/Pick two different funds/);
  });
  it('an unknown fund is refused', () => {
    expect(compareTwoFunds(report, HDFC_LC, 'nope').status).toBe('invalid');
  });
  it('a good pair shows the stored correlation, the common returns used against the minimum, the window and each fund\'s own history', () => {
    const c = compareTwoFunds(report, HDFC_LC, NIPPON);
    expect(c.status).toBe('ok');
    if (c.status !== 'ok') return;
    expect(c.correlation).toBeCloseTo(0.9679584512691257, 12); // the stored value, either order
    expect(c.commonReturnCount).toBe(116);
    expect(c.windowStart).toBe('2026-04-06');
    expect(c.windowEnd).toBe('2026-10-01');
    expect(c.minimumReturns).toBe(30);
    expect(c.cautions).toEqual([]); // 116 is above the 60 the policy prefers
    expect(c.reading).toMatch(/very closely/);
    expect(c.rows.map((r) => r.label)).toContain('Fund CAGR, 3 year');
    const flipped = compareTwoFunds(report, NIPPON, HDFC_LC);
    expect(flipped.status === 'ok' && flipped.correlation).toBeCloseTo(0.9679584512691257, 12);
    const text = describeComparisonCoverage(c, ctx).join(' ');
    expect(text).toMatch(/116 daily returns on dates both funds have a price for, from 06-04-2026 to 01-10-2026\. At least 30 are needed/);
    expect(text).toMatch(/from 01-01-2013 to 01-10-2026/);
  });
  it('a pair with fewer than the preferred number of common returns carries the caution, not a refusal', () => {
    const r = load();
    const p = r.comparison.correlations.find((x) => x.aInstrumentId === HDFC_LC && x.bInstrumentId === NIPPON)!;
    (p.result as unknown as { value: { commonReturnCount: number } }).value.commonReturnCount = 45;
    const c = compareTwoFunds(r, HDFC_LC, NIPPON);
    expect(c.status === 'ok' && c.cautions.join(' ')).toMatch(/Only 45 returns are shared between these two funds \(fewer than 60\)/);
  });
  it('a pair the saved report never worked out says so and what to do', () => {
    const r = load();
    r.comparison.correlations = r.comparison.correlations.filter((p) => !(p.aInstrumentId === CORP && p.bInstrumentId === GILT));
    const c = compareTwoFunds(r, CORP, GILT);
    expect(c.status).toBe('unavailable');
    expect(c.status === 'unavailable' && c.headline).toBe('Not in this saved report');
    expect(c.status === 'unavailable' && c.whatToDo).toMatch(/Generate a new version/);
  });
  it('too few common returns names the minimum and the way to get more', () => {
    const r = load();
    const pair = r.comparison.correlations[0];
    r.comparison.correlations[0] = { ...pair, result: { state: 'insufficient_history', reason: 'too_few_returns', detail: 'At least 30 returns on shared dates are needed; these two schemes share 12.', disclosures: [], provenance: (pair.result as { provenance: unknown }).provenance } as never };
    const c = compareTwoFunds(r, pair.aInstrumentId, pair.bInstrumentId);
    expect(c.status).toBe('unavailable');
    if (c.status !== 'unavailable') return;
    expect(c.message).toMatch(/share 12/);
    expect(c.whatToDo).toMatch(/at least 30 returns on dates both have prices for/);
    expect(c.rows.length).toBeGreaterThan(3); // the funds are still shown side by side
  });
  it('a report too large for pairs says so, and still shows the two funds side by side', () => {
    const r = load();
    r.comparison.correlationsSkippedReason = 'Correlations are shown for up to 20 funds. This report has 25 funds, so pairs are not calculated.';
    const c = compareTwoFunds(r, CORP, GILT);
    expect(c.status === 'unavailable' && c.message).toMatch(/up to 20 funds/);
  });
  it('the page renders the picked pair\'s result: verdict, coverage and the side-by-side table (not just one line)', () => {
    expect(html).toContain('data-testid="comparison-ok"');
    expect(html).toContain('How closely they moved together');
    expect(html).toMatch(/side by side/);
    expect(html).toMatch(/Worked out from [\d,]+ daily returns on dates both funds have a price for/);
  });
});
