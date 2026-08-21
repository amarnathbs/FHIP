import { describe, it, expect } from 'vitest';
import { activeItemKeys, findOrphanedRecords, resolveOrphanedLabel } from '@/lib/grid/rowMerge';

// Chunk 3b prerequisite fix: FinancialDataGrid.tsx's load() used to only
// render a saved row if its master_item_key matched a *currently active*
// master_financial_items row, or fell back to the custom-row path only
// when master_item_key IS NULL — a saved row whose key points at a
// deprecated item matched neither path and silently vanished from the
// grid. This is the same gap Chunk 1's migration 0031 explicitly withheld
// applying to DEV until it was fixed.
describe('activeItemKeys', () => {
  it('includes only items with is_active !== false', () => {
    const keys = activeItemKeys([
      { item_key: 'shares', item_label: 'Shares', is_active: true },
      { item_key: 'term_deposits', item_label: 'Term Deposits', is_active: false },
      { item_key: 'legacy_no_flag', item_label: 'Legacy' }, // undefined is_active degrades to active
    ]);
    expect(keys.has('shares')).toBe(true);
    expect(keys.has('term_deposits')).toBe(false);
    expect(keys.has('legacy_no_flag')).toBe(true);
  });
});

describe('findOrphanedRecords', () => {
  const activeMasterItems = [
    { item_key: 'shares', item_label: 'Shares', is_active: true },
    { item_key: 'term_deposits', item_label: 'Term Deposits', is_active: false }, // deprecated by this sub-chunk
  ];

  it('flags a saved row whose master_item_key points at a deprecated (now-inactive) item', () => {
    const savedRecords = [
      { id: 'r1', master_item_key: 'shares', current_value: 1000 },
      { id: 'r2', master_item_key: 'term_deposits', current_value: 5000 }, // the row that used to silently disappear
    ];
    const orphaned = findOrphanedRecords(savedRecords, activeMasterItems);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe('r2');
    // The row's own value is untouched by this classification.
    expect(orphaned[0].current_value).toBe(5000);
  });

  it('does not flag a custom row (master_item_key null)', () => {
    const savedRecords = [{ id: 'c1', master_item_key: null, asset_name: 'My custom thing' }];
    expect(findOrphanedRecords(savedRecords, activeMasterItems)).toHaveLength(0);
  });

  it('does not flag a row whose master_item_key still matches an active item', () => {
    const savedRecords = [{ id: 'r1', master_item_key: 'shares' }];
    expect(findOrphanedRecords(savedRecords, activeMasterItems)).toHaveLength(0);
  });

  it('a genuine regression case: an item deprecated AFTER the row was saved is still found, unmodified', () => {
    // Simulates the real-world sequence: row saved while 'commercial_property'
    // was active in the 'asset' category, then this sub-chunk's migration
    // deprecates it (Investments becomes canonical) — the row must still
    // surface, not disappear.
    const before = [{ item_key: 'commercial_property', item_label: 'Commercial Property', is_active: true }];
    const after = [{ item_key: 'commercial_property', item_label: 'Commercial Property', is_active: false }];
    const savedRecords = [{ id: 'r9', master_item_key: 'commercial_property', current_value: 750000, owner: 'self' }];
    expect(findOrphanedRecords(savedRecords, before)).toHaveLength(0); // visible via the normal active path pre-deprecation
    const orphanedAfter = findOrphanedRecords(savedRecords, after);
    expect(orphanedAfter).toHaveLength(1);
    expect(orphanedAfter[0].current_value).toBe(750000); // value intact
    expect(orphanedAfter[0].owner).toBe('self');
  });
});

describe('resolveOrphanedLabel', () => {
  it('uses the deprecated catalogue item’s own item_label when the catalogue row still exists', () => {
    const fullCatalog = new Map([['term_deposits', { item_key: 'term_deposits', item_label: 'Term Deposits', is_active: false }]]);
    const record = { master_item_key: 'term_deposits', asset_name: 'Whatever the user typed once' };
    expect(resolveOrphanedLabel(record, fullCatalog, 'asset_name')).toBe('Term Deposits');
  });

  it('falls back to the saved record’s own name field when the catalogue row is gone entirely', () => {
    const fullCatalog = new Map<string, { item_key: string; item_label: string; is_active?: boolean }>();
    const record = { master_item_key: 'deleted_key', asset_name: 'My Old Term Deposit' };
    expect(resolveOrphanedLabel(record, fullCatalog, 'asset_name')).toBe('My Old Term Deposit');
  });

  it('falls back to the raw master_item_key as a last resort when neither is available', () => {
    const fullCatalog = new Map<string, { item_key: string; item_label: string; is_active?: boolean }>();
    const record = { master_item_key: 'mystery_key', asset_name: '' };
    expect(resolveOrphanedLabel(record, fullCatalog, 'asset_name')).toBe('mystery_key');
  });
});
