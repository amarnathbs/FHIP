/**
 * FDH-11 — Australia Investment Statement Intelligence: generic CSV
 * extraction (spec sections 15-16, 90).
 *
 * SCOPE (honestly disclosed — see FDH11_REUSE_AND_GAP_AUDIT.md and
 * FDH11_AU_BROKER_ADAPTERS.md). This module implements ONE certified,
 * explicitly column-mapped "generic AU investment transaction CSV" layout
 * and ONE certified "generic AU portfolio/holdings CSV" layout — it does
 * NOT claim to recognise any specific named broker's actual export byte-for-
 * byte (CommSec/Selfwealth/CMC/Stake/nabtrade/Westpac/Macquarie all export
 * different real column sets that were not available as sample statements
 * for this pass — see the broker coverage matrix doc). What this module
 * reuses in full, per FDH-10's own established precedent: `parseCsvSafe`,
 * `parseAmountField`, `dateFormats.ts`'s inference — no new CSV parser, no
 * new amount grammar, no new date grammar.
 *
 * OCR BOUNDARY (spec section 22). A scanned/image-only statement has no CSV
 * form; `AuInvestmentExtractionFailureKind.ocr_required` exists in
 * `./types.ts` for the document pipeline to report when a PDF turns out to
 * be image-only, which this module cannot itself detect.
 */

import { decodeCsvBytes, detectDelimiter, findHeaderRowIndex, parseCsvSafe, CsvIntakeError } from '../bank-csv/csv';
import { parseAmountField } from '../bank-csv/amount';
import { inferDateFormat, parseDateWithFormat } from '../bank-csv/dateFormats';
import { CSV_HEADER_SCAN_DEPTH } from '../bank-csv/constants';
import { parseExactQuantity } from './quantity';
import {
  AU_STATEMENT_TRANSACTION_TYPES,
  type AuInvestmentExtractionResult,
  type AuStatementTransactionEvidence,
  type AuStatementTransactionType,
  type AuStatementPositionEvidence,
} from './types';

const TRANSACTION_PARSER_NAME = 'fdh11_generic_au_investment_transaction_csv';
const POSITION_PARSER_NAME = 'fdh11_generic_au_portfolio_csv';
export const FDH11_GENERIC_CSV_PARSER_VERSION = '1.0.0';

function isKnownTransactionType(v: string): v is AuStatementTransactionType {
  return (AU_STATEMENT_TRANSACTION_TYPES as readonly string[]).includes(v.toUpperCase());
}

/**
 * Canonical-upload WP-12 (INV-G6). Every numeric that reaches a numeric(20,4)
 * or numeric(20,6) evidence column is PARSED here, never passed through raw:
 * before this, one '$19.95' brokerage cell or one '1,234.50' market value
 * made the whole batch insert fail -- and that failure was swallowed, so the
 * statement showed "0 holdings". A cell that cannot be read is reported as a
 * row warning and left null (never 0).
 *
 *  - money (market value, brokerage, franking, withholding): FDH's own
 *    `parseAmountField` grammar ('$', ',', '(x)', '-x'), magnitude only;
 *  - unit prices: 6 dp, via the exact-quantity parser after stripping '$'/','.
 */
type CellParse = { ok: true; value: string | undefined } | { ok: false };

function parseMoneyCell(raw: string | undefined): CellParse {
  const s = (raw ?? '').trim();
  if (!s || s === '-' || s === '--') return { ok: true, value: undefined };
  const parsed = parseAmountField(s);
  if (!parsed.ok || parsed.magnitude === null) return { ok: false };
  return { ok: true, value: String(parsed.magnitude) };
}

function parsePriceCell(raw: string | undefined): CellParse {
  const s = (raw ?? '').trim().replace(/[$]/g, '').replace(/,/g, '').trim();
  if (!s || s === '-' || s === '--') return { ok: true, value: undefined };
  const q = parseExactQuantity(s);
  if (!q.ok) return { ok: false };
  return { ok: true, value: s };
}

/** Summary lines a portfolio export prints BELOW the holdings. They are
 * statement totals, not holdings, and must never become a position that then
 * blocks approval as an "unresolved security" (INV-G8). */
