/**
 * Field dispositions -- RETIREMENT / super statements (FDH-12). Canonical
 * Retirement is a SUMMARY-BALANCE register (retirement_accounts), not a
 * ledger: the closing balance is state; contributions, rollovers, earnings,
 * fees, insurance, tax and positions are EVIDENCE that must be user-visible
 * (contribution history / statement details). Owner: WP-13. Matrix section 5.
 *
 * WP-13 closed GAP-RET-01/02/03/04/05/06/07/09/11 (migration 0211, the
 * annualised + frequency-paired contribution proposal, the Retirement tab's
 * statement history and the user-confirmed bank leg). GAP-RET-08 (the grid's
 * provenance badge) belongs to WP-07.
 */
import { A, C, D, gap, rows, technical, type Row } from './build';
import type { RegistryFile } from './types';

const R08 = gap('GAP-RET-08', 'P2', 'WP-07');

const RT = 'Retirement tab';
/** Where every piece of statement evidence is visible after Apply (WP-13). */
const HIST = 'Retirement tab > Imported retirement statements (statement details) and the import review';
const REVIEW = 'Retirement tab > import review (comparison, ticked fields only)';
const EV = (col: string) => `evidence:fdh_retirement_statements.${col}`;
const HISTORY = 'evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger)';
const HOLDINGS = 'evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth)';

function header(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('fundName', 'fund_name'), A, 'retirement_accounts.account_name (add new)', RT],
    [f('maskedAccountIdentifier', 'masked_account_identifier'), C, EV('masked_account_identifier'), HIST],
    [f('statementDate', 'statement_date'), C, EV('statement_date') + ' (balance as-of; an older statement never silently regresses the balance)', HIST],
    [f('statementStartDate', 'statement_start_date'), C, EV('statement_start_date') + ' (annualises contribution totals, D-12)', HIST],
    [f('statementEndDate', 'statement_end_date'), C, EV('statement_end_date') + ' (balance as-of; an older statement never silently regresses the balance)', HIST],
    [f('openingBalance', 'opening_balance'), C, EV('opening_balance'), HIST],
    [f('closingBalance', 'closing_balance'), A, 'retirement_accounts.current_balance', RT, R08],
    [f('employerContributions', 'employer_contributions'), A, 'retirement_accounts.employer_contribution (annualised, only when ticked, with contribution_frequency; D-12)', REVIEW],
    [f('personalContributions', 'personal_contributions'), A, 'retirement_accounts.personal_contribution (annualised, only when ticked, with contribution_frequency; D-12)', REVIEW],
    [f('salarySacrifice', 'salary_sacrifice'), C, EV('salary_sacrifice'), HIST],
    [f('governmentContributions', 'government_contributions'), C, EV('government_contributions'), HIST],
    [f('rolloversIn', 'rollovers_in'), C, EV('rollovers_in') + ' (neutral: income 0 / expense 0 / net worth 0)', HIST],
    [f('rolloversOut', 'rollovers_out'), C, EV('rollovers_out') + ' (neutral)', HIST],
    [f('withdrawals', 'withdrawals'), C, EV('withdrawals') + ' (the bank credit is the household leg)', HIST],
    [f('pensionPayments', 'pension_payments'), C, EV('pension_payments') + ' (household income via the bank credit, once)', HIST],
    [f('investmentEarnings', 'investment_earnings'), C, EV('investment_earnings'), HIST],
    ['fees', C, EV('fees') + ' (repeated lines summed; never a household expense)', HIST],
    [f('insurancePremiums', 'insurance_premiums'), C, EV('insurance_premiums'), HIST],
    ['tax', C, EV('tax'), HIST],
  ];
}

function activity(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('activityType', 'activity_type'), C, HISTORY, HIST],
    ['amount', C, HISTORY, HIST],
    [f('activityDate', 'activity_date'), C, HISTORY, HIST],
    [f('descriptionRaw', 'description_raw'), C, HISTORY, HIST],
    [f('employerNameRaw', 'employer_name_raw'), C, HISTORY, HIST],
    [f('isSummaryTotal', 'is_summary_total'), D, 'fdh_retirement_statement_activities.is_summary_total'],
    [f('isYearToDate', 'is_year_to_date'), D, 'fdh_retirement_statement_activities.is_year_to_date'],
  ];
}

