/**
 * Field dispositions -- AU broker / investment statements (FDH-11) into
 * Investment Intelligence (ii_*) -- never a parallel FDH portfolio. Owner:
 * WP-12. Matrix section 4.
 *
 * WP-12 closed every gap this file carried (INV-G1..G4, G6..G9, G11): Apply
 * now reaches ii_holding_snapshots / ii_transactions for a first-time user
 * (account + holder, "Create security", positions 'pending'), holdings are
 * certified and reach `investments` / Net Worth through the explicit "Add to
 * Net Worth" step (D-05), bank legs are corroborated and re-typed, every
 * numeric and date is parsed, warnings and skip reasons are persisted and
 * shown, and broker cash is shown as explicitly unsupported (D-11).
 */
import { A, B, C, D, E, rows, technical, type Row } from './build';
import type { RegistryFile } from './types';

/** Where an imported AU statement is visible to the user after Apply. */
const PANEL = 'AU import panel (statement review)';
const HISTORY = 'Investments tab: Imported statements';
const IIS = 'Investment Intelligence screens; Investments tab once added to Net Worth';
const NET_WORTH = 'Investments tab (Imported, not yet in Net Worth, then the Investments grid after "Add to Net Worth")';
const SKIPS = 'AU import panel Apply results + Investments tab: Imported statements ("Why N lines were kept as evidence only")';
const EV = (col: string) => `evidence:fdh_investment_statements.${col}`;

function position(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('securityNameRaw', 'security_name_raw'), A, 'ii_instruments.instrument_name ("Create security")', PANEL],
    [f('tickerRaw', 'ticker_raw'), A, 'ii_instrument_identifiers (match input)', IIS],
    ['isin', A, 'ii_instrument_identifiers (match input)', IIS],
    ['quantity', A, 'ii_holding_snapshots.units', NET_WORTH],
    [f('unitPrice', 'unit_price'), A, 'ii_holding_snapshots.source_nav (price_source statement_price)', NET_WORTH],
    [f('marketValue', 'market_value'), A, 'ii_holding_snapshots.value (null refused with a visible reason, never 0)', NET_WORTH],
    [f('valuationDate', 'valuation_date'), A, 'ii_holding_snapshots.as_of_date (parsed; unreadable -> statement date + warning)', NET_WORTH],
  ];
}

function activity(style: 'camel' | 'snake'): Row[] {
  const f = (camel: string, snake: string) => (style === 'camel' ? camel : snake);
  return [
    [f('transactionType', 'activity_type'), B, 'ii_transactions.transaction_type (+ the corroborated bank leg re-typed via fdh_transactions)', IIS],
    [f('tradeDate', 'trade_date'), B, 'ii_transactions.transaction_date', IIS],
    [f('settlementDate', 'settlement_date'), C, 'evidence:fdh_investment_statement_activities.settlement_date', PANEL],
    [f('securityNameRaw', 'security_name_raw'), A, 'ii_instruments (match input)', IIS],
    [f('tickerRaw', 'ticker_raw'), A, 'ii_instrument_identifiers (match input)', IIS],
    ['quantity', B, 'ii_transactions.units', IIS],
    [f('unitPrice', 'unit_price'), B, 'ii_transactions.price_per_unit', IIS],
    ['amount', B, 'ii_transactions.gross_amount', IIS],
  ];
}

