/**
 * Field dispositions -- CREDIT CARD / LOAN statements (FDH-10, the mandatory
 * gate): header, extraction, AI-fallback and evidence tables. Owner: WP-10
 * (evidence persistence); the activity -> ledger mapping is
 * liabilityActivityLedger.ts (WP-11). Matrix section 3.
 *
 * WP-10 closed G5 (totals incl. PRINCIPAL lines, signed adjustments, loan
 * redraws and capitalised interest -- computeStatementTotals) and G6 (warnings,
 * GST and the bank-match candidates persisted; the never-populated columns are
 * E with user copy). WP-11 closed G1, G2, G4 (verified Apply links, picker,
 * back-match), G7 (Statement history), G13 (unsupported currency refused) and
 * X-01 (a card minimum payment never reaches monthly_repayment unticked). The
 * remaining open gaps are the grid provenance badges (G7, WP-07).
 */
import { A, B, C, D, E, gap, rows, technical, type Row } from './build';
import type { RegistryFile } from './types';

const G7_BADGE = gap('G7', 'P1', 'WP-07');

const LT = 'Liabilities tab';
const HISTORY = 'Liabilities tab → Statement history';
const REVIEW = 'Liabilities tab → Import Statement (review)';
const NOT_READ = `${HISTORY} ("Not read from statements …")`;
const EV = (col: string) => `evidence:fdh_liability_statements.${col}`;
const LEDGER = 'fdh_transactions (card/loan facility ledger row, 0209)';

/** Header facts common to the native type, the AI schema and the table. */
function header(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('institutionName', 'institution_name'), A, 'liabilities.lender', LT],
    [f('maskedIdentifier', 'masked_identifier'), A, 'liabilities.masked_identifier', null, G7_BADGE],
    [f('statementPeriodStart', 'statement_period_start'), C, EV('statement_period_start'), HISTORY],
    [f('statementPeriodEnd', 'statement_period_end'), C, EV('statement_period_end'), HISTORY],
    [f('statementDate', 'statement_date'), C, EV('statement_date'), HISTORY],
    [f('dueDate', 'due_date'), A, 'liabilities.due_date', null, G7_BADGE],
    [f('openingBalance', 'opening_balance'), C, EV('opening_balance'), HISTORY],
    [f('closingBalance', 'closing_balance'), A, 'liabilities.balance (card)', LT, G7_BADGE],
    [f('creditLimit', 'credit_limit'), A, 'liabilities.credit_limit (not in Net Worth)', LT],
    [f('minimumPayment', 'minimum_payment'), A, 'liabilities.minimum_payment (monthly_repayment only when ticked; D-08)', LT],
    [f('interestRate', 'interest_rate'), A, 'liabilities.interest_rate (loan) / card APR in statement history', `${LT}; ${HISTORY}`],
  ];
}

function loanAndUnsupported(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('availableCredit', 'available_credit'), E, 'not read from statements', NOT_READ],
    [f('openingPrincipal', 'opening_principal'), C, EV('opening_principal'), HISTORY],
    [f('closingPrincipal', 'closing_principal'), A, 'liabilities.balance (loan)', LT, G7_BADGE],
    [f('rateType', 'rate_type'), E, 'not read from statements', NOT_READ],
    [f('repaymentFrequency', 'repayment_frequency'), E, 'not read from statements (proposal reads null)', `${REVIEW} ("Not shown on statement"); ${NOT_READ}`],
    [f('maturityDate', 'maturity_date'), E, 'not read from statements', NOT_READ],
    [f('arrearsAmount', 'arrears_amount'), E, 'not read from statements', NOT_READ],
  ];
}

const NATIVE: Row[] = [
  ['statementType', D, 'fdh_liability_statements.statement_type'],
  ['country', A, 'liabilities.country_code', LT],
  ['currencyCode', A, 'liabilities.currency_code (AUD/INR only; any other currency is refused with a visible reason)', LT],
  ['facilityType', A, 'liabilities.debt_type', LT],
  ['nickname', E, 'not persisted (a display nickname is not a canonical fact)', NOT_READ],
  ...header('camel'),
  ...loanAndUnsupported('camel'),
  ['activities', B, LEDGER, HISTORY],
  ['parserName', D, 'fdh_liability_statements.parser_name'],
  ['parserVersion', D, 'fdh_liability_statements.parser_version'],
  ['extractionConfidence', D, 'fdh_liability_statements.extraction_confidence'],
  ['warnings', E, 'fdh_liability_statements.extraction_warnings (excluded rows and unchecked figures, with the reason)', `${REVIEW}; ${HISTORY} (notes)`],
];

function activity(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('activityType', 'activity_type'), B, 'fdh_transactions.economic_transaction_type (see liabilityActivityLedger)', HISTORY],
    [f('activityDate', 'activity_date'), B, 'fdh_transactions.transaction_date', HISTORY],
    ['amount', B, 'fdh_transactions.amount_original', HISTORY],
    [f('descriptionRaw', 'description_raw'), C, 'evidence:fdh_liability_statement_activities.description_raw (copied to the ledger row)', HISTORY],
    [f('merchantRaw', 'merchant_raw'), C, 'evidence:fdh_liability_statement_activities.merchant_raw (copied to the ledger row)', 'Financial Activity (transaction detail)'],
    [f('principalComponent', 'principal_component'), B, 'fdh_transaction_allocations (debt_principal)', HISTORY],
    [f('interestComponent', 'interest_component'), B, 'fdh_transaction_allocations (debt_interest)', HISTORY],
    [f('feeComponent', 'fee_component'), B, 'fdh_transaction_allocations (fee)', HISTORY],
  ];
}

