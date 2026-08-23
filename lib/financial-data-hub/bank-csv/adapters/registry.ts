/**
 * R7 — Bank CSV Engine: the adapter registry (spec section 19).
 *
 * Each entry here has a mirror row in `fdh_parser_registry`/
 * `fdh_parser_versions` (seeded by migration 0064) that is the GOVERNANCE
 * record — this file is the actual behaviour. `parser_id`/`parser_version_id`
 * stored on `fdh_statement_uploads`/`fdh_transactions` point at those DB
 * rows; `adapterKeyToParserKey` below is the join key between the two.
 */

import { AU_ADAPTERS } from './auAdapters';
import { IN_ADAPTERS } from './inAdapters';
import { GENERIC_ADAPTERS } from './genericAdapters';
import type { BankCsvAdapter } from './types';

export const BANK_CSV_ADAPTER_REGISTRY: readonly BankCsvAdapter[] = [
  ...AU_ADAPTERS,
  ...IN_ADAPTERS,
  ...GENERIC_ADAPTERS,
];

export function getAdapterById(id: string): BankCsvAdapter | null {
  return BANK_CSV_ADAPTER_REGISTRY.find((a) => a.id === id) ?? null;
}

export function certifiedAdapterCount(): number {
  return BANK_CSV_ADAPTER_REGISTRY.filter((a) => a.certificationState === 'certified').length;
}

export {
  AU_CBA_DEBIT_CREDIT_V1,
  AU_WESTPAC_SINGLE_SIGNED_V1,
  AU_NAB_DEBIT_CREDIT_V1,
} from './auAdapters';
export { IN_SBI_DR_CR_V1, IN_HDFC_DEBIT_CREDIT_V1, IN_ICICI_DR_CR_V1 } from './inAdapters';
export { GENERIC_SINGLE_SIGNED_V1, GENERIC_DEBIT_CREDIT_V1 } from './genericAdapters';
export type { BankCsvAdapter } from './types';
