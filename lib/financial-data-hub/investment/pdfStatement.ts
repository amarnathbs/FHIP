/**
 * Australian investment (broker) statements: the CERTIFIED deterministic PDF layouts HOLD-1 (holdings) and TXN-1 (transactions)
 * (docs/ai/pdf_routes_liab_ret_auinv/03_SPEC_AU_INVESTMENT.md).
 *
 * The reader runs on the text the local PDF extractor produced. It either returns EVERY line of the table as read, or it returns a
 * typed failure and reads nothing. It never drops a line, never repairs a line, never guesses and never invents a figure: a cash
 * balance or a portfolio total that is not printed stays undefined. A layout it does not know is `layout_unsupported`; a layout it
 * knows with one line it cannot read is `unread_lines`; those are the only outcomes after which a model reading may be offered.
 *
 * What it returns is the SAME shape the CSV path feeds `persistAuInvestmentEvidence` (exact decimal strings, amount a positive
 * magnitude with the type carrying direction). Totals are NOT reconciled here: the existing `reconcileAuStatementTotals` does that
 * over the positions. What that check cannot see is a wrong line whose printed neighbours still add up to the printed total, so the
 * reader counts every failed line arithmetic check in `lineChecksFailed`; the caller stores the statement as `variance` when it is
 * above zero. The only tolerance is the named rounding rule: quantity x price = value within 0.01 (00_COMMON_SPEC.md section 4).
 */

import {
  checkInvestmentClass,
  firstDate,
  maskedLastFour,
  minorToDecimalString,
  multiplyToMinor,
  parseDateRange,
  parseExactDecimal,
  parseMoney,
  parseStatementDate,
  pdfFailure,
  valueAfterLabel,
  type PdfLine,
  type PdfReadFailure,
  type PdfStatementText,
} from '../pdf-statements';
import {
  AU_STATEMENT_TRANSACTION_TYPES,
  type AuInvestmentStatementExtraction,
  type AuStatementPositionEvidence,
  type AuStatementTransactionEvidence,
  type AuStatementTransactionType,
} from './types';

export const FDH_PDF_AU_HOLDINGS_PARSER_NAME = 'fdh_pdf_au_holdings_1';
export const FDH_PDF_AU_TRANSACTIONS_PARSER_NAME = 'fdh_pdf_au_transactions_1';
export const FDH_PDF_AU_INVESTMENT_PARSER_VERSION = '1.0.0';
/** The certified layouts are exact, so a clean read carries high confidence; recorded, never used to gate anything. */
export const FDH_PDF_AU_INVESTMENT_EXTRACTION_CONFIDENCE = 0.95;

export interface AuInvestmentPdfReadInput {
  text: PdfStatementText;
  /** The person's declared currency. A different printed currency code is a warning. */
  currencyCode: string;
  /** What the person chose on the screen. A document of the other kind is refused (`kind_mismatch`), never silently re-typed. */
  kind: 'portfolio' | 'transaction';
}

export interface AuInvestmentPdfReadOk {
  ok: true;
  layout: 'HOLD-1' | 'TXN-1';
  extraction: AuInvestmentStatementExtraction;
  /** Holdings whose value is not quantity x price, and transaction lines whose amount does not follow from quantity, price and brokerage. */
  lineChecksFailed: number;
  /** Informational counts for the audit trail; NOT persisted as warnings. */
  notes: {
    /** Cash, total and subtotal lines (HOLD-1) or printed total lines (TXN-1): read as figures, never as holdings or transactions. */
    summaryLinesExcluded: number;
    pageMarkersSkipped: number;
    footnotesSkipped: number;
    /** The optional HOLD-1 Cost base column is validated but has no evidence field to be stored in. */
    costBaseValuesNotStored: number;
  };
}