const CASH_ROW = /^(cash|cash balance|cash account|cash holding|settlement cash|cash management account|available cash)$/i;
const TOTAL_ROW = /^(total|total value|total portfolio|total portfolio value|portfolio total|portfolio value|closing value|closing balance|grand total)$/i;
const OPENING_ROW = /^(opening value|opening balance|opening portfolio value)$/i;

export interface AuTransactionCsvColumnMap {
  date: string;
  type: string;
  amount: string;
  ticker?: string;
  isin?: string;
  securityName?: string;
  quantity?: string;
  price?: string;
  brokerage?: string;
  settlementDate?: string;
  frankingCredit?: string;
  withholdingTax?: string;
  typeAliases?: Record<string, AuStatementTransactionType>;
}

export interface AuTransactionCsvExtractionInput {
  bytes: Uint8Array;
  columnMap: AuTransactionCsvColumnMap;
  currencyCode: string;
  institutionName?: string;
  maskedAccountIdentifier?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  statementDate?: string;
}

/**
 * Extract transaction evidence from a generic, explicitly column-mapped AU
 * investment transaction CSV. Every row's `type` column value must resolve
 * to the closed `AU_STATEMENT_TRANSACTION_TYPES` vocabulary (case-
 * insensitive, or via `typeAliases`) — an unrecognised value is neither
 * guessed nor silently dropped; it is surfaced as a warning (spec section
 * 25's UNKNOWN handling, never a silent omission).
 */
