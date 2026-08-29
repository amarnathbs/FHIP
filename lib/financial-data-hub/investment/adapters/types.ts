/**
 * FDH-11 — Australia investment statement adapter contract (spec sections
 * 15-16). Mirrors `lib/financial-data-hub/bank-csv/adapters/types.ts`'s
 * `BankCsvAdapter` contract exactly (reusing `AdapterSignature`/
 * `scoreHeaderAgainstSignature` directly — ordinary intra-Hub reuse, same
 * technique FDH-10's `liability/adapters/types.ts` already established).
 */

import { scoreHeaderAgainstSignature, type AdapterSignature } from '../../bank-csv/adapters/types';
import type { AuBrokerCoverageState, AuInvestmentStatementType } from '../types';

export type { AdapterSignature };
export { scoreHeaderAgainstSignature };

export type AuInvestmentCsvKind = 'transaction' | 'portfolio';

export interface AuInvestmentCsvAdapter {
  /** Stable identifier, mirrors `fdh_parser_registry.parser_key`. */
  id: string;
  /** null for a country-neutral/broker-neutral generic adapter. */
  institutionCode: string | null;
  version: string;
  /** Spec section 16 coverage classification — this module is honest about
   * which of these it actually is, never claims CERTIFIED for a layout it
   * has not verified against real sample data. */
  coverageState: AuBrokerCoverageState;
  displayName: string;
  statementType: AuInvestmentStatementType;
  csvKind: AuInvestmentCsvKind;
  signature: AdapterSignature;
  scoreHeader(header: readonly string[]): number;
}
