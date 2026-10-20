// DOCUMENT2 (4) review, WP-C: entity data is structurally separate from the personal registers. Entity liabilities, income and expenses live in their own
// tables, and no PERSONAL engine, read model or personal loader reads them, so they can never reach personal Net Worth, Income, Expenses, DTI or DSR
// (the exclusion is structural, a table the personal formulas never query, not a runtime filter). EVIDENCE LABEL: UNIT-TESTED (source walk) plus the
// behavioural oracle below. The database side (RLS, two-user) is PGLITE-VERIFIED in wpCEntityFinancePglite.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSmsfBalanceSheet } from '@/lib/engines/entityBalanceSheet';
import { computeNetWorthLevels } from '@/lib/engines/netWorthLevels';

const ROOT = path.resolve(__dirname, '..', '..');
const ENTITY_TABLES = ['smsf_liabilities', 'entity_income_items', 'entity_expense_items', 'business_entity_liabilities', 'business_entity_assets', 'entity_change_log'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

// The only places that may name an entity table: the entity data layers, the SMSF and entity report loaders, the entity net-worth loaders, and the
// entity routes and components. NOT the dashboard engine, not the personal read models, not the DTI / DSR / debt-service engines.
const PERSONAL_SIDE = [...walk('lib/engines').filter((f) => !/\/(entity|smsf|businessEntity|netWorthLevels|netWorthStatement)/.test(f)), ...walk('lib/read-models')];

describe('no personal engine or read model names an entity table', () => {
  it.each(ENTITY_TABLES)('%s is not referenced by any personal engine or read model', (table) => {
    const offenders = PERSONAL_SIDE.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes(table));
    expect(offenders).toEqual([]);
  });

  it('the personal Dashboard loader reads personal liabilities only from the liabilities register', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/services/dashboardData.ts'), 'utf8');
    expect(src).not.toContain('smsf_liabilities');
    expect(src).not.toContain('business_entity_liabilities');
    expect(src).not.toContain('entity_income_items');
    expect(src).not.toContain('entity_expense_items');
  });

  it('the new entity routes and loaders never write to a personal register', () => {
    for (const f of ['lib/services/entityCashFlowData.ts', 'lib/services/entityCashFlowRoutes.ts']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // the only personal tables named are READ for the legacy list and reached through the preview-first move function
      expect(src).not.toMatch(/from\('(income_sources|expense_items|liabilities)'\)\s*\.(insert|update|delete|upsert)/);
    }
  });
});

describe('behaviour: an SMSF liability is in the fund net and in no personal figure or personal debt ratio', () => {
  const sheet = buildSmsfBalanceSheet({
    fund: { id: 'f', name: 'PO SMSF', mode: 'detailed', currency: 'AUD', retirementAccountId: 'ra', typedNetReporting: null, typedNetPresent: false },
    reportingCurrency: 'AUD',
    holdings: [{ id: 'h', name: 'Property', holdingType: 'residential_property', value: 503_000, currency: 'AUD', valueReporting: 503_000 }],
    liabilities: [{ id: 'l', name: 'Loan', type: 'property_loan', lender: null, balance: 370_000, currency: 'AUD', balanceReporting: 370_000 }],
    linkedLoans: [],
  });
  const personal = [
    { id: 'home', register: 'assets', name: 'Home', owner: 'self', amountReporting: 900_000, currencyCode: 'AUD' },
    { id: 'loan', register: 'liabilities', name: 'Home loan', owner: 'self', amountReporting: 600_000, currencyCode: 'AUD' },
  ] as const;

  it('the fund liability of 370,000 is inside the SMSF net (133,000) and the personal level is 300,000 with and without it', () => {
    const without = computeNetWorthLevels({ currency: 'AUD', rows: [...personal] });
    const withFund = computeNetWorthLevels({ currency: 'AUD', rows: [...personal], entitySheets: [sheet] });
    expect(withFund.personal.total.liabilities).toBe(600_000);
    expect(withFund.personal.total.net).toBe(300_000);
    expect(withFund.personal.total).toEqual(without.personal.total);
    expect(withFund.entities.blocks[0]!.entityTotals.liabilities).toBe(370_000);
    expect(withFund.entities.blocks[0]!.included.net).toBe(133_000);
    expect(withFund.family.net).toBe(433_000);
  });

  it('the same loan entered the EARLIER way (a personal liability tagged SMSF) reaches the SMSF only through the owner tag, a fragile path, which is why the personal Liabilities page now refuses it', () => {
    const tagged = computeNetWorthLevels({ currency: 'AUD', rows: [...personal, { id: 'old', register: 'liabilities', name: 'SMSF loan', owner: 'smsf', amountReporting: 370_000, currencyCode: 'AUD' }] });
    expect(tagged.personal.total.liabilities).toBe(600_000);
    expect(tagged.entities.blocks[0]!.entityTotals.liabilities).toBe(370_000);
  });
});
