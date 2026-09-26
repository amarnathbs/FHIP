/**
 * Field dispositions -- AU broker / investment statements (FDH-11) into
 * Investment Intelligence (ii_*) -- never a parallel FDH portfolio. Owner:
 * WP-12. Matrix section 4.
 */
import { A, B, C, D, E, gap, rows, technical, type Row } from './build';
import type { RegistryFile } from './types';

const INVG1 = gap('INV-G1', 'P0', 'WP-12');
const INVG2 = gap('INV-G2', 'P0', 'WP-12');
const INVG3 = gap('INV-G3', 'P0', 'WP-12');
const INVG4 = gap('INV-G4', 'P1', 'WP-12');
const INVG6 = gap('INV-G6', 'P1', 'WP-12');
const INVG7 = gap('INV-G7', 'P2', 'WP-12');
const INVG8 = gap('INV-G8', 'P2', 'WP-12');
const INVG9 = gap('INV-G9', 'P2', 'WP-12');
const INVG11 = gap('INV-G11', 'P3', 'WP-12');

const IIS = 'Investment Intelligence screens';
const EV = (col: string) => `evidence:fdh_investment_statements.${col}`;

function position(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('securityNameRaw', 'security_name_raw'), A, 'ii_instruments.instrument_name ("Create security")', null, INVG3],
    [f('tickerRaw', 'ticker_raw'), A, 'ii_instrument_identifiers (match input)', IIS],
    ['isin', A, 'ii_instrument_identifiers (match input)', IIS],
    ['quantity', A, 'ii_holding_snapshots.units', null, INVG2],
    [f('unitPrice', 'unit_price'), A, 'ii_holding_snapshots.source_nav (price_source statement_price)', null, INVG7],
    [f('marketValue', 'market_value'), A, 'ii_holding_snapshots.value (null refused, never 0)', null, INVG7],
    [f('valuationDate', 'valuation_date'), A, 'ii_holding_snapshots.as_of_date (parsed)', null, INVG6],
  ];
}

function activity(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('transactionType', 'activity_type'), B, 'ii_transactions.transaction_type (+ bank leg corroboration)', null, INVG4],
    [f('tradeDate', 'trade_date'), B, 'ii_transactions.transaction_date', IIS],
    [f('settlementDate', 'settlement_date'), C, 'evidence:fdh_investment_statement_activities.settlement_date (import history)', null, INVG7],
    [f('securityNameRaw', 'security_name_raw'), A, 'ii_instruments (match input)', IIS],
    [f('tickerRaw', 'ticker_raw'), A, 'ii_instrument_identifiers (match input)', IIS],
    ['quantity', B, 'ii_transactions.units', IIS],
    [f('unitPrice', 'unit_price'), B, 'ii_transactions.price_per_unit', IIS],
    ['amount', B, 'ii_transactions.gross_amount', IIS],
  ];
}

const NATIVE: Row[] = [
  ['statementType', C, EV('statement_type') + ' (import history)', null, INVG9],
  ['country', D, 'fdh_investment_statements.investment_jurisdiction'],
  ['currencyCode', A, 'ii_accounts.currency_code', IIS],
  ['institutionName', A, 'ii_accounts.institution_name', IIS],
  ['maskedAccountIdentifier', A, 'ii_accounts.account_number_masked ("Add as new account")', null, INVG3],
  ['nickname', E, 'not persisted as a canonical fact', null, INVG9],
  ['statementDate', C, EV('statement_date'), null, INVG9],
  ['statementPeriodStart', C, EV('statement_start_date'), null, INVG9],
  ['statementPeriodEnd', C, EV('statement_end_date'), null, INVG9],
  ['openingPortfolioValue', C, EV('opening_portfolio_value') + ' (reconciliation input)', null, INVG8],
  ['closingPortfolioValue', C, EV('closing_portfolio_value') + ' (reconciliation input)', null, INVG8],
  ['cashBalance', E, 'broker cash unsupported for now (D-11), shown with visible text', null, INVG8],
  ['positions', A, 'ii_holding_snapshots', null, INVG2],
  ['transactions', B, 'ii_transactions', null, INVG1],
  ['parserName', D, 'fdh_investment_statements.parser'],
  ['parserVersion', D, 'fdh_investment_statements.parser_version'],
  ['extractionConfidence', D, 'fdh_investment_statements.extraction_confidence'],
  ['warnings', E, 'fdh_investment_statements.extraction_warnings (0207)', null, INVG6],
];

