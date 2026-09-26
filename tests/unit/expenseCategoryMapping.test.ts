/**
 * WP-15 -- the FDH taxonomy (fhip_mapping_key, seeded 0053) -> expense_items
 * master_item_key mapping table.
 *
 * THE DOUBLE-COUNT INVARIANT: planned and actual are compared per canonical
 * group and never added (PO D-02), so a mapping that crossed groups would
 * count the same spending twice on the combined basis. Every mapped row must
 * land in the same group on both sides. The anti-vacuity case proves this
 * check is not vacuous by feeding it one cross-group row.
 *
 * NEGATIVE CONTROL: on the base branch (f79374f) no mapping exists at all
 * (lib/import-bridge/expenseCategoryMapping.ts is absent: "wiring into
 * expense_items is FDH-15's job" was never built), so this file fails at import.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { expenseItemForMappingKey, FDH_MAPPING_KEY_TO_EXPENSE_ITEM, mappingGroupPairs } from '@/lib/import-bridge/expenseCategoryMapping';
import { groupForExpenseItem, groupForFdhCategory, KNOWN_EXPENSE_MASTER_ITEM_KEYS } from '@/lib/read-models/core/categoryGroups';

const ROOT = path.resolve(__dirname, '../..');

async function taxonomy() {
  const subs = (await import(path.join(ROOT, 'data', 'financial-data-hub', 'subcategories.mjs'))).subcategories as { category_key: string; fhip_mapping_key: string }[];
  const cats = (await import(path.join(ROOT, 'data', 'financial-data-hub', 'categories.mjs'))).categories as { category_key: string; economic_type: string }[];
  return { subs, cats };
}

/** Active 'expense' catalogue keys: seed_master_items.sql + 0101 additions, minus 0164 deactivations. */
function activeExpenseCatalogue(): Set<string> {
  const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed_master_items.sql'), 'utf8');
  const keys = new Set([...seed.matchAll(/\('expense',\s*'([a-z_]+)'/g)].map((m) => m[1]));
  const m0101 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '0101_app_review_tier2_expense_catalogue_education_land_tax.sql'), 'utf8');
  for (const m of m0101.matchAll(/\('expense',\s*'([a-z_]+)'/g)) keys.add(m[1]);
  for (const removed of ['mortgage', 'car_loan_repayments']) keys.delete(removed); // 0164
  return keys;
}

function crossGroupRows(table: Record<string, string | null>) {
  return Object.entries(table)
    .filter((e): e is [string, string] => e[1] !== null)
    .filter(([k, v]) => groupForFdhCategory({ subcategoryMappingKey: k }).group !== groupForExpenseItem(v).group);
}

describe('FDH taxonomy -> planned item mapping', () => {
  it('every mapped row lands in the SAME canonical group on both sides (no combined-basis double count)', () => {
    const pairs = mappingGroupPairs();
    expect(pairs.length).toBeGreaterThanOrEqual(40);
    expect(pairs.filter((p) => p.fdhGroup !== p.plannedGroup)).toEqual([]);
    expect(crossGroupRows({ ...FDH_MAPPING_KEY_TO_EXPENSE_ITEM })).toEqual([]);
  });

  it('anti-vacuity: the check catches a cross-group row (Other Housing -> "Other Household Expenses")', () => {
    const bad = { ...FDH_MAPPING_KEY_TO_EXPENSE_ITEM, 'housing.other_housing': 'other_household_expenses' };
    expect(crossGroupRows(bad).map(([k]) => k)).toEqual(['housing.other_housing']);
  });

  it('covers EVERY spending subcategory in the 0053 taxonomy (expense / fee / tax families), each explicitly mapped or explicitly null', async () => {
    const { subs, cats } = await taxonomy();
    const spendingCats = new Set(cats.filter((c) => ['expense', 'fee', 'tax'].includes(c.economic_type)).map((c) => c.category_key));
    const spendingKeys = subs.filter((s) => spendingCats.has(s.category_key)).map((s) => s.fhip_mapping_key).sort();
    expect(spendingKeys.length).toBeGreaterThanOrEqual(75);
    expect(Object.keys(FDH_MAPPING_KEY_TO_EXPENSE_ITEM).sort()).toEqual(spendingKeys);
  });

  it('every target is a real, ACTIVE expense catalogue item the Expense read model knows', () => {
    const catalogue = activeExpenseCatalogue();
    for (const target of new Set(Object.values(FDH_MAPPING_KEY_TO_EXPENSE_ITEM).filter((v): v is string => v !== null))) {
      expect(catalogue.has(target), `${target} in the active catalogue`).toBe(true);
      expect(KNOWN_EXPENSE_MASTER_ITEM_KEYS).toContain(target);
    }
  });

  it('never maps into debt service (mortgage / car loan repayments / loan interest are liabilities, not planned living costs)', () => {
    const targets = new Set(Object.values(FDH_MAPPING_KEY_TO_EXPENSE_ITEM));
    for (const debt of ['mortgage', 'car_loan_repayments', 'loan_interest']) expect(targets.has(debt)).toBe(false);
  });

  it('lookup: subcategory keys map; category-only, non-spending and unknown keys are explained, never guessed', () => {
    expect(expenseItemForMappingKey('food.groceries')).toEqual({ masterItemKey: 'groceries' });
    expect(expenseItemForMappingKey('health.health_insurance_gap_excess')).toEqual({ masterItemKey: 'medical' });
    expect(expenseItemForMappingKey('transport.parking_tolls')).toEqual({ masterItemKey: null, reason: 'no_single_planned_item' });
    expect(expenseItemForMappingKey('expense.food')).toEqual({ masterItemKey: null, reason: 'category_only' });
    expect(expenseItemForMappingKey('debt.interest')).toEqual({ masterItemKey: null, reason: 'category_only' });
    expect(expenseItemForMappingKey('made.up')).toEqual({ masterItemKey: null, reason: 'unknown_key' });
    expect(expenseItemForMappingKey(null)).toEqual({ masterItemKey: null, reason: 'unknown_key' });
    expect(expenseItemForMappingKey('constructor')).toEqual({ masterItemKey: null, reason: 'unknown_key' });
  });
});
