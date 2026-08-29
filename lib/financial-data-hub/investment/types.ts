/**
 * FDH-11 — Australia Investment Statement Intelligence: domain types.
 *
 * This module is part of the Financial Data Hub and therefore names NO
 * protected Input Data register and NO `ii_*` canonical Investment
 * Intelligence table directly (see `constants/tables.ts`'s
 * `FHIP_PROTECTED_INPUT_TABLES` / `II_OWNED_CANONICAL_ENTITIES` and
 * `tests/unit/fdh1Isolation.test.ts`, extended for FDH-11 in
 * `tests/unit/fdh11Isolation.test.ts`). Everything here is STATEMENT
 * EVIDENCE — an observation the AU broker/fund statement makes about
 * holdings and activity. It is never treated as an authoritative canonical
 * position (spec sections 24, 60-62). Turning approved evidence into real
 * `ii_accounts` / `ii_instruments` / `ii_transactions` / `ii_holding_snapshots`
 * rows is the job of `lib/investment-import-bridge/`, which lives outside
 * this tree for the same reason `lib/import-bridge/` does for income and
 * liabilities (FDH1_INVESTMENT_BOUNDARY.md section 6).
 *
 * Mirrors the shape FDH-10 established for liability-statement evidence
 * (`lib/financial-data-hub/liability/types.ts`) so the pipelines read the
 * same way to a future maintainer.
 */

export const AU_INVESTMENT_STATEMENT_COUNTRIES = ['AU'] as const;
export type AuInvestmentStatementCountry = (typeof AU_INVESTMENT_STATEMENT_COUNTRIES)[number];

/** Spec section 15. */
export const AU_INVESTMENT_STATEMENT_TYPES = [
  'broker_portfolio_statement',
  'broker_holdings_statement',
  'broker_transaction_statement',
  'broker_account_statement',
  'managed_fund_statement',
  'investment_transaction_csv',
  'portfolio_csv',
  'dividend_distribution_statement',
  'trade_confirmation',
] as const;
export type AuInvestmentStatementType = (typeof AU_INVESTMENT_STATEMENT_TYPES)[number];

/** Spec section 14 — initial supported Australian investment classes, kept
 * to what canonical Investment Intelligence already supports for direct
 * securities (`ii_instruments.instrument_class`: 'equity' | 'etf' — see
 * R12_ASSET_CLASS_SCOPE_MATRIX.md). Deliberately does NOT add bonds/REITs/
 * managed funds beyond what II already certifies (spec section 14: "do not
 * create new asset types merely to increase scope").
 */
export const AU_INSTRUMENT_CLASSES = ['equity', 'etf', 'managed_fund'] as const;
export type AuInstrumentClass = (typeof AU_INSTRUMENT_CLASSES)[number];

/** Spec section 16 — broker coverage classification. This module makes no
 * claim to support every AU brokerage; it is explicit about what it does. */
export const AU_BROKER_COVERAGE_STATES = [
  'certified',
  'supported_generic',
  'manual_mapping_required',
  'unsupported',
] as const;
export type AuBrokerCoverageState = (typeof AU_BROKER_COVERAGE_STATES)[number];

/** Spec section 25 — statement transaction evidence vocabulary. Deliberately
 * distinct from `ii_transactions.transaction_type` (the canonical unit
 * ledger's own vocabulary) and from `fdh_transactions.economic_transaction_type`
 * (the cash ledger's vocabulary) — this is what the SOURCE DOCUMENT calls the
 * line. Mapping to the canonical vocabularies happens in
 * `transactionClassification.ts` (statement -> II) and, for the bank leg,
 * FDH-6's `classifyTransaction()` (statement -> cash ledger), never assumed
 * to be the same axis as either. */
export const AU_STATEMENT_TRANSACTION_TYPES = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'DISTRIBUTION',
  'INTEREST',
  'BROKERAGE',
  'FEE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'CASH_DEPOSIT',
  'CASH_WITHDRAWAL',
  'DRP',
  'CORPORATE_ACTION_EVIDENCE',
  'OTHER',
  'UNKNOWN',
] as const;
export type AuStatementTransactionType = (typeof AU_STATEMENT_TRANSACTION_TYPES)[number];

