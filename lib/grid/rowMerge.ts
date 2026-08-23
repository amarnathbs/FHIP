// Chunk 3b prerequisite fix (the FinancialDataGrid.tsx orphaned-
// master_item_key gap flagged by Chunk 1's migration 0066 disclosure and
// AR-0's discovery doc): a saved row's master_item_key can point at a
// catalogue item that has since been deprecated (is_active = false).
// FinancialDataGrid.tsx's load() previously only rendered a saved row if
// its master_item_key matched a *currently active* master_financial_items
// row, or fell back to the custom-row path only when master_item_key IS
// NULL — a row whose key points at a deprecated item matched neither path
// and silently vanished from the grid (the DB row and its value were
// completely untouched; only the UI stopped showing it).
//
// Pure and framework-free (mirrors lib/grid/fieldVisibility.ts's own
// precedent for extracting grid row-shaping logic into directly
// unit-testable functions, since this repo's vitest config only runs
// tests/unit/**/*.test.ts under a node environment — no DOM/React
// component-rendering harness exists here).
export interface MinimalMasterItem {
  item_key: string;
  item_label: string;
  is_active?: boolean;
}

export interface MinimalSavedRecord {
  master_item_key: string | null;
  [key: string]: unknown;
}

/** The set of item_keys that are genuinely active today — undefined is_active degrades to "treat as active", matching every other optional-metadata field's fallback behaviour on this interface. */
export function activeItemKeys(masterItems: MinimalMasterItem[]): Set<string> {
  return new Set(masterItems.filter((item) => item.is_active !== false).map((item) => item.item_key));
}

/** Saved records with a real master_item_key that no longer matches any currently-active catalogue item — the rows that used to silently disappear. */
export function findOrphanedRecords<T extends MinimalSavedRecord>(savedRecords: T[], activeMasterItems: MinimalMasterItem[]): T[] {
  const activeKeys = activeItemKeys(activeMasterItems);
  return savedRecords.filter((r): r is T => Boolean(r.master_item_key) && !activeKeys.has(r.master_item_key as string));
}

/**
 * Best-available display label for an orphaned row: the deprecated
 * catalogue item's own item_label if that row still exists (deprecated
 * items are never deleted, only is_active=false'd — see migration 0066's
 * own discipline), otherwise the saved record's own name field (covers the
 * theoretical case where the catalogue row itself is gone entirely), and
 * finally the raw master_item_key as a last resort so the row is never
 * rendered with an empty name.
 */
export function resolveOrphanedLabel(
  record: MinimalSavedRecord,
  fullCatalogByKey: Map<string, MinimalMasterItem>,
  nameField: string
): string {
  const catalogItem = record.master_item_key ? fullCatalogByKey.get(record.master_item_key) : undefined;
  if (catalogItem) return catalogItem.item_label;
  const ownName = record[nameField];
  if (typeof ownName === 'string' && ownName.trim()) return ownName;
  return record.master_item_key ?? '';
}