const HOLD_HEADER_RE = /^code security quantity price value( cost base)?$/i;
const TXN_HEADER_RE = /^date type code quantity price brokerage amount$/i;
const HOLD_TITLE_RE = /^(?:holdings statement|portfolio valuation|holdings valuation)\b/i;
const TXN_TITLE_RE = /^(?:transaction statement|activity statement)\b/i;
const TITLE_ONLY_RE = /^(?:holdings statement|portfolio valuation|holdings valuation|transaction statement|activity statement)$/i;
const PAGE_NUMBER_RE = /^page \d+(?: of \d+)?$/i;
const CONTINUED_ONLY_RE = /^(?:continued(?: on next page| from previous page| overleaf)?|\(continued\))$/i;
const FOOTNOTE_RE = /^note\b/i;
const CASH_RE = /^cash balance\b\s*:?\s*(.+)$/i;
const TOTAL_RE = /^(?:total portfolio value|portfolio total|total)\b\s*:?\s*(.+)$/i;
const SUBTOTAL_RE = /^sub-?total\b.*\s(\S+)$/i;
const HIN_RE = /\bHIN\s*:?\s*([A-Z]?\d+(?: \d+)*)/;
const ACCOUNT_NUMBER_RE = /\b(?:account number|account no\.?)\s*:?\s*([A-Z]?\d+(?: \d+)*)/i;
const CODE_RE = /^[A-Z0-9]{2,5}$/;
const CURRENCY_CODE_RE = /\b(AUD|INR|USD|NZD|GBP|EUR|CAD|SGD)\b/g;
/** A quantity or price as printed: plain or comma-grouped digits with at most 6 decimals. */
const DECIMAL_TOKEN_RE = /^\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?$/;
const PRINTED_TOTAL_SEGMENT_RE = /total (buys|sells|brokerage)\s*:?\s*(\S+)/gi;

/** The transaction types of the certified TXN-1 layout (spec section 1); the vocabulary's two internal values are never printed by a broker. */
const TXN1_TYPES: ReadonlySet<string> = new Set(
  AU_STATEMENT_TRANSACTION_TYPES.filter((t) => t !== 'CORPORATE_ACTION_EVIDENCE' && t !== 'UNKNOWN'),
);

/** A non-negative table money token with exactly two decimals, as minor units; anything else (a sign, brackets, CR/DR, one decimal) is null. */
function tableMoney(token: string): number | null {
  const m = parseMoney(token, { requireDecimals: true });
  if (!m || m.negative || m.bracketed || m.suffix !== null) return null;
  return m.minor;
}

function exactDecimal(token: string): string | null {
  if (!DECIMAL_TOKEN_RE.test(token)) return null;
  return parseExactDecimal(token);
}

function sameWithinRounding(aMinor: number, bMinor: number): boolean {
  return Math.abs(aMinor - bMinor) <= 1;
}

interface HoldingRow {
  code: string;
  name: string;
  quantity: string;
  price: string;
  valueMinor: number;
  costBaseMinor: number | null;
}

function parseHoldingRow(text: string, hasCostBase: boolean): HoldingRow | null {
  const tokens = text.split(' ');
  const numeric = hasCostBase ? 4 : 3;
  if (tokens.length < numeric + 2) return null;
  const code = tokens[0];
  if (!CODE_RE.test(code)) return null;
  const name = tokens.slice(1, tokens.length - numeric).join(' ');
  if (!/[A-Za-z]/.test(name)) return null;
  const tail = tokens.slice(tokens.length - numeric);
  const quantity = exactDecimal(tail[0]);
  const price = exactDecimal(tail[1]);
  const valueMinor = tableMoney(tail[2]);
  const costBaseMinor = hasCostBase ? tableMoney(tail[3]) : null;
  if (quantity === null || price === null || valueMinor === null) return null;
  if (hasCostBase && costBaseMinor === null) return null;
  return { code, name, quantity, price, valueMinor, costBaseMinor };
}

interface TransactionRow {
  iso: string;
  type: AuStatementTransactionType;
  code: string | null;
  quantity: string | null;
  price: string | null;
  brokerageMinor: number | null;
  amountMinor: number;
}

function parseTransactionRow(text: string): TransactionRow | null {
  const tokens = text.split(' ');
  if (tokens.length !== 7) return null;
  const [dateTok, typeTok, codeTok, qtyTok, priceTok, brokerageTok, amountTok] = tokens;
  const iso = parseStatementDate(dateTok);
  if (!iso) return null;
  if (!TXN1_TYPES.has(typeTok)) return null;
  let code: string | null = null;
  if (codeTok !== '-') {
    if (!CODE_RE.test(codeTok)) return null;
    code = codeTok;
  }
  let quantity: string | null = null;
  if (qtyTok !== '-') {
    quantity = exactDecimal(qtyTok);
    if (quantity === null) return null;
  }
  let price: string | null = null;
  if (priceTok !== '-') {
    price = exactDecimal(priceTok);
    if (price === null) return null;
  }
  let brokerageMinor: number | null = null;
  if (brokerageTok !== '-') {
    brokerageMinor = tableMoney(brokerageTok);
    if (brokerageMinor === null) return null;
  }
  const amountMinor = tableMoney(amountTok);
  if (amountMinor === null) return null;
  const type = typeTok as AuStatementTransactionType;
  // A buy or a sell without its code, units and price cannot be checked and is not a line this layout prints.
  if ((type === 'BUY' || type === 'SELL') && (code === null || quantity === null || price === null)) return null;
  return { iso, type, code, quantity, price, brokerageMinor, amountMinor };
}