export const RECONCILIATION_STATUSES = ['reconciled', 'variance', 'insufficient_data'] as const;
export type AuInvestmentReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const SECURITY_MATCH_STATUSES = [
  'matched', 'ambiguous', 'unresolved', 'not_attempted',
] as const;
export type SecurityMatchStatus = (typeof SECURITY_MATCH_STATUSES)[number];

export const ACCOUNT_MATCH_STATUSES = [
  'matched_existing', 'add_new', 'ambiguous', 'not_attempted',
] as const;
export type AccountMatchStatus = (typeof ACCOUNT_MATCH_STATUSES)[number];

export const BANK_MATCH_STATUSES = [
  'matched', 'no_match', 'multiple_candidates', 'not_attempted', 'bank_evidence_not_available',
] as const;
export type AuInvestmentBankMatchStatus = (typeof BANK_MATCH_STATUSES)[number];

/** One security/holding line read off an AU statement (spec section 24). */
export interface AuStatementPositionEvidence {
  securityNameRaw: string;
  tickerRaw?: string;
  exchange?: string;
  isin?: string;
  quantity: string; // exact decimal string — never a JS float (spec section 48/97)
  unitPrice?: string;
  marketValue?: string;
  currencyCode: string;
  valuationDate: string; // YYYY-MM-DD
  sourceRowNumber?: number;
}

/** One activity line read off an AU statement (spec section 25). */
export interface AuStatementTransactionEvidence {
  transactionType: AuStatementTransactionType;
  tradeDate?: string; // YYYY-MM-DD
  settlementDate?: string; // YYYY-MM-DD — preserved separately, never conflated (spec section 53)
  securityNameRaw?: string;
  tickerRaw?: string;
  isin?: string;
  quantity?: string;
  unitPrice?: string;
  /** Positive magnitude — direction/meaning is derived, never encoded here
   * (mirrors `fdh_transactions.amount_original`'s convention). */
  amount: string;
  currencyCode: string;
  descriptionRaw?: string;
  brokerageRaw?: string;
  frankingCreditRaw?: string;
  withholdingTaxRaw?: string;
  sourceRowNumber?: number;
}

/** The structured result of reading one AU investment statement. */
export interface AuInvestmentStatementExtraction {
  statementType: AuInvestmentStatementType;
  country: AuInvestmentStatementCountry;
  currencyCode: string;

  institutionName?: string;
  /** Masked/last-digits identifier only — never a full HIN/broker account
   * number (spec sections 20, 23). */
  maskedAccountIdentifier?: string;
  nickname?: string;

  statementDate?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;

  openingPortfolioValue?: string;
  closingPortfolioValue?: string;
  cashBalance?: string;

  positions: AuStatementPositionEvidence[];
  transactions: AuStatementTransactionEvidence[];

  parserName: string;
  parserVersion: string;
  extractionConfidence: number;
  warnings: string[];
}

export type AuInvestmentExtractionFailureKind =
  | 'scanned_document'
  | 'ocr_required'
  | 'password_required'
  | 'wrong_password'
  | 'corrupt'
  | 'layout_unsupported'
  | 'zero_holdings_suspected'
  /** No registered adapter's signature cleared the minimum-confidence bar
   * (spec section 16's MANUAL_MAPPING_REQUIRED outcome) — never silently
   * falls back to a guessed column mapping. */
  | 'manual_mapping_required'
  /** Two or more adapters scored within the confidence gap of each other. */
  | 'ambiguous_format'
  | 'unknown_error';

export interface AuInvestmentExtractionSuccess {
  ok: true;
  extraction: AuInvestmentStatementExtraction;
}
export interface AuInvestmentExtractionFailure {
  ok: false;
  kind: AuInvestmentExtractionFailureKind;
  error: string;
}
export type AuInvestmentExtractionResult = AuInvestmentExtractionSuccess | AuInvestmentExtractionFailure;