const NATIVE_ACTIVITY: Row[] = [
  ...activity('camel'),
  ['gstAmountRaw', C, 'evidence:fdh_liability_statement_activities.gst_amount_raw (never summed)', HISTORY],
  ['sourceRowNumber', D, 'fdh_liability_statement_activities.source_row_number'],
];

const AI_DOC: Row[] = [
  ['schemaVersion', D, 'aie run evidence'],
  ['documentMissingReasonCode', D, 'aie run evidence'],
  ...header('camel'),
  ['allActivitiesListed', C, 'evidence: AI draft completeness flag', 'Liabilities tab → Import Statement (AI draft review)'],
  ['activities', B, LEDGER, HISTORY],
];

const TOTAL = (col: string): Row => [col, C, EV(col) + ' (equals the ledger sum per type; computeStatementTotals)', `${REVIEW}; ${HISTORY}`];

const STATEMENTS: Row[] = [
  ...technical(['id', 'user_id', 'household_id', 'statement_upload_id'], 'fdh_liability_statements'),
  ['financial_account_id', D, 'fdh_liability_statements.financial_account_id (set by the Apply RPC)'],
  ['liability_id', D, 'fdh_liability_statements.liability_id (set by the Apply RPC)'],
  ['statement_type', D, 'fdh_liability_statements.statement_type'],
  ['facility_type', A, 'liabilities.debt_type', LT],
  ['country_code', A, 'liabilities.country_code', LT],
  ['currency_code', A, 'liabilities.currency_code (AUD/INR only; any other currency is refused with a visible reason)', LT],
  ...header('snake'),
  ...loanAndUnsupported('snake'),
  ...['purchases_total', 'cash_advances_total', 'interest_total', 'fees_total', 'payments_total', 'refunds_total', 'adjustments_total', 'drawdowns_total', 'capitalised_total', 'principal_repayments_total'].map(TOTAL),
  ...technical([
    'reconciliation_status', 'reconciliation_variance', 'parser_name', 'parser_version', 'extraction_confidence', 'review_status',
    'approval_status', 'approved_at', 'approved_by', 'duplicate_of_statement_id', 'supersedes_statement_id', 'created_at', 'updated_at',
    'user_corrected_fields', 'last_corrected_at', 'last_corrected_by',
  ], 'fdh_liability_statements'),
  ['extraction_warnings', E, 'fdh_liability_statements.extraction_warnings (excluded rows and unchecked figures, with the reason)', `${REVIEW}; ${HISTORY} (notes)`],
  // 0209: the ledger outcome of the whole statement.
  ['ledger_status', D, 'fdh_liability_statements.ledger_status (not_applied / applied / rejected; set by the Apply RPC, shown in Statement history)'],
  ['ledger_applied_at', D, 'fdh_liability_statements.ledger_applied_at'],
  ['ledger_rejected_reason', D, 'fdh_liability_statements.ledger_rejected_reason ("You rejected this statement" in Statement history)'],
];

const ACTIVITIES: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_liability_statement_activities'),
  ...activity('snake'),
  ['currency_code', B, 'fdh_transactions.currency_original', HISTORY],
  ['description_clean', C, 'evidence:fdh_liability_statement_activities.description_clean', 'Financial Activity (transaction detail)'],
  ['merchant_id', D, 'fdh_liability_statement_activities.merchant_id (category lives on the ledger row)'],
  ['category_id', B, 'fdh_transactions.category_id (R8 category only, never economic type)', 'Financial Activity'],
  ['linked_transaction_id', D, 'the bank leg of a PAYMENT (re-verified and confirmed as a settlement link by the Apply RPC)'],
  ['bank_match_status', D, 'fdh_liability_statement_activities.bank_match_status (shown per repayment in review and history)'],
  ...technical(['review_status', 'source_row_number', 'created_at', 'updated_at'], 'fdh_liability_statement_activities'),
  ['ledger_transaction_id', D, 'the fdh_transactions row this activity became (0207; set by the Apply RPC)'],
  ['gst_amount_raw', C, 'evidence:fdh_liability_statement_activities.gst_amount_raw (never summed)', HISTORY],
  // 0208 / 0209.
  ['bank_match_candidate_ids', D, 'the possible bank debits of an ambiguous repayment (review picker; the choice is re-verified)'],
  ['ledger_disposition', D, 'fdh_liability_statement_activities.ledger_disposition (recorded / duplicate / not counted / rejected; shown in Statement history)'],
  ['ledger_duplicate_of_transaction_id', D, 'the earlier ledger row an overlapping statement line duplicates (never inserted twice)'],
];

export const liabilityStatementRegistry: RegistryFile = {
  id: 'liabilityStatement',
  ownerWp: 'WP-10',
  OPEN_GAP_CEILING: 11,
  entries: [
    ...rows('liability_native', 'ts_interface', 'fdh:liability/types.ts#LiabilityStatementExtraction', NATIVE),
    ...rows('liability_native', 'ts_interface', 'fdh:liability/types.ts#LiabilityStatementActivity', NATIVE_ACTIVITY),
    ...rows('liability_ai', 'zod_schema', 'aie:liability/schema.ts#liabilityStatementDocumentFactsSchema', AI_DOC),
    ...rows('liability_ai', 'zod_schema', 'aie:liability/schema.ts#liabilityStatementActivitySchema', activity('camel')),
    ...rows('liability_native', 'db_column', 'db:fdh_liability_statements', STATEMENTS),
    ...rows('liability_native', 'db_column', 'db:fdh_liability_statement_activities', ACTIVITIES),
  ],
};
