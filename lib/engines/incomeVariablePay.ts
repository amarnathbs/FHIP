/**
 * Bonus, Commission and Overtime as their OWN income sources (PO request 16-10-2026).
 *
 * The three already exist in the master income catalogue (supabase/seed_master_items.sql: 'bonus', 'commission',
 * 'overtime', active, no country restriction, so AU and India households both get them). This module is the single
 * place that says how they behave, so the grid, the payslip bridge and the Income read model cannot drift apart:
 *
 *  1. DEFAULTS for a NEW row created from the catalogue: a Bonus is paid once a year, so its frequency starts at
 *     'annually'. It is taxable like salary (the grid's `is_taxable` default already is true), so with no take-home
 *     and no tax entered the gross-as-take-home fallback applies and names it (lib/engines/incomeNetBasis.ts).
 *  2. NO DOUBLE COUNT with payslips. A payslip's bonus / overtime / commission is already carried as dated one-off
 *     pay by the Income read model (PO D-06) and is deliberately left out of the payslip's recurring salary row
 *     (lib/import-bridge/adapters/incomeAdapter.ts). When the household ALSO records that same kind of pay as its own
 *     income source, the recorded source is the household's statement of it, so the payslip's component of the same
 *     kind and the same owner is not added again (lib/read-models/income.ts) and the Income page says so.
 *  3. A payslip is never matched TO one of these sources: a Bonus row carrying the employer's name must not be
 *     overwritten by a fortnightly salary (findDuplicateIncome).
 *
 * Pure: no I/O, no environment.
 */
import type { Frequency } from '@/lib/engines/money';

export type VariablePayKind = 'bonus' | 'overtime' | 'commission';

/** Payslip variable-pay column (fdh_payroll_events) -> the catalogue item that records the same kind of pay. */
export const VARIABLE_PAY_COLUMN_TO_ITEM_KEY: Readonly<Record<'bonus_pay' | 'overtime_pay' | 'commission_pay', VariablePayKind>> = {
  bonus_pay: 'bonus',
  overtime_pay: 'overtime',
  commission_pay: 'commission',
};

export const VARIABLE_PAY_ITEM_KEYS: ReadonlySet<string> = new Set<string>(['bonus', 'overtime', 'commission']);

export function isVariablePayItemKey(masterItemKey: string | null | undefined): masterItemKey is VariablePayKind {
  return masterItemKey != null && VARIABLE_PAY_ITEM_KEYS.has(masterItemKey);
}

/** Plain-language name of a variable-pay kind, for notices. */
export const VARIABLE_PAY_LABELS: Readonly<Record<VariablePayKind, string>> = {
  bonus: 'bonus',
  overtime: 'overtime',
  commission: 'commission',
};

const DEFAULT_FREQUENCY_BY_ITEM_KEY: Readonly<Record<string, Frequency>> = {
  bonus: 'annually',
};

/** Field defaults for a NEW Income row created from a catalogue item. Never applied to a saved row. */
export function incomeDefaultsForMasterItem(masterItemKey: string): Record<string, unknown> {
  const frequency = DEFAULT_FREQUENCY_BY_ITEM_KEY[masterItemKey];
  return frequency ? { frequency } : {};
}

/** One short line shown under the item name in the Add / Edit form. */
export function incomeItemHint(masterItemKey: string | null | undefined): string | undefined {
  if (masterItemKey === 'bonus') {
    return 'Record your yearly bonus here, separately from your salary, so your salary can be entered per pay period. A bonus that also appears on an imported payslip is counted once.';
  }
  return undefined;
}