export function extractAuTransactionsFromCsv(input: AuTransactionCsvExtractionInput): AuInvestmentExtractionResult {
  const { text } = decodeCsvBytes(input.bytes);
  const lines = text.split(/\r\n|\n/);

  const delimiter = detectDelimiter(lines.slice(0, CSV_HEADER_SCAN_DEPTH));
  if (!delimiter) return { ok: false, kind: 'layout_unsupported', error: 'Could not detect the CSV delimiter.' };
  const headerRowIndex = findHeaderRowIndex(lines, delimiter, CSV_HEADER_SCAN_DEPTH);
  if (headerRowIndex === null) return { ok: false, kind: 'layout_unsupported', error: 'Could not find a header row in this CSV.' };

  let parsed;
  try {
    parsed = parseCsvSafe(text, delimiter, headerRowIndex);
  } catch (err) {
    if (err instanceof CsvIntakeError) return { ok: false, kind: 'layout_unsupported', error: err.message };
    return { ok: false, kind: 'unknown_error', error: err instanceof Error ? err.message : 'CSV could not be parsed' };
  }

  const { header, rows } = parsed;
  const colIndex = (name?: string): number => (name ? header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase()) : -1);

  const dateIdx = colIndex(input.columnMap.date);
  const typeIdx = colIndex(input.columnMap.type);
  const amountIdx = colIndex(input.columnMap.amount);
  if (dateIdx === -1 || typeIdx === -1 || amountIdx === -1) {
    return { ok: false, kind: 'layout_unsupported', error: 'One or more mapped columns were not found in the CSV header.' };
  }
  const tickerIdx = colIndex(input.columnMap.ticker);
  const isinIdx = colIndex(input.columnMap.isin);
  const nameIdx = colIndex(input.columnMap.securityName);
  const quantityIdx = colIndex(input.columnMap.quantity);
  const priceIdx = colIndex(input.columnMap.price);
  const brokerageIdx = colIndex(input.columnMap.brokerage);
  const settlementIdx = colIndex(input.columnMap.settlementDate);
  const frankingIdx = colIndex(input.columnMap.frankingCredit);
  const withholdingIdx = colIndex(input.columnMap.withholdingTax);

  const dateSamples = rows.slice(0, 20).map((r) => r[dateIdx]).filter(Boolean);
  const dateFormat = inferDateFormat(dateSamples);
  if (!dateFormat) return { ok: false, kind: 'layout_unsupported', error: 'Could not determine the date format used in this CSV.' };

  const aliasLookup = new Map<string, AuStatementTransactionType>();
  for (const [alias, canonical] of Object.entries(input.columnMap.typeAliases ?? {})) {
    aliasLookup.set(alias.trim().toLowerCase(), canonical);
  }

  const transactions: AuStatementTransactionEvidence[] = [];
  const warnings: string[] = [];

  rows.forEach((row, i) => {
    const rawType = (row[typeIdx] ?? '').trim();
    if (!rawType) return;
    const aliased = aliasLookup.get(rawType.toLowerCase());
    if (!aliased && !isKnownTransactionType(rawType)) {
      warnings.push(`row_${i + 1}_unrecognised_transaction_type_${rawType}`);
      return;
    }
    const transactionType = aliased ?? (rawType.toUpperCase() as AuStatementTransactionType);

    const dateResult = parseDateWithFormat(row[dateIdx] ?? '', dateFormat.format);
    if (!dateResult.ok || !dateResult.iso) {
      warnings.push(`row_${i + 1}_unparseable_date`);
      return;
    }

    const amountResult = parseAmountField(row[amountIdx] ?? '');
    if (!amountResult.ok || amountResult.magnitude === null) {
      warnings.push(`row_${i + 1}_unparseable_amount`);
      return;
    }

    let quantity: string | undefined;
    if (quantityIdx >= 0 && row[quantityIdx]) {
      const q = parseExactQuantity(row[quantityIdx].replace(/,/g, ''));
      if (q.ok) quantity = row[quantityIdx].replace(/,/g, '').trim();
      else warnings.push(`row_${i + 1}_unparseable_quantity`);
    }

    let settlementDate: string | undefined;
    if (settlementIdx >= 0 && row[settlementIdx]) {
      const sd = parseDateWithFormat(row[settlementIdx], dateFormat.format);
      if (sd.ok && sd.iso) settlementDate = sd.iso;
      else warnings.push(`row_${i + 1}_unparseable_settlement_date`);
    }

    // INV-G6: parsed, never raw (see parseMoneyCell). An unreadable cell is a
    // visible row warning and a null value, never a failed batch.
    const cell = (idx: number) => (idx >= 0 ? row[idx] : undefined);
    const price = parsePriceCell(cell(priceIdx));
    if (!price.ok) warnings.push(`row_${i + 1}_unparseable_price`);
    const brokerage = parseMoneyCell(cell(brokerageIdx));
    if (!brokerage.ok) warnings.push(`row_${i + 1}_unparseable_brokerage`);
    const franking = parseMoneyCell(cell(frankingIdx));
    if (!franking.ok) warnings.push(`row_${i + 1}_unparseable_franking_credit`);
    const withholding = parseMoneyCell(cell(withholdingIdx));
    if (!withholding.ok) warnings.push(`row_${i + 1}_unparseable_withholding_tax`);

    transactions.push({
      transactionType,
      tradeDate: dateResult.iso,
      settlementDate,
      securityNameRaw: nameIdx >= 0 ? row[nameIdx] || undefined : undefined,
      tickerRaw: tickerIdx >= 0 ? row[tickerIdx] || undefined : undefined,
      isin: isinIdx >= 0 ? row[isinIdx] || undefined : undefined,
      quantity,
      unitPrice: price.ok ? price.value : undefined,
      amount: String(amountResult.magnitude),
      currencyCode: input.currencyCode,
      descriptionRaw: rawType,
      brokerageRaw: brokerage.ok ? brokerage.value : undefined,
      frankingCreditRaw: franking.ok ? franking.value : undefined,
      withholdingTaxRaw: withholding.ok ? withholding.value : undefined,
      sourceRowNumber: i + 1,
    });
  });

  return {
    ok: true,
    extraction: {
      statementType: 'investment_transaction_csv',
      country: 'AU',
      currencyCode: input.currencyCode,
      institutionName: input.institutionName,
      maskedAccountIdentifier: input.maskedAccountIdentifier,
      statementPeriodStart: input.statementPeriodStart,
      statementPeriodEnd: input.statementPeriodEnd,
      statementDate: input.statementDate,
      positions: [],
      transactions,
      parserName: TRANSACTION_PARSER_NAME,
      parserVersion: FDH11_GENERIC_CSV_PARSER_VERSION,
      extractionConfidence: warnings.length === 0 ? 0.95 : 0.7,
      warnings,
    },
  };
}

export interface AuPositionCsvColumnMap {
  ticker?: string;
  isin?: string;
  securityName: string;
  quantity: string;
  unitPrice?: string;
  marketValue?: string;
  valuationDate?: string;
}