const NATIVE_POSITION: Row[] = [
  ...position('camel'),
  ['exchange', A, 'ii_instrument_identifiers (defaults ASX)', IIS],
  ['currencyCode', A, 'ii_holding_snapshots.currency_code', IIS],
  ['sourceRowNumber', D, 'fdh_investment_statement_positions.source_row_number'],
];

const NATIVE_TXN: Row[] = [
  ...activity('camel'),
  ['isin', A, 'ii_instrument_identifiers (match input)', IIS],
  ['currencyCode', B, 'ii_transactions.currency_code', IIS],
  ['descriptionRaw', C, 'ii_transactions.source_description', null, INVG7],
  ['brokerageRaw', B, 'ii_transactions.fees (parsed)', null, INVG7],
  ['frankingCreditRaw', C, 'evidence: franking credit (tax), visible', null, INVG7],
  ['withholdingTaxRaw', C, 'ii_transactions.taxes', null, INVG7],
  ['sourceRowNumber', D, 'fdh_investment_statement_activities.source_row_number'],
];

const AI_DOC: Row[] = [
  ['schemaVersion', D, 'aie run evidence'],
  ['documentMissingReasonCode', D, 'aie run evidence'],
  ['institutionName', A, 'ii_accounts.institution_name', IIS],
  ['statementDate', C, EV('statement_date'), null, INVG9],
  ['statementPeriodStart', C, EV('statement_start_date'), null, INVG9],
  ['statementPeriodEnd', C, EV('statement_end_date'), null, INVG9],
  ['allRowsListed', E, 'incomplete extraction must block Apply (40-row cap)', null, INVG11],
  ['holdings', A, 'ii_holding_snapshots', null, INVG2],
  ['transactions', B, 'ii_transactions', null, INVG1],
];

const AI_HOLDING: Row[] = position('camel');
const AI_ACTIVITY: Row[] = [...activity('camel'), ['brokerage', B, 'ii_transactions.fees', null, INVG7]];

const TYPES: Row[] = [
  ['BUY', B, 'ii_transactions(purchase); the bank funding leg is investment (spending 0)', null, INVG4],
  ['SELL', B, 'ii_transactions(sale); the bank proceeds leg is asset_sale (ordinary income 0)', null, INVG4],
  ['DIVIDEND', B, 'ii_transactions(dividend); the bank credit is the single household-income leg', null, INVG4],
  ['DISTRIBUTION', B, 'ii_transactions(distribution subtype; today recorded as dividend)', null, INVG7],
  ['INTEREST', E, 'broker cash interest: skipped, reason shown (D-11)', null, INVG8],
  ['BROKERAGE', B, 'ii_transactions(fee)', IIS],
  ['FEE', B, 'ii_transactions(fee)', IIS],
  ['TRANSFER_IN', B, 'ii_transactions(transfer_in)', IIS],
  ['TRANSFER_OUT', B, 'ii_transactions(transfer_out)', IIS],
  ['CASH_DEPOSIT', E, 'broker cash: skipped, reason shown (D-11)', null, INVG8],
  ['CASH_WITHDRAWAL', E, 'broker cash: skipped, reason shown (D-11)', null, INVG8],
  ['DRP', B, 'ii_transactions(reinvestment)', IIS],
  ['CORPORATE_ACTION_EVIDENCE', E, 'skipped; the reason must be shown', null, INVG9],
  ['OTHER', E, 'skipped; the reason must be shown', null, INVG9],
  ['UNKNOWN', E, 'skipped; the reason must be shown', null, INVG9],
];

const STATEMENTS: Row[] = [
  ...technical(['id', 'user_id', 'household_id', 'statement_upload_id', 'canonical_account_id'], 'fdh_investment_statements'),
  ['statement_type', C, EV('statement_type'), null, INVG9],
  ['investment_jurisdiction', D, 'fdh_investment_statements.investment_jurisdiction'],
  ['institution_name', A, 'ii_accounts.institution_name', IIS],
  ['masked_account_identifier', A, 'ii_accounts.account_number_masked', null, INVG3],
  ['nickname', E, 'never set', null, INVG9],
  ['base_currency', A, 'ii_accounts.currency_code', IIS],
  ['statement_date', C, EV('statement_date'), null, INVG9],
  ['statement_start_date', C, EV('statement_start_date'), null, INVG9],
  ['statement_end_date', C, EV('statement_end_date'), null, INVG9],
  ['opening_portfolio_value', C, EV('opening_portfolio_value'), null, INVG8],
  ['closing_portfolio_value', C, EV('closing_portfolio_value'), null, INVG8],
  ['cash_balance', E, 'broker cash unsupported for now (D-11)', null, INVG8],
  ...technical(['parser', 'parser_version', 'extraction_confidence', 'extraction_status'], 'fdh_investment_statements'),
  ['reconciliation_status', D, 'fdh_investment_statements.reconciliation_status (computed at persist)', null, INVG6],
  ...technical(['review_status', 'approval_status', 'approved_at', 'approved_by', 'duplicate_of_statement_id', 'supersedes_statement_id', 'source_provenance', 'created_at', 'updated_at'], 'fdh_investment_statements'),
  ['extraction_warnings', E, 'fdh_investment_statements.extraction_warnings (0207)', null, INVG6],
];

