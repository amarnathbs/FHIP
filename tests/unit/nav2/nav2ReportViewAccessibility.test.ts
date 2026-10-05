// NAV2 Stage 3 accessibility findings on the Fund analytics report page (axe-core in a real browser, DEV):
//   NC-A1  a table that scrolls sideways on a phone must be reachable by keyboard (scrollable-region-focusable, 18 nodes at 375 px wide);
//   NC-A2  the "not available" labels are real text, so their colour must meet 4.5:1 on the white card (the amber token alone is 3.64:1).
// The component is rendered to HTML (no browser): the rules are checked on the markup the page actually produces.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FundAnalyticsReportView from '@/components/reports/FundAnalyticsReportView';

const report = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'fixtures', 'nav2', 'fund_analytics_report_v5.json'), 'utf8'));
const html = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report: report as never }));

function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('the report page tables and labels (axe findings)', () => {
  it('NC-A1: every sideways-scrolling table wrapper is keyboard focusable and named (tabindex 0, region role, label)', () => {
    const wrappers = html.match(/<div class="[^"]*overflow-x-auto[^"]*"[^>]*>/g) ?? [];
    expect(wrappers.length).toBeGreaterThan(3);
    for (const w of wrappers) {
      expect(w, w).toMatch(/tabindex="0"/);
      expect(w, w).toMatch(/role="region"/);
      expect(w, w).toMatch(/aria-label="[^"]+"/);
    }
  });

  it('NC-A2: the "unavailable" text colour has at least 4.5:1 contrast on white (the amber token alone is 3.64:1)', () => {
    const classes = [...html.matchAll(/class="font-medium (text-[^" ]+)"/g)].map((m) => m[1]);
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of new Set(classes)) {
      const hex = /^text-\[(#[0-9a-fA-F]{6})\]$/.exec(cls)?.[1] ?? (cls === 'text-caution' ? '#B7791F' : null);
      expect(hex, `unknown text colour class ${cls}`).not.toBeNull();
      expect(contrast(hex as string, '#FFFFFF'), `${cls} on white`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