export interface AuPositionCsvExtractionInput {
  bytes: Uint8Array;
  columnMap: AuPositionCsvColumnMap;
  currencyCode: string;
  institutionName?: string;
  maskedAccountIdentifier?: string;
  statementDate?: string;
  defaultValuationDate: string;
}

/** Extract holdings/position evidence from a generic AU portfolio CSV (spec
 * section 15's "Portfolio CSV" / "Broker holdings statement" evidence
 * types). Zero rows is reported as a warning, never silently accepted as "0
 * holdings" (spec section 22: never show $0 portfolio as successful
 * extraction when the real cause is a layout the parser could not read). */
export function extractAuPositionsFromCsv(input: AuPositionCsvExtractionInput): AuInvestmentExtractionResult {
  const { text } = decodeCsvBytes(input.bytes);
  const lines = text.split(/\r\n|\n/);

  const delimiter = detectDelimiter(lines.slice(0, CSV_HEADER_SCAN_DEPTH));
  if (!delimiter) return { ok: false, kind: 'layout_unsupported', error: 'Could not detect the CSV delimiter.' };
  const headerRowIndex = findHeaderRowIndex(lines, delimiter, CSV_HEADER_SCAN_DEPTH);
  if (headerRowIndex === null) return { ok: false, kind: 'layout_unsupported', error: 'Could not find a header row in this CSV.' };

  let parsed;
  try {
    parsed = parseCsvSafe(text, delimiter, headerRowIndex);
  } catch (err) {
    if (err instanceof CsvIntakeError) return { ok: false, kind: 'layout_unsupported', error: err.message };
    return { ok: false, kind: 'unknown_error', error: err instanceof Error ? err.message : 'CSV could not be parsed' };
  }

  const { header, rows } = parsed;
  const colIndex = (name?: string): number => (name ? header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase()) : -1);

  const nameIdx = colIndex(input.columnMap.securityName);
  const quantityIdx = colIndex(input.columnMap.quantity);
  if (nameIdx === -1 || quantityIdx === -1) {
    return { ok: false, kind: 'layout_unsupported', error: 'One or more mapped columns were not found in the CSV header.' };
  }
  const tickerIdx = colIndex(input.columnMap.ticker);
  const isinIdx = colIndex(input.columnMap.isin);
  const priceIdx = colIndex(input.columnMap.unitPrice);
  const valueIdx = colIndex(input.columnMap.marketValue);
  const valuationDateIdx = colIndex(input.columnMap.valuationDate);

  const positions: AuStatementPositionEvidence[] = [];
  const warnings: string[] = [];
  let cashBalance: string | undefined;
  let closingPortfolioValue: string | undefined;
  let openingPortfolioValue: string | undefined;

  // INV-G6: the valuation date is PARSED (it used to be stored raw, so one
  // DD/MM/YYYY cell failed the whole positions insert, silently). The format
  // is inferred from the column itself with FDH's own date grammar; a
  // genuinely ambiguous or unreadable cell falls back to the statement date
  // with a visible row warning, never a guess.
  const valuationSamples = valuationDateIdx >= 0 ? rows.slice(0, 50).map((r) => (r[valuationDateIdx] ?? '').trim()).filter(Boolean) : [];
  const valuationFormat = valuationSamples.length > 0 ? inferDateFormat(valuationSamples) : null;

  rows.forEach((row, i) => {
    const name = (row[nameIdx] ?? '').trim();
    if (!name) return;

    // INV-G8: summary lines are statement totals, never holdings.
    const summaryValue = valueIdx >= 0 ? parseMoneyCell(row[valueIdx]) : ({ ok: true, value: undefined } as CellParse);
    if (CASH_ROW.test(name) || TOTAL_ROW.test(name) || OPENING_ROW.test(name)) {
      if (!summaryValue.ok || summaryValue.value === undefined) {
        warnings.push(`row_${i + 1}_unparseable_summary_value`);
        return;
      }
      if (CASH_ROW.test(name)) cashBalance = summaryValue.value;
      else if (TOTAL_ROW.test(name)) closingPortfolioValue = summaryValue.value;
      else openingPortfolioValue = summaryValue.value;
      return;
    }

    const q = parseExactQuantity((row[quantityIdx] ?? '').replace(/,/g, ''));
    if (!q.ok) {
      warnings.push(`row_${i + 1}_unparseable_quantity`);
      return;
    }

    const price = priceIdx >= 0 ? parsePriceCell(row[priceIdx]) : ({ ok: true, value: undefined } as CellParse);
    if (!price.ok) warnings.push(`row_${i + 1}_unparseable_price`);
    const value = valueIdx >= 0 ? parseMoneyCell(row[valueIdx]) : ({ ok: true, value: undefined } as CellParse);
    if (!value.ok) warnings.push(`row_${i + 1}_unparseable_market_value`);

    let valuationDate = input.defaultValuationDate;
    const rawValuation = valuationDateIdx >= 0 ? (row[valuationDateIdx] ?? '').trim() : '';
    if (rawValuation) {
      const parsedDate = valuationFormat ? parseDateWithFormat(rawValuation, valuationFormat.format) : parseDateWithFormat(rawValuation, 'YYYY-MM-DD');
      if (parsedDate.ok && parsedDate.iso) valuationDate = parsedDate.iso;
      else warnings.push(`row_${i + 1}_unparseable_valuation_date_used_statement_date`);
    }

    positions.push({
      securityNameRaw: name,
      tickerRaw: tickerIdx >= 0 ? row[tickerIdx] || undefined : undefined,
      isin: isinIdx >= 0 ? row[isinIdx] || undefined : undefined,
      quantity: (row[quantityIdx] ?? '').replace(/,/g, '').trim(),
      unitPrice: price.ok ? price.value : undefined,
      marketValue: value.ok ? value.value : undefined,
      currencyCode: input.currencyCode,
      valuationDate,
      sourceRowNumber: i + 1,
    });
  });

  if (positions.length === 0) {
    warnings.push('zero_positions_extracted');
  }

  return {
    ok: true,
    extraction: {
      statementType: 'portfolio_csv',
      country: 'AU',
      currencyCode: input.currencyCode,
      institutionName: input.institutionName,
      maskedAccountIdentifier: input.maskedAccountIdentifier,
      statementDate: input.statementDate,
      openingPortfolioValue,
      closingPortfolioValue,
      cashBalance,
      positions,
      transactions: [],
      parserName: POSITION_PARSER_NAME,
      parserVersion: FDH11_GENERIC_CSV_PARSER_VERSION,
      extractionConfidence: warnings.length === 0 ? 0.95 : 0.6,
      warnings,
    },
  };
}

