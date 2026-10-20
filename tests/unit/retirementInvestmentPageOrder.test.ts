/**
 * Document2 (4) F16 / F17 -- Investment & Retirement page order and the "I don't have any ..." declaration.
 *
 * PO (20-10-2026): the retirement option and the status/declaration controls must be at the TOP; the long imported-statement content
 * below. Evidence label: UNIT-TESTED. The real pages are rendered with react-dom/server; the shared grid is replaced by a stand-in that
 * renders the grid's REAL slots in the grid's REAL order, and that real order is pinned separately against the grid source (the
 * grid itself loads its rows in effects, which static rendering does not run). Desktop and mobile share one DOM order (single column,
 * no reordering by CSS), pinned too. A browser walk-through on DEV is NOT PERFORMED (it needs a signed-in session).
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type GridProps = { subNav?: ReactNode; beforeGrid?: ReactNode; afterControls?: ReactNode; afterGrid?: ReactNode; extraActiveItems?: number; config: { title: string } };
// The same order FinancialDataGrid renders: tabs, title, beforeGrid, status/declaration + Add, afterControls, saved list, afterGrid.
vi.mock('@/components/grid/FinancialDataGrid', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/grid/FinancialDataGrid')>()),
  FinancialDataGrid: (p: GridProps) =>
    createElement('div', { 'data-extra': String(p.extraActiveItems ?? 0) }, p.subNav, createElement('h1', null, p.config.title), p.beforeGrid, createElement('p', null, 'STATUS-DECLARATION-AND-ADD'), p.afterControls, createElement('p', null, 'SAVED-LIST'), p.afterGrid),
}));
vi.mock('@/components/navigation/PageBackLink', () => ({ PageBackLink: () => null }));
vi.mock('@/lib/entitlements/useFinancialImportAccess', () => ({ useFinancialImportAccess: () => ({ access: { state: 'allowed' } }) }));
vi.mock('@/components/investments/InvestmentsSubNav', () => ({ InvestmentsSubNav: () => createElement('p', null, 'TABS-INVESTMENTS-RETIREMENT') }));
vi.mock('@/components/retirement/RetirementPlanningSection', () => ({ RetirementPlanningSection: () => createElement('p', null, 'RETIREMENT-PLANNING') }));
vi.mock('@/components/retirement/RetirementContributionsPanel', () => ({ RetirementContributionsPanel: () => createElement('p', null, 'CONTRIBUTIONS') }));
vi.mock('@/components/retirement/smsf/SmsfSection', () => ({ SmsfSection: () => createElement('p', null, 'SMSF-SECTION') }));
vi.mock('@/components/retirement/RetirementStatementImportPanel', () => ({ RetirementStatementImportPanel: () => createElement('p', null, 'IMPORT-RETIREMENT-PANEL') }));
vi.mock('@/components/retirement/RetirementStatementHistory', () => ({ RetirementStatementHistory: () => createElement('p', null, 'IMPORTED-RETIREMENT-HISTORY') }));
vi.mock('@/components/investments/ImportedInvestmentStatements', () => ({ ImportedInvestmentStatements: () => createElement('p', null, 'IMPORTED-INVESTMENT-STATEMENTS') }));
vi.mock('@/components/investments/PublishedFundValuations', () => ({ PublishedFundValuations: () => createElement('p', null, 'PUBLISHED-FUND-VALUATIONS') }));
vi.mock('@/components/investments/AuInvestmentStatementImportPanel', () => ({ AuInvestmentStatementImportPanel: () => null }));
vi.mock('next/link', () => ({ default: (p: { href: string; children: ReactNode }) => createElement('a', { href: p.href }, p.children) }));

import RetirementPage from '@/app/(app)/retirement/page';
import InvestmentsPage from '@/app/(app)/investments/page';
import { isNotApplicableBlocked, notApplicableBlockedText } from '@/components/grid/FinancialDataGrid';

const order = (html: string, labels: string[]) => labels.map((l) => html.indexOf(l));
const increasing = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

describe('F16 the pages put actions and declarations first and imported-statement content last', () => {
  it('Retirement: tabs, title, quick links, declaration and Add, planning, contributions, saved list, SMSF, then the long import and history', () => {
    const html = renderToStaticMarkup(createElement(RetirementPage));
    const labels = ['TABS-INVESTMENTS-RETIREMENT', '<h1>Retirement</h1>', 'Import statement', 'STATUS-DECLARATION-AND-ADD', 'RETIREMENT-PLANNING', 'CONTRIBUTIONS', 'SAVED-LIST', 'SMSF-SECTION', 'IMPORT-RETIREMENT-PANEL', 'IMPORTED-RETIREMENT-HISTORY'];
    expect(order(html, labels), JSON.stringify(order(html, labels))).toSatisfy(increasing);
  });

  it('[NC] the OLD order (planning, SMSF, long import and history BEFORE the declaration) would fail this assertion', () => {
    const old = ['STATUS-DECLARATION-AND-ADD', 'IMPORT-RETIREMENT-PANEL'];
    const oldHtml = '<p>RETIREMENT-PLANNING</p><p>SMSF-SECTION</p><p>IMPORT-RETIREMENT-PANEL</p><p>IMPORTED-RETIREMENT-HISTORY</p><p>STATUS-DECLARATION-AND-ADD</p>';
    expect(increasing(order(oldHtml, old))).toBe(false);
  });

  it('Investments: tabs first, ONE title, the import / India actions, declaration and Add, saved list, then the long imported-statement content', () => {
    const html = renderToStaticMarkup(createElement(InvestmentsPage));
    const labels = ['TABS-INVESTMENTS-RETIREMENT', '<h1>Investments</h1>', 'Import Australian Investment Statement', 'India Investments', 'STATUS-DECLARATION-AND-ADD', 'SAVED-LIST', 'IMPORTED-INVESTMENT-STATEMENTS', 'PUBLISHED-FUND-VALUATIONS'];
    expect(order(html, labels), JSON.stringify(order(html, labels))).toSatisfy(increasing);
    expect(html.match(/<h1>/g)).toHaveLength(1);
  });

  it('the grid really renders its slots in that order (pinned against the grid source)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../components/grid/FinancialDataGrid.tsx'), 'utf8');
    const marks = ['{subNav}', '{config.title}</h1>', '{beforeGrid}', 'data-testid="grid-not-applicable"', 'config.reviewSection && included.length > 0', '+ Add ${SINGULAR_ITEM_LABEL', '{afterControls}', 'Saved records list', '{afterGrid}'];
    const at = marks.map((m) => src.lastIndexOf(m) === -1 ? -1 : src.indexOf(m, src.indexOf('return (\n    <>\n      {subNav}\n      <div className="space-y-4">')));
    expect(at, JSON.stringify(at)).toSatisfy(increasing);
  });

  it('desktop and mobile share one DOM order: the page and grid reorder nothing with CSS order utilities', () => {
    for (const f of ['app/(app)/retirement/page.tsx', 'app/(app)/investments/page.tsx', 'components/grid/FinancialDataGrid.tsx']) {
      const src = readFileSync(path.resolve(__dirname, '../../', f), 'utf8');
      expect(src, f).not.toMatch(/className="[^"]*\border-(first|last|\d)/);
      expect(src, f).not.toMatch(/flex-col-reverse|flex-row-reverse/);
    }
  });
});

describe('F17 "I don\'t have any ..." cannot contradict existing active items', () => {
  it('is blocked while items exist, free when none, and an already-ticked box can always be unticked', () => {
    expect(isNotApplicableBlocked(false, 2)).toBe(true);
    expect(isNotApplicableBlocked(false, 0)).toBe(false);
    expect(isNotApplicableBlocked(true, 2)).toBe(false);
  });

  it('the SMSF fund counts as an active retirement item even though it is not a row of the grid', () => {
    const html = renderToStaticMarkup(createElement(RetirementPage));
    // the page passes the SMSF fund count through (0 before the page has loaded it; the count is what the grid adds to its own rows)
    expect(html).toContain('data-extra="0"');
    const src = readFileSync(path.resolve(__dirname, '../../app/(app)/retirement/page.tsx'), 'utf8');
    expect(src).toContain('extraActiveItems={smsfFunds}');
    expect(src).toContain("fetch('/api/smsf')");
  });

  it('tells the person what to do, in plain words with the count', () => {
    expect(notApplicableBlockedText('Retirement', 2)).toBe('You already have 2 active retirement items, so this does not apply. Remove them first if you want to say you have none.');
    expect(notApplicableBlockedText('Retirement', 1)).toContain('1 active retirement item, so this does not apply. Remove it first');
  });

  it('the checkbox is disabled while blocked, an existing contradiction is called out, and the toggle handler refuses a new tick (grid source)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../components/grid/FinancialDataGrid.tsx'), 'utf8');
    expect(src).toContain('disabled={notApplicableBlocked}');
    expect(src).toContain('grid-not-applicable-contradiction');
    expect(src).toMatch(/if \(checked && isNotApplicableBlocked\(false, included\.length \+ extraActiveItems\)\) return;/);
  });
});
