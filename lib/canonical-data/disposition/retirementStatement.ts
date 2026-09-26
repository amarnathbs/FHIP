/**
 * Field dispositions -- RETIREMENT / super statements (FDH-12). Canonical
 * Retirement is a SUMMARY-BALANCE register (retirement_accounts), not a
 * ledger: the closing balance is state; contributions, rollovers, earnings,
 * fees, insurance, tax and positions are EVIDENCE that must be user-visible
 * (contribution history / statement details). Owner: WP-13. Matrix section 5.
 */
import { A, C, D, E, gap, rows, technical, type Row } from './build';
import type { RegistryFile } from './types';

const R01 = gap('GAP-RET-01', 'P1', 'WP-13');
const R03 = gap('GAP-RET-03', 'P1', 'WP-13');
const R04 = gap('GAP-RET-04', 'P2', 'WP-13');
const R05 = gap('GAP-RET-05', 'P2', 'WP-13');
const R06 = gap('GAP-RET-06', 'P2', 'WP-13');
const R07 = gap('GAP-RET-07', 'P2', 'WP-13');
const R09 = gap('GAP-RET-09', 'P2', 'WP-13');

const RT = 'Retirement tab';
const EV = (col: string) => `evidence:fdh_retirement_statements.${col}`;
const HISTORY = 'evidence:fdh_retirement_statement_activities (contribution history; never posted to the household ledger)';
const HOLDINGS = 'evidence:fdh_retirement_statement_positions ("holdings in super"; never Net Worth)';

function header(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('fundName', 'fund_name'), A, 'retirement_accounts.account_name (add new)', RT],
    [f('maskedAccountIdentifier', 'masked_account_identifier'), C, EV('masked_account_identifier'), null, R03],
    [f('statementDate', 'statement_date'), C, EV('statement_date') + ' (balance as-of)', null, R06],
    [f('statementStartDate', 'statement_start_date'), C, EV('statement_start_date'), null, R06],
    [f('statementEndDate', 'statement_end_date'), C, EV('statement_end_date') + ' (balance as-of)', null, R06],
    [f('openingBalance', 'opening_balance'), C, EV('opening_balance'), null, R03],
    [f('closingBalance', 'closing_balance'), A, 'retirement_accounts.current_balance', `${RT} ("Imported from retirement statement" badge, WP-07)`],
    [f('employerContributions', 'employer_contributions'), A, 'retirement_accounts.employer_contribution (only when ticked, with contribution_frequency; D-12)', null, R01],
    [f('personalContributions', 'personal_contributions'), A, 'retirement_accounts.personal_contribution (only when ticked, with contribution_frequency; D-12)', null, R01],
    [f('salarySacrifice', 'salary_sacrifice'), C, EV('salary_sacrifice'), null, R04],
    [f('governmentContributions', 'government_contributions'), C, EV('government_contributions'), null, R04],
    [f('rolloversIn', 'rollovers_in'), C, EV('rollovers_in') + ' (neutral: income 0 / expense 0 / net worth 0)', null, R04],
    [f('rolloversOut', 'rollovers_out'), C, EV('rollovers_out') + ' (neutral)', null, R04],
    [f('withdrawals', 'withdrawals'), C, EV('withdrawals') + ' (the bank credit is the household leg)', null, R04],
    [f('pensionPayments', 'pension_payments'), C, EV('pension_payments') + ' (household income via the bank credit, once)', null, R04],
    [f('investmentEarnings', 'investment_earnings'), C, EV('investment_earnings'), null, R03],
    ['fees', C, EV('fees') + ' (never a household expense)', null, R05],
    [f('insurancePremiums', 'insurance_premiums'), C, EV('insurance_premiums'), null, R03],
    ['tax', C, EV('tax'), null, R03],
  ];
}