/** One persisted extraction warning (fdh_investment_statements.extraction_warnings, 0207). */
export interface PersistedExtractionWarning {
  code: string;
  count: number;
  /** True when the rows this code names were NOT stored as evidence at all. */
  rowsDropped: boolean;
  /** Source row numbers, when the warning is row-level (at most 50 listed). */
  rows?: number[];
}

/** Row-level warning codes whose row was dropped rather than stored with a null cell. */
const DROPPED_ROW_CODES = new Set(['unrecognised_transaction_type', 'unparseable_date', 'unparseable_amount', 'unparseable_quantity_position', 'unparseable_summary_value']);

/**
 * Canonical-upload WP-12 (INV-G6): collapses the extractor's warning strings
 * into the persisted, user-visible shape. Before this the warnings were never
 * stored, so the rows they described vanished silently.
 */
export function summariseExtractionWarnings(warnings: readonly string[], kind: 'transaction' | 'portfolio'): PersistedExtractionWarning[] {
  const byCode = new Map<string, PersistedExtractionWarning>();
  for (const w of warnings) {
    const m = /^row_(\d+)_(.+)$/.exec(w);
    let code = m ? m[2] : w;
    if (code.startsWith('unrecognised_transaction_type')) code = 'unrecognised_transaction_type';
    // A position row with an unreadable quantity is dropped; a transaction row
    // with one is kept (quantity null), so the two need distinct codes.
    const dropKey = code === 'unparseable_quantity' && kind === 'portfolio' ? 'unparseable_quantity_position' : code;
    const entry = byCode.get(code) ?? { code, count: 0, rowsDropped: DROPPED_ROW_CODES.has(dropKey) };
    entry.count += 1;
    if (m) {
      entry.rows = entry.rows ?? [];
      if (entry.rows.length < 50) entry.rows.push(Number(m[1]));
    }
    byCode.set(code, entry);
  }
  return [...byCode.values()];
}