function position(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('optionNameRaw', 'option_name_raw'), C, HOLDINGS, HIST],
    [f('assetClassRaw', 'asset_class_raw'), C, HOLDINGS, HIST],
    ['units', C, HOLDINGS, HIST],
    [f('unitPrice', 'unit_price'), C, HOLDINGS, HIST],
    [f('marketValue', 'market_value'), C, HOLDINGS, HIST],
    [f('valuationDate', 'valuation_date'), C, HOLDINGS, HIST],
  ];
}

const NATIVE: Row[] = [
  ['statementType', D, 'fdh_retirement_statements.statement_type'],
  ['jurisdiction', D, 'fdh_retirement_statements.retirement_jurisdiction (-> country_code on add new)'],
  ['accountType', A, 'retirement_accounts.account_type (add new)', RT],
  ['currencyCode', A, 'retirement_accounts.currency_code', RT],
  ...header('camel'),
  ['ytdEmployerContributions', C, EV('ytd_employer_contributions') + ' (labelled YTD)', HIST],
  ['ytdPersonalContributions', C, EV('ytd_personal_contributions') + ' (labelled YTD)', HIST],
  ['activities', C, HISTORY, HIST],
  ['positions', C, HOLDINGS, HIST],
  ['parserName', D, 'fdh_retirement_statements.parser'],
  ['parserVersion', D, 'fdh_retirement_statements.parser_version'],
  ['extractionConfidence', D, 'fdh_retirement_statements.extraction_confidence'],
  ['warnings', C, 'fdh_retirement_statements.extraction_warnings (0207; persisted by WP-13, write-guarded by 0211)', HIST],
];

const NATIVE_ACTIVITY: Row[] = [
  ...activity('camel'),
  ['currencyCode', C, HISTORY, HIST],
  ['effectivePeriodStart', C, HISTORY, HIST],
  ['effectivePeriodEnd', C, HISTORY, HIST],
  ['sourceRowNumber', D, 'fdh_retirement_statement_activities.source_row_number'],
];

const NATIVE_POSITION: Row[] = [
  ...position('camel'),
  ['tickerRaw', C, HOLDINGS, HIST],
  ['isin', C, HOLDINGS, HIST],
  ['currencyCode', C, HOLDINGS, HIST],
  ['sourceRowNumber', D, 'fdh_retirement_statement_positions.source_row_number'],
];

const AI_DOC: Row[] = [
  ['schemaVersion', D, 'aie run evidence'],
  ['documentMissingReasonCode', D, 'aie run evidence'],
  ...header('camel'),
  ['activities', C, HISTORY, HIST],
  ['positions', C, HOLDINGS, HIST],
];

const TYPES: Row[] = [
  ['EMPLOYER_CONTRIBUTION', C, HISTORY + '; payslip + fund are ONE effect, never income', HIST],
  ['PERSONAL_CONTRIBUTION', C, HISTORY + '; the matched bank debit is a transfer (user-confirmed, fdh12_confirm_retirement_bank_leg)', HIST],
  ['SALARY_SACRIFICE', C, HISTORY, HIST],
  ['GOVERNMENT_CONTRIBUTION', C, HISTORY, HIST],
  ['ROLLOVER_IN', C, HISTORY + '; fund A -> fund B is income 0 / expense 0 / net worth 0', HIST],
  ['ROLLOVER_OUT', C, HISTORY + '; neutral', HIST],
  ['INVESTMENT_EARNINGS', C, HISTORY, HIST],
  ['INTEREST', C, HISTORY, HIST],
  ['DISTRIBUTION', C, HISTORY, HIST],
  ['FEE', C, HISTORY + '; never a household expense', HIST],
  ['INSURANCE_PREMIUM', C, HISTORY, HIST],
  ['TAX', C, HISTORY, HIST],
  ['PENSION_PAYMENT', C, HISTORY + '; household income via the bank credit, once (user-confirmed)', HIST],
  ['WITHDRAWAL', C, HISTORY + '; the bank credit is a transfer (user-confirmed)', HIST],
  ['ADJUSTMENT', C, HISTORY + '; shown for review', HIST],
  ['OTHER', C, HISTORY + '; shown for review', HIST],
  ['UNKNOWN', C, HISTORY + '; shown for review, never classified silently', HIST],
];

