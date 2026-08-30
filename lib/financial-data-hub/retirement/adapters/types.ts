/**
 * FDH-12 — retirement statement adapter contract (spec sections 82-86).
 *
 * A pure, side-effect-free description of one retirement statement layout plus
 * the logic to recognise it. Adapters never touch the database and never do
 * I/O — `../detection.ts` and `../extraction.ts` drive them.
 *
 * COVERAGE HONESTY (spec section 83) is a property of the adapter, not of the
 * marketing copy: `coverageState` is what the UI renders, and only a layout
 * with a real fixture exercised by `tests/unit/fdh12AuSuperStatements.test.ts`
 * may carry `'certified'`.
 */

import type { AdapterSignature } from '../../bank-csv/adapters/types';
import type {
  RetirementAccountType,
  RetirementCoverageState,
  RetirementJurisdiction,
  RetirementStatementType,
} from '../types';

/** What shape of retirement data this adapter reads. */
export type RetirementCsvKind =
  /** Dated activity lines: contributions, fees, earnings, rollovers. */
  | 'transaction'
  /** A member/annual statement summary: opening/closing balance + period
   * movement totals. */
  | 'summary'
  /** Investment options held inside the fund. */
  | 'holdings';

export interface RetirementCsvAdapter {
  /** Stable identifier; mirrors `fdh_parser_registry.parser_key` convention. */
  id: string;
  /** null for a fund-neutral generic adapter. Set only when a named fund's
   * own layout has been certified against a real fixture. */
  institutionCode: string | null;
  jurisdiction: RetirementJurisdiction;
  version: string;
  coverageState: RetirementCoverageState;
  displayName: string;
  statementType: RetirementStatementType;
  accountType: RetirementAccountType;
  csvKind: RetirementCsvKind;
  signature: AdapterSignature;
  /** Column-role map: canonical role -> this layout's exact header name. */
  columnRoles: Record<string, string>;
  /** Scores how well a header row matches, in [0, 1]. Pure. */
  scoreHeader(header: readonly string[]): number;
}