export function readAuInvestmentPdf(input: AuInvestmentPdfReadInput): AuInvestmentPdfReadOk | PdfReadFailure {
  const { text, kind } = input;

  if (!checkInvestmentClass(text.text).ok) return pdfFailure('not_this_class');

  const lines: PdfLine[] = text.lines;

  // --- more than one account in one PDF ---------------------------------------------------------------------------
  const hins: string[] = [];
  let headerLines = 0;
  let totalLines = 0;
  for (const l of lines) {
    const hin = l.text.match(HIN_RE);
    if (hin) {
      const masked = maskedLastFour(hin[1]);
      if (masked && !hins.includes(masked)) hins.push(masked);
    }
    if (HOLD_HEADER_RE.test(l.text) || TXN_HEADER_RE.test(l.text)) headerLines += 1;
    if (/^(?:total portfolio value|portfolio total|total buys)\b|^total\s*:/i.test(l.text)) totalLines += 1;
  }
  if (hins.length >= 2 && (headerLines >= 2 || totalLines >= 2)) return pdfFailure('multiple_accounts', `hins_${hins.length}`);

  // --- which layout, and is it the kind the person chose ----------------------------------------------------------
  const holdIdx = lines.findIndex((l) => HOLD_HEADER_RE.test(l.text));
  const txnIdx = lines.findIndex((l) => TXN_HEADER_RE.test(l.text));
  if (holdIdx >= 0 && txnIdx >= 0) return pdfFailure('layout_unsupported', 'mixed_layouts');
  if (holdIdx < 0 && txnIdx < 0) return pdfFailure('layout_unsupported', 'no_table_header');
  const isHoldings = holdIdx >= 0;
  if (isHoldings !== (kind === 'portfolio')) return pdfFailure('layout_unsupported', 'kind_mismatch');
  const headerIdx = isHoldings ? holdIdx : txnIdx;
  const hasCostBase = isHoldings && Boolean(lines[headerIdx].text.match(HOLD_HEADER_RE)?.[1]);

  const before = lines.slice(0, headerIdx);
  const titleRe = isHoldings ? HOLD_TITLE_RE : TXN_TITLE_RE;
  if (!before.some((l) => titleRe.test(l.text))) return pdfFailure('layout_unsupported', 'no_title');

  // --- header fields (before the table) ---------------------------------------------------------------------------
  const first = lines[0]?.text;
  let institutionName: string | undefined;
  if (first && first.length >= 2 && first.length <= 80 && !/statement|valuation/i.test(first) && !/^\d/.test(first) && !HIN_RE.test(first) && !ACCOUNT_NUMBER_RE.test(first)) {
    institutionName = first;
  }

  let maskedAccountIdentifier: string | undefined = hins[0];
  if (maskedAccountIdentifier === undefined) {
    for (const l of lines) {
      const m = l.text.match(ACCOUNT_NUMBER_RE);
      const masked = m ? maskedLastFour(m[1]) : null;
      if (masked) { maskedAccountIdentifier = masked; break; }
    }
  }

  let valuationDate: string | undefined;
  let periodStart: string | undefined;
  let periodEnd: string | undefined;
  for (const l of before) {
    if (isHoldings && valuationDate === undefined && /^(?:valuation date|statement date)\b/i.test(l.text)) {
      const v = valueAfterLabel(l.text, /^(?:valuation date|statement date)/i);
      const d = v ? firstDate(v) : null;
      if (!d) return pdfFailure('layout_unsupported', 'valuation_date_unreadable');
      valuationDate = d;
    }
    if (!isHoldings && periodStart === undefined && /^statement period\b/i.test(l.text)) {
      const range = parseDateRange(l.text);
      if (!range) return pdfFailure('layout_unsupported', 'period_unreadable');
      periodStart = range.start;
      periodEnd = range.end;
    }
  }
  if (isHoldings && valuationDate === undefined) return pdfFailure('layout_unsupported', 'no_valuation_date');

  // --- table lines ------------------------------------------------------------------------------------------------
  const warnings: string[] = [];
  const notes = { summaryLinesExcluded: 0, pageMarkersSkipped: 0, footnotesSkipped: 0, costBaseValuesNotStored: 0 };
  let lineChecksFailed = 0;
  let unread = 0;

  const isPageMarker = (t: string): boolean => {
    if (isHoldings ? HOLD_HEADER_RE.test(t) : TXN_HEADER_RE.test(t)) return true;
    if (PAGE_NUMBER_RE.test(t) || CONTINUED_ONLY_RE.test(t)) return true;
    if (first && t === first) return true;
    if (TITLE_ONLY_RE.test(t) && titleRe.test(t)) return true;
    const m = t.match(/^(.*?)\s*\(?continued\)?$/i);
    if (m && m[1] && ((first && m[1] === first) || (TITLE_ONLY_RE.test(m[1]) && titleRe.test(m[1])))) return true;
    return false;
  };

  const positions: AuStatementPositionEvidence[] = [];
  const transactions: AuStatementTransactionEvidence[] = [];
  let cashMinor: number | null = null;
  let totalMinor: number | null = null;
  let holdingsMinor = 0;
  let sinceSubtotalMinor = 0;
  const printedTotals: Partial<Record<'buys' | 'sells' | 'brokerage', number>> = {};
  let sumBuys = 0;
  let sumSells = 0;
  let sumBrokerage = 0;

  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const t = lines[i].text;
    if (isPageMarker(t)) { notes.pageMarkersSkipped += 1; continue; }

    if (isHoldings) {
      const row = parseHoldingRow(t, hasCostBase);
      if (row) {
        const rowNumber = positions.length + 1;
        const expectedMinor = multiplyToMinor(row.quantity, row.price);
        if (!sameWithinRounding(expectedMinor, row.valueMinor)) {
          warnings.push(`value_not_quantity_times_price_${row.code}`);
          lineChecksFailed += 1;
        }
        if (row.costBaseMinor !== null) notes.costBaseValuesNotStored += 1;
        holdingsMinor += row.valueMinor;
        sinceSubtotalMinor += row.valueMinor;
        positions.push({
          securityNameRaw: row.name,
          tickerRaw: row.code,
          quantity: row.quantity,
          unitPrice: row.price,
          marketValue: minorToDecimalString(row.valueMinor),
          currencyCode: input.currencyCode,
          valuationDate: valuationDate as string,
          sourceRowNumber: rowNumber,
        });
        continue;
      }
      if (FOOTNOTE_RE.test(t)) { notes.footnotesSkipped += 1; continue; }
      const cash = t.match(CASH_RE);
      if (cash) {
        const v = tableMoney(cash[1]);
        if (v === null || cashMinor !== null) { unread += 1; continue; }
        cashMinor = v;
        notes.summaryLinesExcluded += 1;
        continue;
      }
      const sub = t.match(SUBTOTAL_RE);
      if (sub) {
        const v = tableMoney(sub[1]);
        if (v === null) { unread += 1; continue; }
        // A subtotal ties to the holdings since the previous subtotal, or to every holding so far (exact; no tolerance).
        if (v !== sinceSubtotalMinor && v !== holdingsMinor) warnings.push('printed_subtotal_mismatch');
        sinceSubtotalMinor = 0;
        notes.summaryLinesExcluded += 1;
        continue;
      }
      const total = t.match(TOTAL_RE);
      if (total) {
        const v = tableMoney(total[1]);
        if (v === null || totalMinor !== null) { unread += 1; continue; }
        totalMinor = v;
        notes.summaryLinesExcluded += 1;
        continue;
      }
      unread += 1;
    } else {
      const row = parseTransactionRow(t);
      if (row) {
        const rowNumber = transactions.length + 1;
        if (row.type === 'BUY' || row.type === 'SELL') {
          const gross = multiplyToMinor(row.quantity as string, row.price as string);
          const brokerage = row.brokerageMinor ?? 0;
          const expected = row.type === 'BUY' ? gross + brokerage : gross - brokerage;
          if (!sameWithinRounding(expected, row.amountMinor)) {
            warnings.push(`line_arithmetic_fails_row_${rowNumber}`);
            lineChecksFailed += 1;
          }
          if (row.type === 'BUY') sumBuys += row.amountMinor;
          else sumSells += row.amountMinor;
        }
        // The brokerage column is what "Total brokerage" adds up; a BROKERAGE-type line is an amount, not this column.
        sumBrokerage += row.brokerageMinor ?? 0;
        transactions.push({
          transactionType: row.type,
          tradeDate: row.iso,
          tickerRaw: row.code ?? undefined,
          quantity: row.quantity ?? undefined,
          unitPrice: row.price ?? undefined,
          amount: minorToDecimalString(row.amountMinor),
          currencyCode: input.currencyCode,
          descriptionRaw: row.type,
          brokerageRaw: row.brokerageMinor === null ? undefined : minorToDecimalString(row.brokerageMinor),
          sourceRowNumber: rowNumber,
        });
        continue;
      }
      if (FOOTNOTE_RE.test(t)) { notes.footnotesSkipped += 1; continue; }
      // Printed totals: one or more `Total buys|sells|brokerage: $x` segments covering the whole line.
      const segments = [...t.matchAll(PRINTED_TOTAL_SEGMENT_RE)];
      if (segments.length > 0 && t.replace(PRINTED_TOTAL_SEGMENT_RE, '').trim() === '') {
        let ok = true;
        const found: Array<['buys' | 'sells' | 'brokerage', number]> = [];
        for (const s of segments) {
          const name = s[1].toLowerCase() as 'buys' | 'sells' | 'brokerage';
          const v = tableMoney(s[2]);
          if (v === null || printedTotals[name] !== undefined || found.some(([n]) => n === name)) { ok = false; break; }
          found.push([name, v]);
        }
        if (!ok) { unread += 1; continue; }
        for (const [name, v] of found) printedTotals[name] = v;
        notes.summaryLinesExcluded += found.length;
        continue;
      }
      unread += 1;
    }
  }

  if (unread > 0) return pdfFailure('unread_lines', `unread_${unread}`);
  if (isHoldings ? positions.length === 0 : transactions.length === 0) return pdfFailure('layout_unsupported', 'no_rows');

  // --- checks that are visible, never silent ---------------------------------------------------------------------
  if (isHoldings) {
    if (totalMinor !== null && totalMinor !== holdingsMinor && (cashMinor === null || totalMinor !== holdingsMinor + cashMinor)) {
      warnings.push('holdings_total_mismatch');
    }
  } else {
    const sums = { buys: sumBuys, sells: sumSells, brokerage: sumBrokerage };
    for (const name of ['buys', 'sells', 'brokerage'] as const) {
      const printed = printedTotals[name];
      if (printed !== undefined && printed !== sums[name]) warnings.push(`printed_total_mismatch_${name}`);
    }
  }

  if (hins.length >= 2) warnings.push('multiple_account_identifiers');

  // A printed currency code that is not the declared one is a visible warning (never an automatic conversion).
  const printed = new Set([...text.text.matchAll(CURRENCY_CODE_RE)].map((m) => m[1]));
  if ([...printed].some((c) => c !== input.currencyCode)) warnings.push('printed_currency_differs_from_declared');

  const extraction: AuInvestmentStatementExtraction = {
    statementType: isHoldings ? 'broker_holdings_statement' : 'broker_transaction_statement',
    country: 'AU',
    currencyCode: input.currencyCode,
    institutionName,
    maskedAccountIdentifier,
    statementDate: isHoldings ? valuationDate : undefined,
    statementPeriodStart: isHoldings ? undefined : periodStart,
    statementPeriodEnd: isHoldings ? undefined : periodEnd,
    closingPortfolioValue: isHoldings && totalMinor !== null ? minorToDecimalString(totalMinor) : undefined,
    cashBalance: isHoldings && cashMinor !== null ? minorToDecimalString(cashMinor) : undefined,
    positions,
    transactions,
    parserName: isHoldings ? FDH_PDF_AU_HOLDINGS_PARSER_NAME : FDH_PDF_AU_TRANSACTIONS_PARSER_NAME,
    parserVersion: FDH_PDF_AU_INVESTMENT_PARSER_VERSION,
    extractionConfidence: FDH_PDF_AU_INVESTMENT_EXTRACTION_CONFIDENCE,
    warnings,
  };

  return { ok: true, layout: isHoldings ? 'HOLD-1' : 'TXN-1', extraction, lineChecksFailed, notes };
}