function activity(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('activityType', 'activity_type'), C, HISTORY, null, R03],
    ['amount', C, HISTORY, null, R03],
    [f('activityDate', 'activity_date'), C, HISTORY, null, R03],
    [f('descriptionRaw', 'description_raw'), C, HISTORY, null, R03],
    [f('employerNameRaw', 'employer_name_raw'), C, HISTORY, null, R03],
    [f('isSummaryTotal', 'is_summary_total'), D, 'fdh_retirement_statement_activities.is_summary_total'],
    [f('isYearToDate', 'is_year_to_date'), D, 'fdh_retirement_statement_activities.is_year_to_date'],
  ];
}

function position(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('optionNameRaw', 'option_name_raw'), C, HOLDINGS, null, R03],
    [f('assetClassRaw', 'asset_class_raw'), C, HOLDINGS, null, R04],
    ['units', C, HOLDINGS, null, R04],
    [f('unitPrice', 'unit_price'), C, HOLDINGS, null, R04],
    [f('marketValue', 'market_value'), C, HOLDINGS, null, R03],
    [f('valuationDate', 'valuation_date'), C, HOLDINGS, null, R04],
  ];
}

const NATIVE: Row[] = [
  ['statementType', D, 'fdh_retirement_statements.statement_type'],
  ['jurisdiction', D, 'fdh_retirement_statements.retirement_jurisdiction (-> country_code on add new)'],
  ['accountType', A, 'retirement_accounts.account_type (add new)', RT],
  ['currencyCode', A, 'retirement_accounts.currency_code', RT],
  ...header('camel'),
  ['ytdEmployerContributions', C, EV('ytd_employer_contributions') + ' (labelled YTD)', null, R04],
  ['ytdPersonalContributions', C, EV('ytd_personal_contributions') + ' (labelled YTD)', null, R04],
  ['activities', C, HISTORY, null, R03],
  ['positions', C, HOLDINGS, null, R03],
  ['parserName', D, 'fdh_retirement_statements.parser'],
  ['parserVersion', D, 'fdh_retirement_statements.parser_version'],
  ['extractionConfidence', D, 'fdh_retirement_statements.extraction_confidence'],
  ['warnings', E, 'fdh_retirement_statements.extraction_warnings (0207)', null, R05],
];

const NATIVE_ACTIVITY: Row[] = [
  ...activity('camel'),
  ['currencyCode', C, HISTORY, null, R03],
  ['effectivePeriodStart', C, HISTORY, null, R03],
  ['effectivePeriodEnd', C, HISTORY, null, R03],
  ['sourceRowNumber', D, 'fdh_retirement_statement_activities.source_row_number'],
];

const NATIVE_POSITION: Row[] = [
  ...position('camel'),
  ['tickerRaw', C, HOLDINGS, null, R04],
  ['isin', C, HOLDINGS, null, R04],
  ['currencyCode', C, HOLDINGS, null, R04],
  ['sourceRowNumber', D, 'fdh_retirement_statement_positions.source_row_number'],
];

const AI_DOC: Row[] = [
  ['schemaVersion', D, 'aie run evidence'],
  ['documentMissingReasonCode', D, 'aie run evidence'],
  ...header('camel'),
  ['activities', C, HISTORY, null, R03],
  ['positions', C, HOLDINGS, null, R03],
];

const TYPES: Row[] = [
  ['EMPLOYER_CONTRIBUTION', C, HISTORY + '; payslip + fund are ONE effect, never income', null, R03],
  ['PERSONAL_CONTRIBUTION', C, HISTORY + '; the matched bank debit is a transfer (user-confirmed)', null, R07],
  ['SALARY_SACRIFICE', C, HISTORY, null, R03],
  ['GOVERNMENT_CONTRIBUTION', C, HISTORY, null, R03],
  ['ROLLOVER_IN', C, HISTORY + '; fund A -> fund B is income 0 / expense 0 / net worth 0', null, R04],
  ['ROLLOVER_OUT', C, HISTORY + '; neutral', null, R04],
  ['INVESTMENT_EARNINGS', C, HISTORY, null, R03],
  ['INTEREST', C, HISTORY, null, R03],
  ['DISTRIBUTION', C, HISTORY, null, R03],
  ['FEE', C, HISTORY + '; never a household expense', null, R03],
  ['INSURANCE_PREMIUM', C, HISTORY, null, R03],
  ['TAX', C, HISTORY, null, R03],
  ['PENSION_PAYMENT', C, HISTORY + '; household income via the bank credit, once', null, R07],
  ['WITHDRAWAL', C, HISTORY + '; the bank credit is a transfer / retirement income (user-confirmed)', null, R07],
  ['ADJUSTMENT', C, HISTORY + '; shown for review', null, R05],
  ['OTHER', C, HISTORY + '; shown for review', null, R05],
  ['UNKNOWN', C, HISTORY + '; shown for review, never classified silently', null, R05],
];

