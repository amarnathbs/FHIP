// Investment Intelligence R2 — the parser architecture (spec section 8):
// "Create a parser registry/interface conceptually named
// InvestmentDocumentParser ... Each parser must have: parser_code,
// parser_version, supported source, supported document type, supported
// format/version if detectable, extraction method, validation rules,
// confidence result. Do not build one giant parser full of
// provider-specific conditionals — use provider adapters."
//
// This file is the interface + shared value shapes both provider adapters
// (camsParser.ts, kfintechParser.ts) implement identically. Naming follows
// this codebase's existing investment-intelligence conventions (camelCase
// TS, "Ii" prefix for shared types) rather than the spec's exact
// verbatim-cased names, per the task instruction: "Actual naming should
// follow project conventions."

import type { IiParserCode, IiPlanType, IiOptionType, IiTransactionType } from '../types';

export type ParsedFieldSeverity = 'info' | 'warning' | 'error';

export interface ParsedWarning {
  code: string;
  message: string;
  severity: ParsedFieldSeverity;
  /** Line number in the extracted text this warning relates to, if known — never a page-image coordinate (R2 never does OCR/layout analysis). */
  lineHint?: number;
}

export interface SourceDetectionResult {
  sourceKey: string | null; // ii_sources.source_key, e.g. 'cams' | 'kfintech' — null when NOT confidently detected
  confidence: number; // 0..1
  documentTypeDetected: string | null; // e.g. 'cas_statement'
  formatVersionDetected: string | null; // e.g. 'detailed_v1' — the statement LAYOUT variant, not the parser's own code version
  evidenceMatched: string[]; // human-readable list of the specific headings/strings that produced this detection — for audit/debugging, never used to prove correctness on its own
}

export interface ParsedAccountRecord {
  folioNumber: string | null;
  accountNumberMasked: string | null;
  amcName: string; // the fund house / RTA-declared institution for this folio block
  holderName: string | null;
  panMasked: string | null; // e.g. "ABCDE****F" — NEVER a full PAN (spec section 16, 34)
  jointHolders: string[];
  holdingModeRaw: string | null; // 'SI' (single), 'JO' (joint), 'AS' (anyone or survivor) etc, verbatim as printed
  raw: string; // the exact source block this was parsed from, for provenance — never persisted verbatim to a log, only kept in-memory/DB evidence columns
}

export interface ParsedInstrumentRecord {
  rawSchemeName: string; // verbatim, e.g. "HDFC Flexi Cap Fund - Growth (Direct Plan)"
  normalisedSchemeName: string; // lower-cased, whitespace-collapsed, punctuation-normalised
  amcName: string;
  planType: IiPlanType;
  optionType: IiOptionType;
  isin: string | null;
  amfiSchemeCode: string | null;
}

export interface ParsedTransactionRecord {
  folioNumber: string | null; // links back to a ParsedAccountRecord
  scheme: ParsedInstrumentRecord;
  transactionDateIso: string;
  rawTransactionTypeText: string; // verbatim narrative/description, e.g. "SIP Purchase", "Switch In From ..."
  canonicalType: IiTransactionType;
  classificationConfidence: number; // 0..1 — 1.0 for an exact known keyword match, lower for a heuristic guess
  amountScaled: bigint; // exact decimal, see decimal.ts — gross amount, signed (debit/credit per source convention already normalised to: purchase/inflow positive, redemption/outflow negative... actually see R2_TRANSACTION_NORMALISATION.md for the exact sign convention)
  unitsScaled: bigint | null;
  navScaled: bigint | null;
  balanceUnitsAfterScaled: bigint | null; // running balance the statement prints after this line, if any — used by the reconciliation engine, never stored as a transaction field itself
  sourceReference: string | null;
  sourceDescription: string; // the raw statement line, verbatim, truncated defensively to a safe length before persistence
}

export interface ParsedHoldingRecord {
  folioNumber: string | null;
  scheme: ParsedInstrumentRecord;
  asOfDateIso: string;
  unitsScaled: bigint;
  valueScaled: bigint | null; // "Market Value"/"Valuation" as explicitly printed — null if the statement did not print one for this line
  navScaled: bigint | null; // "NAV as on ..." as explicitly printed
}

export interface ParseMetadata {
  sourceKey: string;
  sourceConfidence: number;
  documentTypeDetected: string;
  formatVersionDetected: string | null;
  statementPeriodStartIso: string | null;
  statementPeriodEndIso: string | null;
  statementAsOfDateIso: string | null;
  extractionMethod: string;
}

export interface ParsedDocumentOutput {
  parserCode: IiParserCode;
  parserVersion: string;
  metadata: ParseMetadata;
  accounts: ParsedAccountRecord[];
  transactions: ParsedTransactionRecord[];
  holdings: ParsedHoldingRecord[];
  warnings: ParsedWarning[];
  errors: ParsedWarning[];
  /** Overall parser confidence for this run — deterministic formula documented in R2_DATA_QUALITY_AND_CERTIFICATION.md, NOT a black box. */
  parserConfidence: number;
}

export interface ValidationOutcome {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface InvestmentDocumentParser {
  readonly parserCode: IiParserCode;
  readonly parserVersion: string;
  readonly supportedSource: string; // ii_sources.source_key
  readonly supportedDocumentType: string;

  /** Detect whether this parser can handle the given already-extracted document text, using document EVIDENCE (headings/RTA name/structure), never the filename (spec section 12). */
  canHandle(text: string): SourceDetectionResult;

  extractMetadata(text: string): ParseMetadata;
  parseAccounts(text: string): ParsedAccountRecord[];
  parseTransactions(text: string, accounts: ParsedAccountRecord[]): { transactions: ParsedTransactionRecord[]; warnings: ParsedWarning[] };
  parseHoldings(text: string, accounts: ParsedAccountRecord[]): { holdings: ParsedHoldingRecord[]; warnings: ParsedWarning[] };
  validateParsedOutput(output: ParsedDocumentOutput): ValidationOutcome;
}
