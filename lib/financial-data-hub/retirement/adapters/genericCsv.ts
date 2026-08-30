/**
 * FDH-12 — the CERTIFIED generic retirement statement CSV layouts (spec
 * sections 82-85).
 *
 * ============================================================================
 * WHAT "CERTIFIED" MEANS HERE, AND WHAT IT DOES NOT
 * ============================================================================
 *
 * These adapters are FUND-NEUTRAL (`institutionCode: null`). They are a
 * documented, explicit column-name contract — NOT a claim to recognise any
 * specific Australian super fund's actual export.
 *
 * Spec section 82 lists AustralianSuper, Australian Retirement Trust,
 * Hostplus, Aware Super, UniSuper, REST, HESTA, CBUS, Colonial First State,
 * AMP, Mercer and others as CANDIDATE layouts to research. FDH-12 Release 1
 * ships NO named-fund adapter, because certifying one requires a real fixture
 * of that fund's real export, which this phase did not have. Spec section 83
 * requires the UI state the actual certified scope, and it does:
 * `docs/financial-data-hub/FDH12_AU_SUPER_STATEMENTS.md` carries the honest
 * per-fund coverage matrix, and every named fund in it is
 * MANUAL_MAPPING_REQUIRED, not "supported".
 *
 * A statement whose header does not score above DETECTION_MIN_CONFIDENCE
 * against one of these contracts resolves to MANUAL_MAPPING_REQUIRED, never to
 * a confident wrong extraction (spec section 85).
 */

import { scoreHeaderAgainstSignature } from '../../bank-csv/adapters/types';
import type { RetirementCsvAdapter } from './types';

/**
 * Dated activity lines — the layout a "transaction statement" or
 * "contribution history" export takes.
 *
 * `Description` is REQUIRED, not optional, and that is deliberate: activity
 * classification (employer contribution vs fee vs rollover) is read from the
 * description text. A layout without one cannot be classified, and a parser
 * that guessed would be exactly the "confidently extract wrong retirement
 * values" spec section 85 forbids.
 */
