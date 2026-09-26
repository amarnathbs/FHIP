/**
 * WP-07 acceptance -- provenance badges on the Income / Expenses / Assets /
 * Liabilities / Retirement / Investments grids (GAP-06, G7, GAP-RET-08), the
 * reworded "leave out" opt-out hidden on imported rows, and the Liabilities
 * statement columns.
 *
 * NEGATIVE CONTROL: on the base branch (f79374f) the grid recognised ONE
 * source_type ('investment_intelligence_published'); lib/grid/provenance.ts
 * and components/grid/ProvenanceBadge.tsx do not exist, so this file fails at
 * import, and the config assertions below fail on the base configs (old
 * labels, no hiddenOnImportedRows, no minimum_payment / due_date /
 * masked_identifier on the Liabilities grid).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { ProvenanceBadge } from '@/components/grid/ProvenanceBadge';
import { fdhPages } from '@/lib/import-bridge/fdhRoutes';
import { expenseGridConfig, incomeGridConfig, liabilityGridConfig } from '@/lib/grid/configs';
import { HISTORY_ROUTE_BUILDER, IMPORT_SOURCE_TYPES, isFieldHiddenOnRow, provenanceBadgeFor } from '@/lib/grid/provenance';

const EXPECTED: Record<string, string> = {
  payslip_import: 'Imported from payslip',
  liability_statement_import: 'Imported from loan statement',
  retirement_statement_import: 'Imported from retirement statement',
  investment_intelligence_published: 'Imported via Investment Intelligence',
  bank_statement_import: 'Imported from bank statement',
  bank_statement_average: 'Updated from your bank statement averages',
};

describe('a badge for every import source_type the registers stamp', () => {
  it.each(Object.entries(EXPECTED))('%s -> "%s"', (sourceType, label) => {
    const badge = provenanceBadgeFor({ source_type: sourceType });
    expect(badge?.label).toBe(label);
    const html = renderToStaticMarkup(createElement(ProvenanceBadge, { row: { source_type: sourceType } }));
    expect(html).toContain(label);
    expect(html).toContain(`data-provenance="${sourceType}"`);
  });

  it('covers exactly the stamped values (payslip 0091, liability 0096, retirement 0112, II 0042, WP-15 0214)', () => {
    expect([...IMPORT_SOURCE_TYPES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('a credit-card liability says "credit card statement"', () => {
    expect(provenanceBadgeFor({ source_type: 'liability_statement_import', debt_type: 'credit_card' })?.label).toBe('Imported from credit card statement');
  });

  it('a manual row, a missing value or an unknown value renders nothing', () => {
    for (const v of ['manual', null, undefined, '', 'something_else']) {
      expect(provenanceBadgeFor({ source_type: v })).toBeNull();
      expect(renderToStaticMarkup(createElement(ProvenanceBadge, { row: { source_type: v } }))).toBe('');
    }
  });

  it('the tooltip carries last_imported_at when recorded', () => {
    const b = provenanceBadgeFor({ source_type: 'retirement_statement_import', last_imported_at: '2026-09-20T03:00:00Z' });
    expect(b?.title).toMatch(/^Imported from retirement statement — last imported \d{1,2} Sept? 2026$/);
    expect(provenanceBadgeFor({ source_type: 'retirement_statement_import', last_imported_at: 'not-a-date' })?.title).toBe('Imported from retirement statement');
  });
});

describe('history link: shown only when the domain history route exists', () => {
  const pages = fdhPages as unknown as Record<string, unknown>;
  afterEach(() => { for (const name of Object.values(HISTORY_ROUTE_BUILDER)) delete pages[name]; });

  it('payslip / liability / retirement: no link until WP-09/11/13 publish their history builders (never a 404 link)', () => {
    for (const st of ['payslip_import', 'liability_statement_import', 'retirement_statement_import']) {
      expect(provenanceBadgeFor({ source_type: st })?.historyHref).toBeNull();
      expect(renderToStaticMarkup(createElement(ProvenanceBadge, { row: { source_type: st } }))).not.toContain('<a ');
    }
  });

  it('the link appears as soon as the named builder exists on fdhPages', () => {
    pages[HISTORY_ROUTE_BUILDER.retirement_statement_import] = () => '/x/retirement-history';
    const b = provenanceBadgeFor({ source_type: 'retirement_statement_import' });
    expect(b?.historyHref).toBe('/x/retirement-history');
    expect(renderToStaticMarkup(createElement(ProvenanceBadge, { row: { source_type: 'retirement_statement_import' } }))).toContain('href="/x/retirement-history"');
  });

  it('bank-statement assets link to that account\'s transactions; averages link to spending; II to its data page', () => {
    expect(provenanceBadgeFor({ source_type: 'bank_statement_import', source_financial_account_id: 'acc-1' })?.historyHref).toBe(fdhPages.activityTransactions({ accountId: 'acc-1' }));
    expect(provenanceBadgeFor({ source_type: 'bank_statement_average' })?.historyHref).toBe(fdhPages.activitySpending());
    expect(provenanceBadgeFor({ source_type: 'investment_intelligence_published' })?.historyHref).toBe('/investment-intelligence/data');
  });
});

describe('the reworded opt-out is hidden (and not submitted) on imported rows', () => {
  const field = (cfg: typeof expenseGridConfig) => cfg.fields.find((f) => f.name === 'superseded_by_bank_import')!;

  it('Expenses and Income: new wording, flagged hiddenOnImportedRows', () => {
    expect(field(expenseGridConfig).label).toBe('Leave out of my plan (always use my imported spending instead)');
    expect(field(incomeGridConfig).label).toBe('Leave out of my income (already counted from an imported payslip or bank statement)');
    expect(field(expenseGridConfig).hiddenOnImportedRows).toBe(true);
    expect(field(incomeGridConfig).hiddenOnImportedRows).toBe(true);
  });

  it('hidden on an imported row, shown on a manual row', () => {
    expect(isFieldHiddenOnRow(field(expenseGridConfig), { source_type: 'bank_statement_average' })).toBe(true);
    expect(isFieldHiddenOnRow(field(incomeGridConfig), { source_type: 'payslip_import' })).toBe(true);
    expect(isFieldHiddenOnRow(field(expenseGridConfig), { source_type: 'manual' })).toBe(false);
    expect(isFieldHiddenOnRow(field(expenseGridConfig), {})).toBe(false);
    const amount = expenseGridConfig.fields.find((f) => f.name === 'amount');
    expect(isFieldHiddenOnRow(amount, { source_type: 'bank_statement_average' })).toBe(false);
  });

  it('the grid wires it: FinancialDataGrid consults isFieldHiddenOnRow and renders ProvenanceBadge (no II-only badge left)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/grid/FinancialDataGrid.tsx'), 'utf8');
    expect(src).toMatch(/isFieldHiddenOnRow\(config\.fields\.find/);
    expect((src.match(/<ProvenanceBadge row=\{row\}/g) ?? []).length).toBe(2); // desktop table + mobile cards
    expect(src).not.toMatch(/Imported via Investment Intelligence\n\s*<\/span>\n\s*\)\}/);
  });
});

describe('Liabilities grid: the FDH-10 statement fields are columns now (G7)', () => {
  it('minimum_payment, due_date and masked_identifier are editable fields', () => {
    const byName = Object.fromEntries(liabilityGridConfig.fields.map((f) => [f.name, f]));
    expect(byName.minimum_payment?.type).toBe('number');
    expect(byName.due_date?.type).toBe('date');
    expect(byName.masked_identifier?.type).toBe('text');
  });
});
