/**
 * Field dispositions -- CREDIT CARD / LOAN statements (FDH-10, the mandatory
 * gate): header, extraction, AI-fallback and evidence tables. Owner: WP-10
 * (evidence persistence); the activity -> ledger mapping is
 * liabilityActivityLedger.ts (WP-11). Matrix section 3.
 */
import { A, B, C, D, E, gap, rows, technical, type Row } from './build';
import type { RegistryFile } from './types';

const G1 = gap('G1', 'P0', 'WP-11');
const G2 = gap('G2', 'P1', 'WP-11');
const G4 = gap('G4', 'P1', 'WP-10');
const G5 = gap('G5', 'P1', 'WP-10');
const G6 = gap('G6', 'P2', 'WP-10');
const G7 = gap('G7', 'P1', 'WP-11');
const G7_BADGE = gap('G7', 'P1', 'WP-07');
const G13 = gap('G13', 'P3', 'WP-11');
const X01 = gap('X-01', 'P1', 'WP-11');

const LT = 'Liabilities tab';
const EV = (col: string) => `evidence:fdh_liability_statements.${col}`;
const LEDGER = 'fdh_transactions (card/loan facility ledger row, WP-11)';

/** Header facts common to the native type, the AI schema and the table. */
function header(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('institutionName', 'institution_name'), A, 'liabilities.lender', LT],
    [f('maskedIdentifier', 'masked_identifier'), A, 'liabilities.masked_identifier', null, G7_BADGE],
    [f('statementPeriodStart', 'statement_period_start'), C, EV('statement_period_start'), null, G7],
    [f('statementPeriodEnd', 'statement_period_end'), C, EV('statement_period_end'), null, G7],
    [f('statementDate', 'statement_date'), C, EV('statement_date'), null, G7],
    [f('dueDate', 'due_date'), A, 'liabilities.due_date', null, G7_BADGE],
    [f('openingBalance', 'opening_balance'), C, EV('opening_balance'), null, G7],
    [f('closingBalance', 'closing_balance'), A, 'liabilities.balance (card)', LT, G7_BADGE],
    [f('creditLimit', 'credit_limit'), A, 'liabilities.credit_limit (not in Net Worth)', LT],
    [f('minimumPayment', 'minimum_payment'), A, 'liabilities.minimum_payment (monthly_repayment only when ticked; D-08)', LT, X01],
    [f('interestRate', 'interest_rate'), A, 'liabilities.interest_rate (loan) / card APR in statement history', LT, G7],
  ];
}

function loanAndUnsupported(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('availableCredit', 'available_credit'), E, 'not populated (shown as "Not shown on statement")', null, G6],
    [f('openingPrincipal', 'opening_principal'), C, EV('opening_principal'), null, G7],
    [f('closingPrincipal', 'closing_principal'), A, 'liabilities.balance (loan)', LT, G7_BADGE],
    [f('rateType', 'rate_type'), E, 'not populated', null, G6],
    [f('repaymentFrequency', 'repayment_frequency'), E, 'not populated (proposal reads null)', null, G6],
    [f('maturityDate', 'maturity_date'), E, 'not populated', null, G6],
    [f('arrearsAmount', 'arrears_amount'), E, 'not populated', null, G6],
  ];
}

const NATIVE: Row[] = [
  ['statementType', D, 'fdh_liability_statements.statement_type'],
  ['country', A, 'liabilities.country_code', LT],
  ['currencyCode', A, 'liabilities.currency_code (unsupported currency refused)', LT, G13],
  ['facilityType', A, 'liabilities.debt_type', LT],
  ['nickname', E, 'not persisted (a display nickname is not a canonical fact)', null, G6],
  ...header('camel'),
  ...loanAndUnsupported('camel'),
  ['activities', B, LEDGER, null, G1],
  ['parserName', D, 'fdh_liability_statements.parser_name'],
  ['parserVersion', D, 'fdh_liability_statements.parser_version'],
  ['extractionConfidence', D, 'fdh_liability_statements.extraction_confidence'],
  ['warnings', E, 'fdh_liability_statements.extraction_warnings (0207)', null, G6],
];

function activity(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('activityType', 'activity_type'), B, 'fdh_transactions.economic_transaction_type (see liabilityActivityLedger)', null, G1],
    [f('activityDate', 'activity_date'), B, 'fdh_transactions.transaction_date', null, G1],
    ['amount', B, 'fdh_transactions.amount_original', null, G1],
    [f('descriptionRaw', 'description_raw'), C, 'evidence:fdh_liability_statement_activities.description_raw (copied to the ledger row)', null, G1],
    [f('merchantRaw', 'merchant_raw'), C, 'evidence:fdh_liability_statement_activities.merchant_raw', null, G1],
    [f('principalComponent', 'principal_component'), B, 'fdh_transaction_allocations (debt_principal)', null, G2],
    [f('interestComponent', 'interest_component'), B, 'fdh_transaction_allocations (debt_interest)', null, G2],
    [f('feeComponent', 'fee_component'), B, 'fdh_transaction_allocations (fee)', null, G2],
  ];
}