const STATEMENTS: Row[] = [
  ...technical(['id', 'user_id', 'household_id', 'statement_upload_id', 'canonical_account_id'], 'fdh_retirement_statements'),
  ['retirement_member_id', A, 'retirement_accounts.retirement_member_id', RT],
  ['statement_type', D, 'fdh_retirement_statements.statement_type'],
  ['retirement_jurisdiction', D, 'fdh_retirement_statements.retirement_jurisdiction'],
  ['account_type', A, 'retirement_accounts.account_type', RT],
  ['nickname', C, EV('nickname') + ' (user-correctable label)', HIST],
  ['currency_code', A, 'retirement_accounts.currency_code', RT],
  ...header('snake'),
  ['ytd_employer_contributions', C, EV('ytd_employer_contributions'), HIST],
  ['ytd_personal_contributions', C, EV('ytd_personal_contributions'), HIST],
  ...technical(['parser', 'parser_version', 'extraction_confidence', 'extraction_status'], 'fdh_retirement_statements'),
  ['reconciliation_status', D, 'fdh_retirement_statements.reconciliation_status (system-authoritative on INSERT and UPDATE, 0211)'],
  ...technical(['reconciliation_variance', 'account_match_status', 'account_match_candidates', 'smsf_classification', 'smsf_evidence', 'review_status'], 'fdh_retirement_statements'),
  ['approval_status', D, 'fdh_retirement_statements.approval_status (system-authoritative on INSERT and UPDATE, 0211)'],
  ...technical(['approved_at', 'approved_by', 'duplicate_of_statement_id', 'supersedes_statement_id', 'source_provenance', 'created_at', 'updated_at'], 'fdh_retirement_statements'),
  ['extraction_warnings', C, 'fdh_retirement_statements.extraction_warnings (0207; write-guarded by 0211)', HIST],
];

const ACTIVITIES: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_retirement_statement_activities'),
  ...activity('snake'),
  ['effective_period_start', C, HISTORY, HIST],
  ['effective_period_end', C, HISTORY, HIST],
  ['currency_code', C, HISTORY, HIST],
  ...technical(['employer_normalised', 'payslip_match_status', 'matched_payroll_event_id', 'payslip_match_variance', 'payslip_match_candidates'], 'fdh_retirement_statement_activities'),
  ['bank_match_status', D, 'fdh_retirement_statement_activities.bank_match_status (re-matched after a later bank approval, WP-13)'],
  ['linked_transaction_id', D, 'the matched bank leg (reclassified only with the user\'s confirmation, 0211)'],
  ['bank_leg_confirmed_at', D, 'fdh_retirement_statement_activities.bank_leg_confirmed_at (the user\'s confirmation, 0211)'],
  ['bank_leg_confirmed_type', D, 'fdh_retirement_statement_activities.bank_leg_confirmed_type (transfer | income; the bank leg\'s type after confirmation, 0211)'],
  ...technical(['bank_match_candidates', 'rollover_counterpart_activity_id', 'rollover_match_status', 'review_status', 'activity_fingerprint', 'duplicate_of_activity_id', 'source_row_number', 'created_at', 'updated_at'], 'fdh_retirement_statement_activities'),
];

const POSITIONS: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_retirement_statement_positions'),
  ...position('snake'),
  ['ticker_raw', C, HOLDINGS, HIST],
  ['isin', C, HOLDINGS, HIST],
  ['currency_code', C, HOLDINGS, HIST],
  ...technical(['source_row_number', 'created_at', 'updated_at'], 'fdh_retirement_statement_positions'),
];

export const retirementStatementRegistry: RegistryFile = {
  id: 'retirementStatement',
  ownerWp: 'WP-13',
  OPEN_GAP_CEILING: 3,
  entries: [
    ...rows('retirement_native', 'ts_interface', 'fdh:retirement/types.ts#RetirementStatementExtraction', NATIVE),
    ...rows('retirement_native', 'ts_interface', 'fdh:retirement/types.ts#RetirementActivityEvidence', NATIVE_ACTIVITY),
    ...rows('retirement_native', 'ts_interface', 'fdh:retirement/types.ts#RetirementPositionEvidence', NATIVE_POSITION),
    ...rows('retirement_ai', 'zod_schema', 'aie:retirement/schema.ts#retirementDocumentFactsSchema', AI_DOC),
    ...rows('retirement_ai', 'zod_schema', 'aie:retirement/schema.ts#retirementActivitySchema', activity('camel')),
    ...rows('retirement_ai', 'zod_schema', 'aie:retirement/schema.ts#retirementPositionSchema', position('camel')),
    ...rows('retirement_native', 'enum_value', 'enum:RETIREMENT_ACTIVITY_TYPES', TYPES),
    ...rows('retirement_native', 'db_column', 'db:fdh_retirement_statements', STATEMENTS),
    ...rows('retirement_native', 'db_column', 'db:fdh_retirement_statement_activities', ACTIVITIES),
    ...rows('retirement_native', 'db_column', 'db:fdh_retirement_statement_positions', POSITIONS),
  ],
};
