/**
 * Canonical-cert UI journey (live on DEV, 2026-09-27): Assets -> "Add your bank balance to Assets" ->
 * Add to Assets. Net Worth then included the $27,895 cash asset (162,288.75), but the Dashboard's "About
 * these figures" panel still said "Bank balance per statement — not in Net Worth: $27,895." The assets
 * read model's evidence total summed EVERY account's balance, including ones already added
 * (inNetWorthAs set), and the Dashboard / report disclosures used that total and the account count.
 *
 * [NC] fails on the code before the fix: total 6000 (expected 0) and no notInNetWorthCount.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeAssets } from '@/lib/read-models/assets';
import { fxContext } from '@/lib/read-models/core/currency';

const fx = fxContext('AUD', 56, 'AU');
const common = {
  bankAccounts: [
    { id: 'bank', account_type: 'transaction', display_name: 'Everyday', currency_code: 'AUD' },
    { id: 'bank2', account_type: 'savings', display_name: 'Saver', currency_code: 'AUD' },
  ],
  statements: [
    { id: 's-aug', financial_account_id: 'bank', statement_period_end: '2026-08-31', approved_at: null },
    { id: 's2-aug', financial_account_id: 'bank2', statement_period_end: '2026-08-31', approved_at: null },
  ],
  reconciliations: [
    { statement_upload_id: 's-aug', reported_closing_balance: 6000, currency_code: 'AUD', created_at: null },
    { statement_upload_id: 's2-aug', reported_closing_balance: 1500, currency_code: 'AUD', created_at: null },
  ],
  fx,
};
const addedEveryday = { id: 'a1', asset_name: 'Everyday', asset_class: 'cash', current_value: 6000, currency_code: 'AUD', owner: 'self', master_item_key: null, source_type: 'bank_statement_import', linked_liability_id: null, source_financial_account_id: 'bank' };

describe('"Bank balance per statement — not in Net Worth" counts only balances NOT in Net Worth', () => {
  it('control: nothing added yet -> both balances are disclosed (7,500, 2 accounts)', () => {
    const a = computeAssets({ ...common, assets: [] });
    expect(a.bankBalanceEvidence.total).toBe(7500);
    expect(a.bankBalanceEvidence.notInNetWorthCount).toBe(2);
  });

  it('[NC] after one balance is added as a cash asset only the other is disclosed (1,500, 1 account); the list still shows both', () => {
    const a = computeAssets({ ...common, assets: [addedEveryday] });
    expect(a.total).toBe(6000); // in Net Worth once, through the asset
    expect(a.bankBalanceEvidence.total).toBe(1500);
    expect(a.bankBalanceEvidence.notInNetWorthCount).toBe(1);
    expect(a.bankBalanceEvidence.accounts).toHaveLength(2); // the Assets proposal list still needs both
  });

  it('[NC] the Dashboard, report snapshot and report appendix disclose the not-in-Net-Worth count, not every account', () => {
    // Stage-3 consolidation: the three consumers go through the ONE helper (econ D3 == SUI-6 == GP-D5),
    // and the helper reads the model's notInNetWorthCount / open-only total.
    for (const f of ['lib/services/dashboardCanonicalAdapter.ts', 'lib/services/reportSnapshotResolver.ts', 'lib/engines/reportCanonicalAppendix.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
      expect(src, f).toContain('bankBalancesNotInNetWorth(');
      expect(src, f).not.toMatch(/bankBalanceEvidence\.accounts\.length/);
    }
    const helper = fs.readFileSync(path.join(process.cwd(), 'lib/read-models/bankBalanceDisclosure.ts'), 'utf8');
    expect(helper).toMatch(/evidence\.notInNetWorthCount === 0/);
    expect(helper).not.toMatch(/accounts\.length/);
  });

  it('[NC] behaviour through the helper: after one balance is added only the other is disclosed; all added -> no disclosure', async () => {
    const { bankBalancesNotInNetWorth } = await import('@/lib/read-models/bankBalanceDisclosure');
    expect(bankBalancesNotInNetWorth(computeAssets({ ...common, assets: [] }).bankBalanceEvidence)).toMatchObject({ count: 2, total: 7500 });
    expect(bankBalancesNotInNetWorth(computeAssets({ ...common, assets: [addedEveryday] }).bankBalanceEvidence)).toMatchObject({ count: 1, total: 1500 });
    const addedSaver = { ...addedEveryday, id: 'a2', asset_name: 'Saver', current_value: 1500, source_financial_account_id: 'bank2' };
    expect(bankBalancesNotInNetWorth(computeAssets({ ...common, assets: [addedEveryday, addedSaver] }).bankBalanceEvidence)).toBeNull();
  });
});
