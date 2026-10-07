// The Fund analytics report at SCALE (PO 07-10-2026): 1, 4, 12 and 25 funds built by the REAL report engine from synthetic data.
//   * the comparison section is ONE page for any number of funds: up to COMPARISON_FULL_MAX_FUNDS funds it keeps its full form, above it the
//     compact form (one ranking table, the most closely related pairs, a plain note saying what is shown);
//   * the engine's own limit is stated, not hidden: pairwise correlations are skipped above MAX_SCHEMES_FOR_PAIRS (20) funds, with a sentence;
//   * a long engine message (a solver listing hundreds of roots) is capped when printed as a footnote;
//   * the export decides ONE page or TWO per fund from a measurement in the browser (oneFundPerPageFits).
// NAMED NEGATIVE CONTROLS: NC-S1 (the compact comparison fits any number of ranked funds by capping rows), NC-S2 (a long note is clipped),
// NC-S3 (a sheet taller than the page makes the export choose two pages for the whole report, a short one keeps one).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FundAnalyticsPrintDocument, { clipFootnote, FOOTNOTE_MAX_CHARS } from '@/components/reports/FundAnalyticsPrintDocument';
import { COMPARISON_FULL_MAX_FUNDS, COMPARISON_MAX_RANK_ROWS, COMPARISON_TOP_PAIRS, parsePagePlan } from '@/lib/config/nav2/printLayout';
import { MAX_SCHEMES_FOR_PAIRS } from '@/lib/engines/nav2/fundAnalyticsReport';
import { buildPrintFixture, parseFixtureName } from '../../../scripts/nav2_print_fixtures';

const version = { versionNumber: 1, createdAt: '2026-10-07T03:00:00.000Z' };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const doc = (report: unknown) => renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report: report as never, version }));

describe('the fixture names', () => {
  it('parse funds-N with optional flags and reject anything else', () => {
    expect(parseFixtureName('funds-12+unavailable+redeemed+long+young')).toEqual({ funds: 12, unavailable: true, redeemed: true, longName: true, young: true });
    expect(parseFixtureName('funds-4')).toMatchObject({ funds: 4, unavailable: false });
    expect(() => parseFixtureName('twelve')).toThrow(/unknown print fixture/);
  });
  it('the plan parameter of the print route: only "2" selects two pages per fund', () => {
    expect(parsePagePlan('2')).toBe(2);
    expect(parsePagePlan('1')).toBe(1);
    expect(parsePagePlan(undefined)).toBe(1);
    expect(parsePagePlan('junk')).toBe(1);
  });
});

describe('NC-S2: a long engine message is clipped when printed as a footnote', () => {
  it('short text is unchanged, long text is cut at a word with a plain note, and the full text is not lost from the data', () => {
    expect(clipFootnote('A short explanation.')).toBe('A short explanation.');
    const roots = `243 distinct mathematically valid roots found: ${Array.from({ length: 243 }, (_, i) => (i / 100).toFixed(6)).join(', ')}`;
    const clipped = clipFootnote(roots);
    expect(roots.length).toBeGreaterThan(2000);
    expect(clipped.length).toBeLessThan(FOOTNOTE_MAX_CHARS + 80);
    expect(clipped).toContain('shortened here; the full text is in the stored report');
    expect(clipped.startsWith('243 distinct mathematically valid roots found')).toBe(true);
  });
});

describe('4 funds: the comparison keeps its full form', () => {
  const { report } = buildPrintFixture(parseFixtureName('funds-4'));
  const html = doc(report);
  it('a ranking table per category and horizon, every pair, no compact note', () => {
    expect(html).toContain('data-fa-comparison="full"');
    expect(text(html)).toContain('Ranked by CAGR, 1 year');
    expect(text(html)).not.toContain('most closely related');
    expect(COMPARISON_FULL_MAX_FUNDS).toBeGreaterThanOrEqual(4);
  });
});

describe('12 funds: the compact comparison', () => {
  const { report } = buildPrintFixture(parseFixtureName('funds-12+unavailable+redeemed+long+young'));
  const html = doc(report);
  it('one ranking table, the most closely related pairs, and a plain note about what is shown', () => {
    expect(report.schemes.length).toBe(12);
    expect(html).toContain('data-fa-comparison="compact"');
    expect(text(html)).toContain('Ranked by CAGR, within each category');
    expect(text(html)).toMatch(new RegExp(`Showing the ${COMPARISON_TOP_PAIRS} most closely related of 66 pairs`));
    expect(count(html, '<table')).toBeGreaterThanOrEqual(2);
  });
  it('the report keeps the full set: all 66 correlations are in the stored report, only the printed page is limited', () => {
    expect(report.comparison.correlations.length).toBe(66);
  });
  it('a fund with no rankable peer is said so in plain words and shown as "Not ranked", never as a number', () => {
    expect(text(html)).toMatch(/not ranked: no other fund of the same category/);
    expect(text(html)).toContain('Not ranked');
  });
  it('the special cases are all in the summary: unavailable (insufficient history), redeemed (value 0, a gain), a long name', () => {
    expect(text(html)).toContain('Insufficient history');
    expect(text(html)).toContain('Aster Diversified Equity and Debt Hybrid Opportunities Allocation Fund');
    expect(html).toContain('fully redeemed');
  });
});

