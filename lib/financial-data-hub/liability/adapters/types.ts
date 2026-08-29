/**
 * FDH-10 — Credit Cards & Loans Intelligence: statement adapter contract
 * (spec section 28).
 *
 * Deliberately mirrors R7's `BankCsvAdapter` contract
 * (`lib/financial-data-hub/bank-csv/adapters/types.ts`) — same signature
 * shape, same `scoreHeaderAgainstSignature` scoring function (imported, not
 * duplicated: both live inside `lib/financial-data-hub/`, so reusing it is
 * ordinary intra-Hub reuse, not a cross-boundary import
 * `tests/unit/fdh1Isolation.test.ts` would flag). The conceptual detect /
 * identifyInstitution / identifyFacility / extract* / validate / normalize
 * pipeline the spec describes maps onto this contract as: `signature` +
 * `scoreHeader` = detectStatement/identifyInstitution/identifyFacility (the
 * header alone identifies institution AND facility for every adapter below —
 * a card CSV and a loan CSV never share a header shape); `columnMap` +
 * `extractLiabilityStatementFromCsv` = extractStatementMetadata/
 * extractBalances/extractTransactions/extractInterest/extractFees/
 * extractPayments/extractPrincipal (the generic CSV engine, column-mapped per
 * adapter); `LiabilityExtractionResult.warnings` + the caller's own
 * reconciliation/decomposition modules = validate; `activityTypeAliases` =
 * normalize.
 *
 * SCOPE (honestly disclosed, spec sections 29-32). Each adapter below is one
 * REPRESENTATIVE, structurally-plausible pattern per statement-type/country
 * combination — inferred from publicly documented CSV-export column
 * conventions the way R7's own AU/IN bank adapters were, not a certification
 * of any single named issuer's actual current export format. No real
 * customer statement data appears anywhere in this module or its
 * certification test (`tests/unit/fdh10LiabilityAdapters.test.ts`) — every
 * fixture is synthetic, inline CSV text constructed for this round.
 */

import type { LiabilityCsvColumnMap } from '../csvExtraction';
import type { LiabilityFacilityType, LiabilityStatementCountry, LiabilityStatementType } from '../types';
import { scoreHeaderAgainstSignature, type AdapterSignature } from '../../bank-csv/adapters/types';

export type { AdapterSignature };
export { scoreHeaderAgainstSignature };

export type LiabilityAdapterCertificationState = 'certified' | 'experimental';

export interface LiabilityCsvAdapter {
  /** Stable identifier. */
  id: string;
  country: LiabilityStatementCountry;
  statementType: LiabilityStatementType;
  facilityType: LiabilityFacilityType;
  version: string;
  certificationState: LiabilityAdapterCertificationState;
  displayName: string;
  signature: AdapterSignature;
  columnMap: LiabilityCsvColumnMap;
  /** Fixed metadata this adapter's format always states out-of-band (e.g. a
   * loan CSV export whose institution name is not itself a CSV column) —
   * merged with anything the caller already knows (e.g. the user's declared
   * currency) at extraction time. Deliberately sparse: only what a REAL
   * export of this shape would not otherwise carry as a column. */
  fixedMetadata?: {
    institutionName?: string;
  };
  /** Scores how well a header row matches this adapter, in [0, 1]. Pure
   * function — identical discipline to `BankCsvAdapter.scoreHeader`. */
  scoreHeader(header: readonly string[]): number;
}
