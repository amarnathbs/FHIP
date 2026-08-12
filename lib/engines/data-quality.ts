// Rule-based "unusual value" checks for the financial data grid. These are
// simple heuristic thresholds, not a machine-learning model — the goal is to
// catch obvious typos/mis-entries (an extra or missing zero, a swapped
// premium/cover pair), not to model real financial risk.
import type { GridCategory } from '@/lib/grid/types';

export interface GridRow {
  master_item_key?: string | null;
  is_custom: boolean;
  item_label: string;
  owner?: string;
  frequency?: string;
  [key: string]: unknown;
}

const LOW_MONTHLY_THRESHOLDS: Record<string, number> = {
  mortgage: 200,
  home_loan: 200,
  rent: 200,
  employment_salary: 500,
  business_income: 100,
};

function toMonthlyRough(amount: number, frequency: string | undefined): number {
  switch (frequency) {
    case 'weekly':
      return amount * (52 / 12);
    case 'fortnightly':
      return amount * (26 / 12);
    case 'quarterly':
      return amount / 3;
    case 'annually':
      return amount / 12;
    case 'one_off':
      return 0;
    default:
      return amount; // monthly or unknown
  }
}

export function validateRow(category: GridCategory, row: GridRow, valueField: string): string[] {
  const warnings: string[] = [];
  const value = Number(row[valueField] ?? 0);

  if (!row.owner) warnings.push('Missing owner');

  if (category === 'income' || category === 'expense') {
    if (!row.frequency) warnings.push('Missing frequency');
    else {
      const monthly = toMonthlyRough(value, row.frequency);
      const threshold = row.master_item_key ? LOW_MONTHLY_THRESHOLDS[row.master_item_key] : undefined;
      if (threshold && value > 0 && monthly < threshold) {
        warnings.push(`Unusually low for ${row.item_label} — check the amount and frequency`);
      }
    }
  }

  if (category === 'liability' && row.master_item_key === 'home_loan') {
    const repayment = Number(row.monthly_repayment ?? 0);
    if (repayment > 0 && repayment < 200) {
      warnings.push('Repayment looks unusually low for a home loan');
    }
  }

  if (category === 'insurance') {
    if (!row.premium_frequency) warnings.push('Missing frequency');
    const premium = Number(row.premium ?? 0);
    const cover = Number(row.cover_amount ?? 0);
    if (premium > 0 && cover > 0 && premium > cover) {
      warnings.push('Premium is larger than the cover amount');
    }
  }

  if (value < 0) warnings.push('Negative value');

  return warnings;
}

// Returns the set of (lowercased, trimmed) custom item names that collide —
// either with another custom row, or with a master-catalog item already
// offered in the same category — so the caller can block the save rather
// than just warn about it (a duplicate name is ambiguous in reports/exports,
// not merely unusual).
export function findDuplicateCustomNames(rows: GridRow[]): Set<string> {
  const masterLabels = new Set<string>();
  for (const r of rows) {
    if (r.is_custom) continue;
    const key = r.item_label.trim().toLowerCase();
    if (key) masterLabels.add(key);
  }
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.is_custom) continue;
    const key = r.item_label.trim().toLowerCase();
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [key, count] of seen) {
    if (count > 1 || masterLabels.has(key)) duplicates.add(key);
  }
  return duplicates;
}