const POSITIONS: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_investment_statement_positions'),
  ...position('snake'),
  ['exchange', A, 'ii_instrument_identifiers', IIS],
  ['currency_code', A, 'ii_holding_snapshots.currency_code', IIS],
  ...technical(['security_match_status', 'matched_instrument_id'], 'fdh_investment_statement_positions'),
  ['apply_status', D, 'fdh_investment_statement_positions.apply_status (must start pending)', null, INVG2],
  ...technical(['canonical_holding_snapshot_id', 'applied_at', 'applied_by', 'source_row_number', 'created_at', 'updated_at'], 'fdh_investment_statement_positions'),
];

const ACTIVITIES: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_investment_statement_activities'),
  ...activity('snake'),
  ['isin', A, 'ii_instrument_identifiers', IIS],
  ['currency_code', B, 'ii_transactions.currency_code', IIS],
  ['description_raw', C, 'ii_transactions.source_description', null, INVG7],
  ['brokerage_raw', B, 'ii_transactions.fees', null, INVG7],
  ['franking_credit_raw', C, 'evidence: franking credit, visible', null, INVG7],
  ['withholding_tax_raw', C, 'ii_transactions.taxes', null, INVG7],
  ...technical(['security_match_status', 'matched_instrument_id'], 'fdh_investment_statement_activities'),
  ['linked_transaction_id', D, 'the corroborated bank leg', null, INVG4],
  ['bank_match_status', D, 'fdh_investment_statement_activities.bank_match_status', null, INVG4],
  ['bank_match_candidates', D, 'fdh_investment_statement_activities.bank_match_candidates', null, INVG4],
  ...technical(['review_status', 'apply_status', 'canonical_transaction_id', 'applied_at', 'applied_by'], 'fdh_investment_statement_activities'),
  ['apply_rejected_reason', E, 'the skip / rejection reason, rendered to the user', null, INVG9],
  ...technical(['source_row_number', 'created_at', 'updated_at'], 'fdh_investment_statement_activities'),
];

export const auInvestmentStatementRegistry: RegistryFile = {
  id: 'auInvestmentStatement',
  ownerWp: 'WP-12',
  OPEN_GAP_CEILING: 74,
  entries: [
    ...rows('au_investment_native', 'ts_interface', 'fdh:investment/types.ts#AuInvestmentStatementExtraction', NATIVE),
    ...rows('au_investment_native', 'ts_interface', 'fdh:investment/types.ts#AuStatementPositionEvidence', NATIVE_POSITION),
    ...rows('au_investment_native', 'ts_interface', 'fdh:investment/types.ts#AuStatementTransactionEvidence', NATIVE_TXN),
    ...rows('au_investment_ai', 'zod_schema', 'aie:auInvestment/schema.ts#auInvestmentDocumentFactsSchema', AI_DOC),
    ...rows('au_investment_ai', 'zod_schema', 'aie:auInvestment/schema.ts#auInvestmentHoldingSchema', AI_HOLDING),
    ...rows('au_investment_ai', 'zod_schema', 'aie:auInvestment/schema.ts#auInvestmentActivitySchema', AI_ACTIVITY),
    ...rows('au_investment_native', 'enum_value', 'enum:AU_STATEMENT_TRANSACTION_TYPES', TYPES),
    ...rows('au_investment_native', 'db_column', 'db:fdh_investment_statements', STATEMENTS),
    ...rows('au_investment_native', 'db_column', 'db:fdh_investment_statement_positions', POSITIONS),
    ...rows('au_investment_native', 'db_column', 'db:fdh_investment_statement_activities', ACTIVITIES),
  ],
};
