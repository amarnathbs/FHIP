/**
 * FDH-12 — the retirement statement adapter registry.
 *
 * A plain frozen array, exactly like
 * `lib/financial-data-hub/investment/adapters/registry.ts`. No decorator, no
 * DI, no runtime DB lookup: the set of layouts FDH-12 can read is a compile-
 * time fact that a reader can see in one place, and that
 * `tests/unit/fdh12AuSuperStatements.test.ts` asserts against the coverage
 * matrix in `docs/financial-data-hub/FDH12_AU_SUPER_STATEMENTS.md`.
 */

import {
  GENERIC_EPF_PASSBOOK_CSV,
  GENERIC_RETIREMENT_HOLDINGS_CSV,
  GENERIC_RETIREMENT_SUMMARY_CSV,
  GENERIC_RETIREMENT_TRANSACTION_CSV,
} from './genericCsv';
import type { RetirementCsvAdapter } from './types';

export const RETIREMENT_CSV_ADAPTER_REGISTRY: readonly RetirementCsvAdapter[] = [
  GENERIC_RETIREMENT_TRANSACTION_CSV,
  GENERIC_RETIREMENT_SUMMARY_CSV,
  GENERIC_RETIREMENT_HOLDINGS_CSV,
  GENERIC_EPF_PASSBOOK_CSV,
];

export function getRetirementAdapterById(id: string): RetirementCsvAdapter | null {
  return RETIREMENT_CSV_ADAPTER_REGISTRY.find((a) => a.id === id) ?? null;
}

/** How many layouts FDH-12 genuinely certifies. The UI renders this number
 * rather than a marketing claim (spec section 83). */
export function certifiedRetirementAdapterCount(): number {
  return RETIREMENT_CSV_ADAPTER_REGISTRY.filter((a) => a.coverageState === 'certified').length;
}