describe('25 funds: built by the real engine', () => {
  const t0 = Date.now();
  const { report, manifest, timings } = buildPrintFixture(parseFixtureName('funds-25+unavailable+redeemed+long+young'));
  const html = doc(report);
  it('the report builds (timings recorded), is a few MB at most, and its manifest stays small', () => {
    console.log(`25-fund build: series ${timings.seriesMs} ms, report ${timings.reportMs} ms, report JSON ${timings.reportJsonBytes} bytes, manifest ${timings.manifestJsonBytes} bytes, whole describe ${Date.now() - t0} ms`);
    expect(report.schemes.length).toBe(25);
    expect(timings.reportJsonBytes).toBeLessThan(6_000_000);
    expect(timings.manifestJsonBytes).toBeLessThan(100_000);
    expect(manifest).toBeTruthy();
  });
  it('the engine limit is stated: pairwise correlations are skipped above MAX_SCHEMES_FOR_PAIRS funds, with a sentence (not a silent gap)', () => {
    expect(MAX_SCHEMES_FOR_PAIRS).toBe(20);
    expect(report.comparison.correlationsSkippedReason).toMatch(/Correlations are shown for up to 20 funds\. This report has 25 funds, so pairs are not calculated\./);
    expect(report.comparison.correlations.length).toBe(0);
    expect(text(html)).toContain('Correlations are shown for up to 20 funds. This report has 25 funds, so pairs are not calculated.');
  });
  it('NC-S1: the compact ranking table lists every ranked fund up to the cap and never more', () => {
    const m = /data-fa-comparison="compact"[\s\S]*?<table[\s\S]*?<\/table>/.exec(html);
    expect(m).not.toBeNull();
    const rows = count(m![0], '<tr') - 1; // minus the header row
    expect(rows).toBeLessThanOrEqual(COMPARISON_MAX_RANK_ROWS);
    expect(rows).toBeGreaterThanOrEqual(20);
  });
  it('one fund section per fund, each with its own chart', () => {
    expect(count(html, 'fa-fund fa-one')).toBe(25);
    expect(count(html, 'data-fa-chart="true"')).toBe(25 - 0);
  });
}, 120_000);

describe('NC-S4: the generation route declares the longest time the platform honours', () => {
  it('maxDuration is 28 s (Amplify compute kills every request at 28 s; a larger value is not honoured) and the reason is written next to it', () => {
    const src = readFileSync(path.join(__dirname, '..', '..', '..', 'app', 'api', 'reports', 'fund-analytics', 'route.ts'), 'utf8');
    expect(src).toMatch(/export const maxDuration = 28;/);
    expect(src).toContain('28 s');
    expect(src).not.toMatch(/export const maxDuration = (?!28;)\d+/);
  });
});

// ---- the browser measurement (needs Chromium) ----------------------------------------------------------------------------------------
function chromiumPresent(): boolean {
  const pw = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const home = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  return existsSync(pw) || existsSync(home) || !!process.env.PLAYWRIGHT_BROWSERS_PATH;
}
const noBrowser = !chromiumPresent() || spawnSync(process.execPath, ['-e', 'require("playwright")'], { stdio: 'ignore' }).status !== 0;

describe('NC-S3: the export measures whether every one-page fund sheet fits', () => {
  it.skipIf(noBrowser)(
    'a sheet shorter than the text area keeps the one-page plan; one taller than it (or any one of several) makes the whole report use two pages',
    async () => {
      const { chromium } = await import('playwright');
      const { oneFundPerPageFits } = await import('@/lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        const fits = async (heights: number[]) => {
          await page.setContent(`<div class="fa-doc">${heights.map((h) => `<section class="fa-one" style="height:${h}px"></section>`).join('')}</div>`);
          return oneFundPerPageFits(page);
        };
        expect(await fits([800, 900, 950])).toBe(true);
        expect(await fits([800, 1000, 900])).toBe(false); // one fund too tall: the WHOLE report goes to two pages, never a mix
        expect(await fits([])).toBe(true);
      } finally {
        await browser.close();
      }
    },
    60_000
  );
});