const NATIVE: Row[] = [
  ['statementType', C, EV('statement_type'), HISTORY],
  ['country', D, 'fdh_investment_statements.investment_jurisdiction'],
  ['currencyCode', A, 'ii_accounts.currency_code', IIS],
  ['institutionName', A, 'ii_accounts.institution_name', IIS],
  ['maskedAccountIdentifier', A, 'ii_accounts.account_number_masked ("Add as new account")', PANEL],
  ['nickname', D, 'fdh_investment_statements.nickname (no extractor sets it; never a financial fact)'],
  ['statementDate', C, EV('statement_date'), `${PANEL}; ${HISTORY}`],
  ['statementPeriodStart', C, EV('statement_start_date'), `${PANEL}; ${HISTORY}`],
  ['statementPeriodEnd', C, EV('statement_end_date'), `${PANEL}; ${HISTORY}`],
  ['openingPortfolioValue', C, EV('opening_portfolio_value') + ' (from an "Opening value" line)', PANEL],
  ['closingPortfolioValue', C, EV('closing_portfolio_value') + ' (from a "Total" line; reconciles the holdings)', PANEL],
  ['cashBalance', E, 'broker cash unsupported for now (D-11): stored as evidence, never counted', `${PANEL}; ${HISTORY}`],
  ['positions', A, 'ii_holding_snapshots', NET_WORTH],
  ['transactions', B, 'ii_transactions', IIS],
  ['parserName', D, 'fdh_investment_statements.parser'],
  ['parserVersion', D, 'fdh_investment_statements.parser_version'],
  ['extractionConfidence', D, 'fdh_investment_statements.extraction_confidence'],
  ['warnings', E, 'fdh_investment_statements.extraction_warnings (0207): "N rows could not be read"', `${PANEL}; ${HISTORY}`],
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
  ['descriptionRaw', B, 'ii_transactions.source_description (DISTRIBUTION keeps its name here)', IIS],
  ['brokerageRaw', B, 'ii_transactions.fees (parsed)', IIS],
  ['frankingCreditRaw', C, 'evidence:fdh_investment_statement_activities.franking_credit_raw (tax evidence, parsed)', PANEL],
  ['withholdingTaxRaw', B, 'ii_transactions.taxes (parsed)', IIS],
  ['sourceRowNumber', D, 'fdh_investment_statement_activities.source_row_number (+ in-statement occurrence in the fingerprint)'],
];

const AI_DOC: Row[] = [
  ['schemaVersion', D, 'aie run evidence'],
  ['documentMissingReasonCode', D, 'aie run evidence'],
  ['institutionName', A, 'ii_accounts.institution_name', IIS],
  ['statementDate', C, EV('statement_date'), `${PANEL}; ${HISTORY}`],
  ['statementPeriodStart', C, EV('statement_start_date'), `${PANEL}; ${HISTORY}`],
  ['statementPeriodEnd', C, EV('statement_end_date'), `${PANEL}; ${HISTORY}`],
  ['allRowsListed', C, 'fdh_investment_statements.extraction_warnings: ai_reported_rows_incomplete (40-row cap), persisted at confirm', `${PANEL} (draft and saved statement)`],
  ['holdings', A, 'ii_holding_snapshots', NET_WORTH],
  ['transactions', B, 'ii_transactions', IIS],
];

const AI_HOLDING: Row[] = position('camel');
const AI_ACTIVITY: Row[] = [...activity('camel'), ['brokerage', B, 'ii_transactions.fees', IIS]];

const TYPES: Row[] = [
  ['BUY', B, 'ii_transactions(purchase); the corroborated bank funding leg -> investment (spending 0)', IIS],
  ['SELL', B, 'ii_transactions(sale); the corroborated bank proceeds leg -> asset_sale (ordinary income 0)', IIS],
  ['DIVIDEND', B, 'ii_transactions(dividend); the bank credit stays the single household-income leg (corroboration only)', IIS],
  ['DISTRIBUTION', B, 'ii_transactions(dividend, source_description DISTRIBUTION); bank credit = the one income leg', IIS],
  ['INTEREST', E, 'broker cash interest: skipped with the D-11 reason', SKIPS],
  ['BROKERAGE', B, 'ii_transactions(fee); a line naming no security is skipped with a reason', IIS],
  ['FEE', B, 'ii_transactions(fee); a line naming no security is skipped with a reason', IIS],
  ['TRANSFER_IN', B, 'ii_transactions(transfer_in)', IIS],
  ['TRANSFER_OUT', B, 'ii_transactions(transfer_out)', IIS],
  ['CASH_DEPOSIT', E, 'broker cash: skipped with the D-11 reason; the bank leg -> investment (spending 0)', SKIPS],
  ['CASH_WITHDRAWAL', E, 'broker cash: skipped with the D-11 reason; the bank leg -> transfer (income 0)', SKIPS],
  ['DRP', B, 'ii_transactions(reinvestment)', IIS],
  ['CORPORATE_ACTION_EVIDENCE', E, 'never auto-applied: skipped with a reason', SKIPS],
  ['OTHER', E, 'skipped with a reason', SKIPS],
  ['UNKNOWN', E, 'skipped with a reason', SKIPS],
];