const NATIVE_ACTIVITY: Row[] = [
  ...activity('camel'),
  ['gstAmountRaw', C, 'evidence:fdh_liability_statement_activities.gst_amount_raw (0207; never summed)', null, G6],
  ['sourceRowNumber', D, 'fdh_liability_statement_activities.source_row_number'],
];

const AI_DOC: Row[] = [
  ['schemaVersion', D, 'aie run evidence'],
  ['documentMissingReasonCode', D, 'aie run evidence'],
  ...header('camel'),
  ['allActivitiesListed', C, 'evidence: AI draft completeness flag', null, G6],
  ['activities', B, LEDGER, null, G1],
];

const TOTAL = (col: string): Row => [col, C, EV(col) + ' (must equal the ledger sum per type)', null, G5];

const STATEMENTS: Row[] = [
  ...technical(['id', 'user_id', 'household_id', 'statement_upload_id'], 'fdh_liability_statements'),
  ['financial_account_id', D, 'fdh_liability_statements.financial_account_id (set by the Apply RPC)', null, G7],
  ['liability_id', D, 'fdh_liability_statements.liability_id (set by the Apply RPC)', null, G7],
  ['statement_type', D, 'fdh_liability_statements.statement_type'],
  ['facility_type', A, 'liabilities.debt_type', LT],
  ['country_code', A, 'liabilities.country_code', LT],
  ['currency_code', A, 'liabilities.currency_code (unsupported currency refused)', LT, G13],
  ...header('snake'),
  ...loanAndUnsupported('snake'),
  ...['purchases_total', 'cash_advances_total', 'interest_total', 'fees_total', 'payments_total', 'refunds_total', 'adjustments_total', 'drawdowns_total', 'capitalised_total', 'principal_repayments_total'].map(TOTAL),
  ...technical([
    'reconciliation_status', 'reconciliation_variance', 'parser_name', 'parser_version', 'extraction_confidence', 'review_status',
    'approval_status', 'approved_at', 'approved_by', 'duplicate_of_statement_id', 'supersedes_statement_id', 'created_at', 'updated_at',
    'user_corrected_fields', 'last_corrected_at', 'last_corrected_by',
  ], 'fdh_liability_statements'),
  ['extraction_warnings', E, 'fdh_liability_statements.extraction_warnings (0207; rendered by WP-11)', null, G6],
];

const ACTIVITIES: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_liability_statement_activities'),
  ...activity('snake'),
  ['currency_code', B, 'fdh_transactions.currency_original', null, G1],
  ['description_clean', C, 'evidence:fdh_liability_statement_activities.description_clean', null, G1],
  ['merchant_id', D, 'fdh_liability_statement_activities.merchant_id (category lives on the ledger row)', null, G1],
  ['category_id', B, 'fdh_transactions.category_id (R8 category only, never economic type)', null, G1],
  ['linked_transaction_id', D, 'the bank leg of a PAYMENT (source of the confirmed settlement link)', null, G4],
  ['bank_match_status', D, 'fdh_liability_statement_activities.bank_match_status', null, G4],
  ...technical(['review_status', 'source_row_number', 'created_at', 'updated_at'], 'fdh_liability_statement_activities'),
  ['ledger_transaction_id', D, 'the fdh_transactions row this activity became (0207; set by WP-11)', null, G1],
  ['gst_amount_raw', C, 'evidence:fdh_liability_statement_activities.gst_amount_raw (0207; never summed)', null, G6],
];

export const liabilityStatementRegistry: RegistryFile = {
  id: 'liabilityStatement',
  ownerWp: 'WP-10',
  OPEN_GAP_CEILING: 94,
  entries: [
    ...rows('liability_native', 'ts_interface', 'fdh:liability/types.ts#LiabilityStatementExtraction', NATIVE),
    ...rows('liability_native', 'ts_interface', 'fdh:liability/types.ts#LiabilityStatementActivity', NATIVE_ACTIVITY),
    ...rows('liability_ai', 'zod_schema', 'aie:liability/schema.ts#liabilityStatementDocumentFactsSchema', AI_DOC),
    ...rows('liability_ai', 'zod_schema', 'aie:liability/schema.ts#liabilityStatementActivitySchema', activity('camel')),
    ...rows('liability_native', 'db_column', 'db:fdh_liability_statements', STATEMENTS),
    ...rows('liability_native', 'db_column', 'db:fdh_liability_statement_activities', ACTIVITIES),
  ],
};
