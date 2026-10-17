/**
 * Net Worth Statement UI contract: the Reports menu entry, the three statement pages (server-rendered to static markup), the shared
 * DataTable (accessible captions, header scope, labelled scroll regions), the print/one-page CSS contract, and Free vs Premium access.
 * There is no DOM environment in this repository, so pages are rendered with react-dom/server and checked structurally.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { computeNetWorthLevels, type NetWorthEntityInput } from '@/lib/engines/netWorthLevels';
import { NET_WORTH_STATEMENT_DISCLAIMER, buildNetWorthStatements, toModelRow, type StatementSourceRow } from '@/lib/engines/netWorthStatement';
import { PAGE1_DISCLAIMER } from '@/lib/engines/reportCopy';
import { NetWorthStatementView } from '@/components/reports/netWorthStatement/NetWorthStatementView';
import { StatementPicker, statementOptions } from '@/components/reports/netWorthStatement/StatementPicker';
import { NAV_GROUPS, REPORTS_ITEMS } from '@/lib/nav/appNavGroups';
import { NAV_HREF_MODULE_MAP } from '@/lib/nav/appNavCapability';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

let seq = 0;
function row(register: StatementSourceRow['register'], name: string, owner: string | null, amount: number | null, extra: Partial<StatementSourceRow> = {}): StatementSourceRow {
  seq += 1;
  return { id: `${register}:u${seq}`, register, name, owner, amountReporting: amount, nativeAmount: amount, nativeCurrency: 'AUD', group: register === 'assets' ? 'other' : null, ...extra };
}

function fixture(opts: { smsf?: boolean; company?: boolean; extra?: StatementSourceRow[]; currency?: 'AUD' | 'INR' } = {}) {
  const rows: StatementSourceRow[] = [
    row('assets', 'Principal Residence', 'self', 750_000, { group: 'property' }),
    row('assets', 'Vacant Land', 'joint', 345_000, { group: 'property' }),
    row('assets', 'Motor Vehicle', 'spouse', 26_000, { group: 'other' }),
    row('assets', 'Savings Account', 'self', 900, { group: 'cash' }),
    row('investments', 'Shares', 'self', 25_000),
    row('liabilities', 'Home Loan', 'self', 520_904),
    row('liabilities', 'Investment Loan', 'joint', 451_714),
    ...(opts.smsf ? [row('retirement', 'Other Retirement Assets', 'smsf', 133_000)] : []),
    ...(opts.extra ?? []),
  ];
  const entities: NetWorthEntityInput[] = opts.company ? [{ id: 'co', name: 'Smith Pty Ltd', kind: 'company', ownershipPercent: 40, netAssetValue: 500_000, detail: null }] : [];
  const currency = opts.currency ?? 'AUD';
  const levels = computeNetWorthLevels({ currency, rows: rows.map((r) => toModelRow(r)), entities });
  const set = buildNetWorthStatements({ levels, currency, asAt: '2026-10-16', rows, holderName: 'Asha Rao', fx: { fxRateAudInr: 56, rateSource: 'forecast_global_assumptions' }, importedNotInNetWorth: { count: 2, amount: 12_000 } });
  return set;
}

const html = (set: ReturnType<typeof fixture>, which: 'personal' | 'entity' | 'family' | 'all') =>
  renderToStaticMarkup(
    createElement(NetWorthStatementView, {
      statements: which === 'all' ? [set.personal, ...set.entities, set.family] : which === 'personal' ? [set.personal] : which === 'family' ? [set.family] : [set.entities[0]],
    }),
  );

describe('Reports menu entry', () => {
  it('Net Worth Statement is in the Reports group of the sidebar, after Monthly Report, with a real page behind it', () => {
    const reports = NAV_GROUPS.flatMap((g) => g.items).find((e) => e.type === 'dropdown' && e.id === 'reports');
    expect(reports && reports.type === 'dropdown' ? reports.items.map((i) => i.label) : []).toEqual(['Monthly Report', 'Net Worth Statement', 'Financial Activity', 'Consolidated Report', 'Forecast Variance']);
    expect(REPORTS_ITEMS.find((i) => i.label === 'Net Worth Statement')?.href).toBe('/reports/net-worth-statement');
    expect(() => read('app/(app)/reports/net-worth-statement/page.tsx')).not.toThrow();
    expect(() => read('app/(print)/reports/net-worth-statement/print/page.tsx')).not.toThrow();
  });

  it('it is governed by the Reports capability like the Monthly Report (hidden only when the module is unavailable)', () => {
    expect(NAV_HREF_MODULE_MAP['/reports/net-worth-statement']).toBe(NAV_HREF_MODULE_MAP['/reports']);
  });

  it('the Reports page also links to it (a card), and the sidebar marks only the most specific Reports item as current', () => {
    expect(read('app/(app)/reports/page.tsx')).toContain('href="/reports/net-worth-statement"');
    const shell = read('components/ui/AppShell.tsx');
    expect(shell).toMatch(/function isActiveInGroup/);
    expect(shell).toMatch(/isActiveInGroup\(pathname, item\.href, entry\.items\)/);
  });
});

describe('the picker offers one entry per statement', () => {
  it('Personal, each entity, Family and All statements, as plain links with aria-current on the active one', () => {
    const set = fixture({ smsf: true, company: true });
    expect(statementOptions(set).map((o) => o.label)).toEqual(['Personal', 'SMSF', 'Company – Smith Pty Ltd', 'Family (consolidated)', 'All statements']);
    const markup = renderToStaticMarkup(createElement(StatementPicker, { set, view: 'family' }));
    expect(markup).toContain('aria-label="Choose a statement"');
    expect(markup).toContain('href="/reports/net-worth-statement?view=family"');
    expect(markup).toContain('href="/reports/net-worth-statement?view=entity%3Atag%3Asmsf"');
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it('a household with no entities offers Personal, Family and All only', () => {
    expect(statementOptions(fixture()).map((o) => o.label)).toEqual(['Personal', 'Family (consolidated)', 'All statements']);
  });
});

describe('personal statement markup', () => {
  const markup = html(fixture({ smsf: true }), 'personal');

  it('has the title, the as-at date day-first, the reporting currency and the holder name', () => {
    expect(markup).toContain('>Net Worth Statement<');
    expect(markup).toContain('As at 16/10/2026');
    expect(markup).toContain('Reporting currency: AUD');
    expect(markup).toContain('Prepared for Asha Rao');
    expect(markup).not.toMatch(/\b2026-10-16\b/);
  });

  it('has an Assets table grouped with subtotals and a total, a Liabilities table with a total, a Net worth line, and a By person block', () => {
    expect(markup).toMatch(/data-testid="subtotal-property"[^>]*><span[^>]*>Subtotal<\/span>\$/);
    expect(markup).toContain('Total assets');
    expect(markup).toContain('Total liabilities');
    expect(markup).toContain('Personal net worth (assets minus liabilities)');
    expect(markup).toContain('By person');
    expect(markup).toContain('$1,146,900'); // total assets 750,000 + 345,000 + 26,000 + 900 + 25,000
  });

  it('is accessible: every table is a labelled keyboard-focusable region with a caption, and cells have header scope', () => {
    const regions = markup.match(/<div role="region" aria-label="[^"]+" tabindex="0"/g) ?? [];
    expect(regions.length).toBe(3);
    expect((markup.match(/<caption class="sr-only">/g) ?? []).length).toBe(3);
    expect(markup).toContain('<th scope="col"');
    expect(markup).toContain('<th scope="row"');
    expect(markup).toContain('<th scope="rowgroup"');
    expect(markup).toContain('<article class="nws-statement" aria-labelledby="nws-personal"');
  });

  it('never shows the SMSF in the personal page (the entity is on its own page)', () => {
    expect(markup).not.toContain('Other Retirement Assets');
    expect(markup).not.toContain('133,000');
  });

  it('states the level explanation, the D-05 note, and the standard disclaimer; no advice wording', () => {
    expect(markup).toContain('does not include any SMSF, trust, HUF or company assets');
    expect(markup).toContain('2 imported holdings worth $12,000 are not yet in Net Worth');
    expect(markup).toContain('This statement is provided for general financial-information and educational purposes.');
    expect(markup).toContain('does not constitute personal financial advice');
    expect(NET_WORTH_STATEMENT_DISCLAIMER).toBe(PAGE1_DISCLAIMER.replace(/^This report/, 'This statement')); // the standard line the other reports use
    expect(markup).not.toMatch(/you should|we recommend/i);
  });

  it('is the shared DataTable only (no raw table element is introduced by the statement components)', () => {
    expect(read('components/reports/netWorthStatement/NetWorthStatementView.tsx')).not.toMatch(/<table[\s>]/);
  });
});

describe('missing and unconverted items render honestly', () => {
  it('"Not provided" is shown instead of an amount, never "$0"; a foreign item shows its recorded amount; an unconvertible item is listed outside the totals', () => {
    const set = fixture({
      extra: [
        row('assets', 'Boat', 'self', null, { nativeAmount: null, group: 'other' }),
        row('assets', 'Chennai flat', 'self', 100_000, { nativeAmount: 5_600_000, nativeCurrency: 'INR', group: 'property' }),
        row('assets', 'USD account', 'self', null, { nativeAmount: 5_000, nativeCurrency: 'USD', group: 'cash' }),
      ],
    });
    const markup = html(set, 'personal');
    expect(markup).toMatch(/data-testid="not-provided">Not provided</);
    expect(markup).toContain('data-testid="native-amount"');
    expect(markup).toMatch(/Not included in the totals/);
    expect(markup).toContain('USD account');
    const boatRow = markup.slice(markup.indexOf('>Boat<'));
    expect(boatRow.slice(0, 400)).not.toContain('$0');
    expect(markup).toContain('1 AUD = 56 INR');
  });
});

describe('entity statements', () => {
  it('SMSF net only: shows the net separately with the honest "not itemised yet" note', () => {
    const markup = html(fixture({ smsf: true }), 'entity');
    expect(markup).toContain('SMSF');
    expect(markup).toContain('data-testid="not-itemised-note"');
    expect(markup).toContain('not itemised yet');
    expect(markup).toContain('Entered as: Other Retirement Assets.');
    expect(markup).toContain('$133,000');
    expect(markup).toContain('Amount included in the family total');
  });

  it('SMSF itemised (future shape): asset, liability and net shown separately: 503,000 / 370,000 / 133,000, no note', () => {
    const set = fixture({ extra: [row('assets', 'SMSF assets', 'smsf', 503_000), row('liabilities', 'SMSF loan', 'smsf', 370_000)] });
    const markup = html(set, 'entity');
    expect(markup).toMatch(/data-testid="entity-total-assets"[^>]*>\$503,000</);
    expect(markup).toMatch(/data-testid="entity-total-liabilities"[^>]*>\$370,000</);
    expect(markup).toMatch(/data-testid="entity-net"[^>]*>\$133,000</);
    expect(markup).not.toContain('not-itemised-note');
  });

  it('Company page: net at 100%, the household share, and the share amount that goes into the family total', () => {
    const set = fixture({ company: true });
    const company = set.entities.find((e) => e.entityKind === 'company')!;
    const markup = renderToStaticMarkup(createElement(NetWorthStatementView, { statements: [company] }));
    expect(markup).toMatch(/data-testid="entity-net"[^>]*>\$500,000</);
    expect(markup).toMatch(/data-testid="entity-percent"[^>]*>40%</);
    expect(markup).toMatch(/data-testid="entity-contribution"[^>]*>\$200,000</);
    expect(markup).toContain('Your ownership share');
  });
});

describe('SMSF page on the personal basis: holdings itemised, loan not recorded, fund record shown but not counted', () => {
  function productionSet() {
    const rows: StatementSourceRow[] = [
      row('assets', 'Savings Account', 'self', 900, { group: 'cash' }),
      row('retirement', 'SMSF', 'self', 503_000, { masterItemKey: 'smsf' }),
      row('retirement', 'Other Retirement Assets', 'smsf', 133_000),
    ];
    const levels = computeNetWorthLevels({ currency: 'AUD', rows: rows.map((r) => toModelRow(r)) });
    const holding = (id: string, name: string, v: number): StatementSourceRow => ({ id, register: 'assets', name, owner: 'smsf', amountReporting: v, nativeAmount: v, nativeCurrency: 'AUD', group: null });
    return buildNetWorthStatements({
      levels, currency: 'AUD', asAt: '2026-10-16', rows,
      smsfFunds: [{ fundId: 'f1', fundName: 'Rao Super Fund', mode: 'detailed', holdings: [holding('h1', 'Investment property', 475_000), holding('h2', 'Cash', 3_000), holding('h3', 'Other', 25_000)] }],
    });
  }

  it('lists property 475,000, cash 3,000, other 25,000 = 503,000 as assets, the liabilities as "Not recorded at the fund", and net 133,000', () => {
    const set = productionSet();
    const markup = renderToStaticMarkup(createElement(NetWorthStatementView, { statements: [set.entities[0]] }));
    expect(markup).toContain('Investment property');
    expect(markup).toMatch(/>\$475,000</);
    expect(markup).toMatch(/>\$3,000</);
    expect(markup).toMatch(/>\$25,000</);
    expect(markup).toMatch(/data-testid="entity-total-assets"[^>]*>\$503,000</);
    expect(markup).toMatch(/data-testid="liabilities-not-recorded"[^>]*>Not recorded at the fund</);
    expect(markup).toMatch(/data-testid="entity-total-liabilities"[^>]*><span[^>]*>Not recorded</);
    expect(markup).toMatch(/data-testid="entity-net"[^>]*>\$133,000</);
    expect(markup).not.toContain('not-itemised-note');
  });

  it('lists the fund record as "Shown but not counted" and says why', () => {
    const markup = renderToStaticMarkup(createElement(NetWorthStatementView, { statements: [productionSet().entities[0]] }));
    expect(markup).toContain('data-testid="shown-not-counted"');
    expect(markup).toContain('Shown but not counted');
    expect(markup).toContain('SMSF: $503,000.');
    expect(markup).toContain('would count the fund twice');
  });

  it('the personal page has no retirement group and no SMSF amount in any table (the data-quality notice may name it)', () => {
    const set = productionSet();
    const markup = renderToStaticMarkup(createElement(NetWorthStatementView, { statements: [set.personal] }));
    expect(markup).not.toContain('data-testid="group-retirement"');
    expect(markup).not.toMatch(/<td[^>]*>\$503,000/);
    expect(markup).toContain('Total assets');
  });
});

describe('family statement', () => {
  it('lists personal + each entity line by line = family net worth, and reconciles to the Dashboard', () => {
    const set = fixture({ smsf: true, company: true });
    const markup = html(set, 'family');
    expect(markup).toContain('How the family net worth is made up');
    expect(markup).toMatch(/data-testid="level-personal-net"[^>]*>\$/);
    expect(markup).toContain('40% ownership share');
    expect(markup).toContain('Reconciliation to the Dashboard');
    expect(markup).toMatch(/data-testid="recon-family"[^>]*>Agrees</);
    expect(markup).toMatch(/data-testid="family-equation"/);
    expect(set.family.totals.net).toBe(set.family.contributionSum);
  });

  it('"All statements" renders one article per statement, in print order', () => {
    const set = fixture({ smsf: true, company: true });
    const markup = html(set, 'all');
    expect((markup.match(/<article /g) ?? []).length).toBe(4);
    const order = [...markup.matchAll(/data-statement="(personal|entity|family)"/g)].map((m) => m[1]);
    expect(order).toEqual(['personal', 'entity', 'entity', 'family']);
  });

  it('a parity warning is shown on screen (and hidden in print) when the statement does not agree with the Dashboard model', () => {
    const set = fixture({ smsf: true });
    const markup = renderToStaticMarkup(createElement(NetWorthStatementView, { statements: [set.personal], parityMessages: ['example difference'] }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('no-print');
    expect(markup).toContain('example difference');
  });
});

describe('day-first dates in India context', () => {
  it('an INR household reads 16-10-2026', () => {
    const markup = html(fixture({ currency: 'INR' }), 'personal');
    expect(markup).toContain('As at 16-10-2026');
    expect(markup).toContain('Reporting currency: INR');
    expect(markup).toContain('₹');
  });
});

describe('one A4 page when printed: the CSS contract', () => {
  const css = read('app/globals.css');
  const print = css.slice(css.lastIndexOf('Net Worth Statements (PO request 16-10-2026)'));

  it('each statement starts a page, the last does not add a blank one', () => {
    expect(print).toMatch(/\.nws-root \.nws-statement \{[^}]*break-after: page/);
    expect(print).toMatch(/\.nws-root \.nws-statement:last-child \{[^}]*break-after: auto/);
  });

  it('a long table may flow onto a second page: headings repeat, rows stay whole, totals are the last rows (not a repeating footer)', () => {
    expect(print).toMatch(/\.nws-root table \{[^}]*break-inside: auto/);
    expect(print).toMatch(/\.nws-root thead \{[^}]*display: table-header-group/);
    expect(print).toMatch(/\.nws-root tr \{[^}]*break-inside: avoid/);
    expect(read('components/reports/netWorthStatement/NetWorthStatementView.tsx')).not.toContain('<tfoot');
  });

  it('is compact (8.5pt body, 8pt tables) and every rule is scoped to .nws-root, so no other page changes', () => {
    expect(print).toMatch(/\.nws-root \{[^}]*font-size: 8.5pt/);
    expect(print).toMatch(/@page nws \{[^}]*size: A4/);
    const body = print.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[\s\S]*?@media print \{/, '');
    const selectors = [...body.matchAll(/([^{}]+)\{[^}]*\}/g)].map((m) => m[1].trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(8);
    for (const sel of selectors.filter((x) => !x.startsWith('@page nws'))) for (const part of sel.split(/,(?![^(]*\))/)) expect(part.trim().startsWith('.nws-root'), part).toBe(true);
  });
});

describe('Free vs Premium access', () => {
  it('neither the page nor the print route checks the plan: the statement only presents the person’s own entered data', () => {
    for (const f of ['app/(app)/reports/net-worth-statement/page.tsx', 'app/(print)/reports/net-worth-statement/print/page.tsx', 'lib/services/netWorthStatementData.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/canExportReports|canViewPremiumReport|getPlanTier|plan_tier|requirePremium/);
    }
  });

  it('browser printing is the PDF path (Free), so there is no server export route or render token for the statement', () => {
    const printPage = read('app/(print)/reports/net-worth-statement/print/page.tsx');
    expect(printPage).toContain('PrintTabToolbar');
    expect(printPage).not.toMatch(/renderToken|getReportByRenderToken|searchParams.*token/);
  });
});
