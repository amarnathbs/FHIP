/**
 * Canonical-cert UI journey (live on DEV, 2026-09-27): after "Add to Net Worth" published two AU broker
 * holdings (BHP $10,000 and an ETF $2,500, both master_item_key 'australian_shares'), the Investments
 * tab showed ONE imported row and a total of $19,000, while the Dashboard counted $21,500. The grid's
 * merge kept one saved record per master_item_key (a Map), so the second holding silently vanished --
 * against the brief ("imported holdings visible in Investments UI") and the grid's own rule "no record
 * may disappear merely to tidy taxonomy".
 *
 * [NC] tests fail on the code before the fix: mergeSavedRows did not exist (the merge was inline), and
 * the inline Map dropped the record -- 2 rows instead of 3.
 */
import { describe, expect, it } from 'vitest';
import { mergeSavedRows } from '@/components/grid/FinancialDataGrid';
import { investmentGridConfig } from '@/lib/grid/configs';

const master = [
  { item_key: 'australian_shares', item_label: 'Australian Shares', sort_order: 1 },
  { item_key: 'etfs', item_label: 'ETFs', sort_order: 2 },
];
const rec = (id: string, key: string | null, name: string, value: number, extra: Record<string, unknown> = {}) => ({
  id, master_item_key: key, currency_code: 'AUD', owner: 'self', investment_name: name, current_value: value, ...extra,
});

describe('grid rows: every active saved record is exactly one row', () => {
  it('[NC] two published holdings under one master_item_key are two rows, each under its own name', () => {
    const rows = mergeSavedRows(master, [
      rec('bhp', 'australian_shares', 'BHP Group Ltd', 10000, { source_type: 'investment_intelligence_published' }),
      rec('etf', 'australian_shares', 'FHIP Test Diversified ETF', 2500, { source_type: 'investment_intelligence_published' }),
      rec('man', 'etfs', 'ETFs', 9000),
    ], investmentGridConfig, 'AUD');
    const saved = rows.filter((r) => r.id);
    expect(saved.map((r) => r.id).sort()).toEqual(['bhp', 'etf', 'man']);
    expect(saved.reduce((s, r) => s + Number(r.current_value), 0)).toBe(21500); // = the Dashboard's investments total
    const extra = rows.find((r) => r.id === 'etf')!;
    expect(extra.item_label).toBe('FHIP Test Diversified ETF');
    // React keys are unique; the extra row is edited by id, never upserted over its sibling.
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(extra.key).not.toBe(extra.master_item_key);
  });

  it('control: one record per key renders exactly as before (catalogue label, key = master_item_key)', () => {
    const rows = mergeSavedRows(master, [rec('man', 'etfs', 'ETFs', 9000)], investmentGridConfig, 'AUD');
    expect(rows).toHaveLength(2);
    const etf = rows.find((r) => r.master_item_key === 'etfs')!;
    expect(etf).toMatchObject({ id: 'man', key: 'etfs', item_label: 'ETFs', included: true });
    expect(rows.find((r) => r.master_item_key === 'australian_shares')).toMatchObject({ id: null, included: false });
  });

  it('orphaned keys and custom rows are still listed (the existing safety net)', () => {
    const rows = mergeSavedRows(master, [rec('old', 'deprecated_key', 'Old thing', 5), rec('c1', null, 'My custom', 7)], investmentGridConfig, 'AUD');
    expect(rows.filter((r) => r.id).map((r) => r.id).sort()).toEqual(['c1', 'old']);
  });
});