const STATEMENTS: Row[] = [
  ...technical(['id', 'user_id', 'household_id', 'statement_upload_id', 'canonical_account_id'], 'fdh_retirement_statements'),
  ['retirement_member_id', A, 'retirement_accounts.retirement_member_id', RT],
  ['statement_type', D, 'fdh_retirement_statements.statement_type'],
  ['retirement_jurisdiction', D, 'fdh_retirement_statements.retirement_jurisdiction'],
  ['account_type', A, 'retirement_accounts.account_type', RT],
  ['nickname', E, 'not persisted as a canonical fact', null, R03],
  ['currency_code', A, 'retirement_accounts.currency_code', RT],
  ...header('snake'),
  ['ytd_employer_contributions', C, EV('ytd_employer_contributions'), null, R04],
  ['ytd_personal_contributions', C, EV('ytd_personal_contributions'), null, R04],
  ...technical(['parser', 'parser_version', 'extraction_confidence', 'extraction_status'], 'fdh_retirement_statements'),
  ['reconciliation_status', D, 'fdh_retirement_statements.reconciliation_status (INSERT-forgeable until 0211)', null, R09],
  ...technical(['reconciliation_variance', 'account_match_status', 'account_match_candidates', 'smsf_classification', 'smsf_evidence', 'review_status'], 'fdh_retirement_statements'),
  ['approval_status', D, 'fdh_retirement_statements.approval_status (INSERT-forgeable until 0211)', null, R09],
  ...technical(['approved_at', 'approved_by', 'duplicate_of_statement_id', 'supersedes_statement_id', 'source_provenance', 'created_at', 'updated_at'], 'fdh_retirement_statements'),
  ['extraction_warnings', E, 'fdh_retirement_statements.extraction_warnings (0207)', null, R05],
];

const ACTIVITIES: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_retirement_statement_activities'),
  ...activity('snake'),
  ['effective_period_start', C, HISTORY, null, R03],
  ['effective_period_end', C, HISTORY, null, R03],
  ['currency_code', C, HISTORY, null, R03],
  ...technical(['employer_normalised', 'payslip_match_status', 'matched_payroll_event_id', 'payslip_match_variance', 'payslip_match_candidates'], 'fdh_retirement_statement_activities'),
  ['bank_match_status', D, 'fdh_retirement_statement_activities.bank_match_status', null, R07],
  ['linked_transaction_id', D, 'the matched bank leg (reclassified only with the user\'s confirmation)', null, R07],
  ...technical(['bank_match_candidates', 'rollover_counterpart_activity_id', 'rollover_match_status', 'review_status', 'activity_fingerprint', 'duplicate_of_activity_id', 'source_row_number', 'created_at', 'updated_at'], 'fdh_retirement_statement_activities'),
];

const POSITIONS: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_retirement_statement_positions'),
  ...position('snake'),
  ['ticker_raw', C, HOLDINGS, null, R04],
  ['isin', C, HOLDINGS, null, R04],
  ['currency_code', C, HOLDINGS, null, R04],
  ...technical(['source_row_number', 'created_at', 'updated_at'], 'fdh_retirement_statement_positions'),
];

export const retirementStatementRegistry: RegistryFile = {
  id: 'retirementStatement',
  ownerWp: 'WP-13',
  OPEN_GAP_CEILING: 128,
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