const STATEMENTS: Row[] = [
  ...technical(['id', 'user_id', 'household_id', 'statement_upload_id', 'canonical_account_id'], 'fdh_investment_statements'),
  ['statement_type', C, EV('statement_type'), HISTORY],
  ['investment_jurisdiction', D, 'fdh_investment_statements.investment_jurisdiction'],
  ['institution_name', A, 'ii_accounts.institution_name', IIS],
  ['masked_account_identifier', A, 'ii_accounts.account_number_masked', PANEL],
  ['nickname', D, 'fdh_investment_statements.nickname (no extractor sets it)'],
  ['base_currency', A, 'ii_accounts.currency_code', IIS],
  ['statement_date', C, EV('statement_date'), `${PANEL}; ${HISTORY}`],
  ['statement_start_date', C, EV('statement_start_date'), `${PANEL}; ${HISTORY}`],
  ['statement_end_date', C, EV('statement_end_date'), `${PANEL}; ${HISTORY}`],
  ['opening_portfolio_value', C, EV('opening_portfolio_value'), PANEL],
  ['closing_portfolio_value', C, EV('closing_portfolio_value'), PANEL],
  ['cash_balance', E, 'broker cash unsupported for now (D-11): shown, never counted', `${PANEL}; ${HISTORY}`],
  ...technical(['parser', 'parser_version', 'extraction_confidence', 'extraction_status'], 'fdh_investment_statements'),
  ['reconciliation_status', D, 'fdh_investment_statements.reconciliation_status (statement totals, computed at persist; shown in the panel)'],
  ...technical(['review_status', 'approval_status', 'approved_at', 'approved_by', 'duplicate_of_statement_id', 'supersedes_statement_id', 'source_provenance', 'created_at', 'updated_at'], 'fdh_investment_statements'),
  ['extraction_warnings', E, 'fdh_investment_statements.extraction_warnings (0207)', `${PANEL}; ${HISTORY}`],
];

const POSITIONS: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_investment_statement_positions'),
  ...position('snake'),
  ['exchange', A, 'ii_instrument_identifiers', IIS],
  ['currency_code', A, 'ii_holding_snapshots.currency_code', IIS],
  ...technical(['security_match_status', 'matched_instrument_id'], 'fdh_investment_statement_positions'),
  ['apply_status', D, "fdh_investment_statement_positions.apply_status (created 'pending'; 0213 default + backfill)"],
  ['apply_rejected_reason', E, 'fdh_investment_statement_positions.apply_rejected_reason (0213): why a holding was not added', SKIPS],
  ...technical(['canonical_holding_snapshot_id', 'applied_at', 'applied_by', 'source_row_number', 'created_at', 'updated_at'], 'fdh_investment_statement_positions'),
];

const ACTIVITIES: Row[] = [
  ...technical(['id', 'user_id', 'statement_id'], 'fdh_investment_statement_activities'),
  ...activity('snake'),
  ['isin', A, 'ii_instrument_identifiers', IIS],
  ['currency_code', B, 'ii_transactions.currency_code', IIS],
  ['description_raw', B, 'ii_transactions.source_description', IIS],
  ['brokerage_raw', B, 'ii_transactions.fees', IIS],
  ['franking_credit_raw', C, 'evidence:fdh_investment_statement_activities.franking_credit_raw', PANEL],
  ['withholding_tax_raw', B, 'ii_transactions.taxes', IIS],
  ...technical(['security_match_status', 'matched_instrument_id'], 'fdh_investment_statement_activities'),
  ['linked_transaction_id', D, 'the corroborated bank leg (fdh_transactions; one-to-one, re-verified by the read models)'],
  ['bank_match_status', D, 'fdh_investment_statement_activities.bank_match_status (shown as "bank payment found")'],
  ['bank_match_candidates', D, 'fdh_investment_statement_activities.bank_match_candidates'],
  ...technical(['review_status', 'apply_status', 'canonical_transaction_id', 'applied_at', 'applied_by'], 'fdh_investment_statement_activities'),
  ['apply_rejected_reason', E, 'the skip / rejection reason, rendered to the user', SKIPS],
  ...technical(['source_row_number', 'created_at', 'updated_at'], 'fdh_investment_statement_activities'),
];

export const auInvestmentStatementRegistry: RegistryFile = {
  id: 'auInvestmentStatement',
  ownerWp: 'WP-12',
  OPEN_GAP_CEILING: 0,
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