export const GENERIC_RETIREMENT_TRANSACTION_CSV: RetirementCsvAdapter = {
  id: 'fdh12_generic_retirement_transaction_csv_v1',
  institutionCode: null,
  jurisdiction: 'AU',
  version: '1.0.0',
  coverageState: 'certified',
  displayName: 'Generic retirement transaction CSV',
  statementType: 'super_transaction_statement',
  accountType: 'unknown',
  csvKind: 'transaction',
  signature: {
    requiredHeaders: ['Date', 'Description', 'Amount'],
    optionalHeaders: ['Type', 'Employer', 'Period Start', 'Period End', 'Balance'],
  },
  columnRoles: {
    activityDate: 'Date',
    description: 'Description',
    amount: 'Amount',
    activityType: 'Type',
    employer: 'Employer',
    periodStart: 'Period Start',
    periodEnd: 'Period End',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

/**
 * A member/annual statement summary — opening balance, the period's movement
 * totals, closing balance, as a key/value export.
 *
 * ============================================================================
 * WHY THREE COLUMNS AND NOT TWO
 * ============================================================================
 *
 * The obvious shape for this is two columns, `Item, Amount`. It is not what
 * this adapter declares, for two reasons that happen to point the same way:
 *
 * 1. PLATFORM CONSTRAINT, RESPECTED RATHER THAN WEAKENED. The shared CSV
 *    intake helper's `findHeaderRowIndex`
 *    (`lib/financial-data-hub/bank-csv/csv.ts`) requires at least two
 *    delimiters — three columns — before it will accept a line as a header.
 *    That heuristic exists because a single-delimiter line is weak evidence of
 *    being a table at all, and relaxing it would make every OTHER importer
 *    (R7 bank CSV, FDH-5, FDH-11) more willing to mistake a stray preamble
 *    line such as `Statement for, John Smith` for the header row. FDH-12 is
 *    not entitled to loosen a shared safety heuristic to suit one new layout.
 *
 * 2. THE THIRD COLUMN IS GENUINELY BETTER. `Period` carries what the figure
 *    covers — the statement period, or "Year to date". That turns the
 *    period-vs-YTD distinction (spec sections 114-116) from something inferred
 *    out of the label text into something the file states outright, which is
 *    strictly more reliable. The label-based inference remains as a fallback
 *    for files whose Period column is blank.
 *
 * The shape is also unambiguous against the transaction layout above
 * (`Date`/`Description`/`Amount`), so the two can never both score above the
 * confidence gap on one file.
 */
export const GENERIC_RETIREMENT_SUMMARY_CSV: RetirementCsvAdapter = {
  id: 'fdh12_generic_retirement_summary_csv_v1',
  institutionCode: null,
  jurisdiction: 'AU',
  version: '1.0.0',
  coverageState: 'certified',
  displayName: 'Generic retirement member-statement summary CSV',
  statementType: 'super_member_statement',
  accountType: 'unknown',
  csvKind: 'summary',
  signature: {
    requiredHeaders: ['Item', 'Amount', 'Period'],
    optionalHeaders: ['Period Start', 'Period End'],
  },
  columnRoles: { item: 'Item', amount: 'Amount', period: 'Period' },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

/**
 * Investment options held inside the fund. EVIDENCE ONLY — see migration 0111
 * PART D. Nothing that reads this adapter's output can write it to canonical
 * Investments, because no such path exists.
 */
export const GENERIC_RETIREMENT_HOLDINGS_CSV: RetirementCsvAdapter = {
  id: 'fdh12_generic_retirement_holdings_csv_v1',
  institutionCode: null,
  jurisdiction: 'AU',
  version: '1.0.0',
  coverageState: 'certified',
  displayName: 'Generic retirement investment-option CSV',
  statementType: 'super_member_statement',
  accountType: 'unknown',
  csvKind: 'holdings',
  signature: {
    requiredHeaders: ['Investment Option', 'Market Value'],
    optionalHeaders: ['Asset Class', 'Units', 'Unit Price', 'Valuation Date'],
  },
  columnRoles: {
    optionName: 'Investment Option',
    marketValue: 'Market Value',
    assetClass: 'Asset Class',
    units: 'Units',
    unitPrice: 'Unit Price',
    valuationDate: 'Valuation Date',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};

/**
 * India EPF passbook export (spec section 9).
 *
 * SCOPE HONESTY. This adapter reads an EPF passbook's contribution and
 * interest lines into the SAME evidence tables as an AU super statement. It
 * does NOT introduce an India retirement calculation engine, an EPF interest
 * model, or an NPS tier model — spec section 9 forbids building one merely to
 * parse a statement, and spec section 7 forbids inventing India retirement
 * architecture that canonical Retirement does not have. Canonical India
 * retirement support is catalogue-only (`epf`/`ppf`/`nps` items added by
 * migration 0100); the gaps are registered in
 * `docs/financial-data-hub/FDH12_INDIA_RETIREMENT_GAP_REGISTER.md`.
 *
 * What this adapter CAN therefore do is exactly what the AU adapters do:
 * produce a closing balance and activity evidence that the same bridge
 * proposes onto the same `retirement_accounts.current_balance`.
 */
export const GENERIC_EPF_PASSBOOK_CSV: RetirementCsvAdapter = {
  id: 'fdh12_generic_epf_passbook_csv_v1',
  institutionCode: null,
  jurisdiction: 'IN',
  version: '1.0.0',
  coverageState: 'certified',
  displayName: 'Generic EPF passbook CSV (India)',
  statementType: 'epf_passbook_statement',
  accountType: 'epf',
  csvKind: 'transaction',
  signature: {
    requiredHeaders: ['Date', 'Particulars', 'Amount'],
    optionalHeaders: ['Employer Share', 'Employee Share', 'Pension Share', 'Balance'],
  },
  columnRoles: {
    activityDate: 'Date',
    description: 'Particulars',
    amount: 'Amount',
  },
  scoreHeader(header) {
    return scoreHeaderAgainstSignature(header, this.signature);
  },
};
