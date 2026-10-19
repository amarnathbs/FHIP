/**
 * Liability statements (credit card, loan): the CERTIFIED deterministic PDF layouts CARD-1 and LOAN-1
 * (docs/ai/pdf_routes_liab_ret_auinv/01_SPEC_LIABILITY.md).
 *
 * The reader runs on the text the local PDF extractor produced. It either returns EVERY line of the statement as read, or it
 * returns a typed failure and reads nothing. It never drops a line, never repairs a line, never guesses a type it cannot justify,
 * and never invents a figure. A layout it does not know is `layout_unsupported`; a layout it knows with one line it cannot read is
 * `unread_lines`; both are the only outcomes after which a model reading may be offered (see `pdf-statements/types.ts`).
 *
 * What it returns is the SAME shape the CSV adapters feed `persistLiabilityStatementEvidence`: activities (positive magnitude plus a
 * type) and the header figures. Reconciliation is NOT done here; it is done by the existing writer from the activities, so a
 * statement that is wrong on the page is stored with a visible variance and can never be certified.
 */

import {
  checkLiabilityClass,
  firstDate,
  maskedLastFour,
  minorToNumber,
  parseDateRange,
  parseMoney,
  parseStatementDate,
  pdfFailure,
  valueAfterLabel,
  type PdfLine,
  type PdfReadFailure,
  type PdfStatementText,
} from '../pdf-statements';
import type {
  LiabilityActivityType,
  LiabilityFacilityType,
  LiabilityStatementActivity,
  LiabilityStatementType,
} from './types';

export const FDH_PDF_CARD_PARSER_NAME = 'fdh_pdf_card_1';
export const FDH_PDF_LOAN_PARSER_NAME = 'fdh_pdf_loan_1';
export const FDH_PDF_LIABILITY_PARSER_VERSION = '1.0.0';
/** The certified layouts are exact, so a clean read carries high confidence; recorded, never used to gate anything. */
export const FDH_PDF_LIABILITY_EXTRACTION_CONFIDENCE = 0.95;

export interface LiabilityPdfHeader {
  institutionName?: string;
  maskedIdentifier?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  statementDate?: string;
  dueDate?: string;
  /** Opening balance (card) or opening principal (loan). */
  openingBalance?: number;
  closingBalance?: number;
  creditLimit?: number;
  minimumPayment?: number;
  interestRate?: number;
}

export interface LiabilityPdfReadOk {
  ok: true;
  layout: 'CARD-1' | 'LOAN-1';
  statementType: LiabilityStatementType;
  header: LiabilityPdfHeader;
  activities: LiabilityStatementActivity[];
  /** Persisted as visible evidence (they force the statement into review). */
  warnings: string[];
  /** Informational counts for the audit trail; NOT persisted as warnings. */
  notes: { summaryLinesExcluded: number; pageMarkersSkipped: number };
  parserName: string;
  parserVersion: string;
  extractionConfidence: number;
}

export interface LiabilityPdfReadInput {
  text: PdfStatementText;
  statementType: LiabilityStatementType;
  /** The person's declared currency. A different printed currency code is a warning. */
  currencyCode: string;
}

const TITLE_RE = /(?:statement|statement of account)\b/i;
const OPENING_RE = /^(?:opening|previous) balance\b/i;
const CLOSING_RE = /^(?:closing|new) balance\b/i;
const SUMMARY_DESC_RE = /^(?:total\b|sub-?total\b|balance (?:brought|carried) forward\b|brought forward\b|carried forward\b|previous balance\b|opening balance\b|closing balance\b|new balance\b)/i;
const PAGE_MARKER_RE = /^(?:page \d+(?: of \d+)?|continued(?: on next page| from previous page| overleaf)?|\(?continued\)?|.*\(continued\))$/i;
const IDENTIFIER_RE = /^(?:card number|card ending|card no\.?|account number|loan account(?: number)?|account no\.?)\s*:?\s*(.+)$/i;
const CURRENCY_CODE_RE = /\b(AUD|INR|USD|NZD|GBP|EUR|CAD|SGD)\b/g;

function moneyOf(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  // A header amount may be followed by words ("$1,250.40 CR"); the first token is the amount.
  const m = parseMoney(raw.split(' ')[0] ?? raw) ?? parseMoney(raw);
  return m ? minorToNumber(m.minor) : undefined;
}

function classifyCardActivity(description: string, credit: boolean): LiabilityActivityType {
  const d = description.toLowerCase();
  if (credit) return /payment|direct debit|bpay/.test(d) ? 'PAYMENT' : 'REFUND';
  if (/\bfee\b/.test(d)) return 'FEE';
  if (/\binterest\b/.test(d)) return 'INTEREST';
  if (/cash advance/.test(d)) return 'CASH_ADVANCE';
  return 'PURCHASE';
}

function classifyLoanActivity(description: string, increase: boolean): { type: LiabilityActivityType; known: boolean } {
  const d = description.toLowerCase();
  if (increase) {
    if (/\binterest\b/.test(d)) return { type: 'INTEREST', known: true };
    if (/\bfee\b|\bcharge\b/.test(d)) return { type: 'FEE', known: true };
    if (/redraw|advance|drawdown/.test(d)) return { type: 'LOAN_ADVANCE', known: true };
    return { type: 'OTHER', known: false };
  }
  if (/\bprincipal\b/.test(d)) return { type: 'PRINCIPAL', known: true };
  if (/repayment|payment|direct debit/.test(d)) return { type: 'PAYMENT', known: true };
  return { type: 'OTHER', known: false };
}

/** Splits `dd/mm/yyyy rest` or `dd Mon yyyy rest`; returns the ISO date and the remaining text, or null when the line does not start with a date. */
function splitLeadingDate(text: string): { iso: string | null; rest: string } | null {
  const numeric = text.match(/^(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})\s+(.*)$/);
  if (numeric) return { iso: parseStatementDate(numeric[1]), rest: numeric[2] };
  const named = text.match(/^(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+(.*)$/);
  if (named) {
    const iso = parseStatementDate(named[1]);
    if (iso) return { iso, rest: named[2] };
  }
  // A date-only line, or a date-led line with no tail, still starts with a date.
  if (/^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}\s*$/.test(text)) return { iso: parseStatementDate(text), rest: '' };
  return null;
}

export function readLiabilityPdf(input: LiabilityPdfReadInput): LiabilityPdfReadOk | PdfReadFailure {
  const { text, statementType } = input;
  const isCard = statementType === 'credit_card';

  if (!checkLiabilityClass(text.text, statementType).ok) return pdfFailure('not_this_class');

  const lines: PdfLine[] = text.lines;

  // --- more than one account in one PDF ---------------------------------------------------------------------------
  const identifiers = new Set<string>();
  let openingLabels = 0;
  for (const l of lines) {
    const id = l.text.match(IDENTIFIER_RE);
    if (id) {
      const masked = maskedLastFour(id[1]);
      if (masked) identifiers.add(masked);
    }
    if (/^opening balance\b/i.test(l.text)) openingLabels += 1;
  }
  if (identifiers.size >= 2 && openingLabels >= 2) return pdfFailure('multiple_accounts', `identifiers_${identifiers.size}`);

  // --- table boundaries -------------------------------------------------------------------------------------------
  const wantHeader = isCard ? /^date description amount$/i : /^date description amount balance$/i;
  const headerIdx = lines.findIndex((l) => wantHeader.test(l.text));
  if (headerIdx < 0) return pdfFailure('layout_unsupported', 'no_table_header');
  const closingIdx = lines.findIndex((l, i) => i > headerIdx && CLOSING_RE.test(l.text));
  if (closingIdx < 0) return pdfFailure('layout_unsupported', 'no_closing_balance');

  // --- header fields (outside the table) --------------------------------------------------------------------------
  const outside = lines.filter((_, i) => i < headerIdx || i >= closingIdx);
  const header: LiabilityPdfHeader = {};
  const first = lines[0]?.text;
  if (first && first.length >= 2 && first.length <= 80 && !TITLE_RE.test(first) && !/^\d/.test(first) && !IDENTIFIER_RE.test(first)) header.institutionName = first;

  for (const l of outside) {
    const t = l.text;
    let m: RegExpMatchArray | null;
    if (header.maskedIdentifier === undefined && (m = t.match(IDENTIFIER_RE))) {
      const masked = maskedLastFour(m[1]);
      if (masked) header.maskedIdentifier = masked;
      continue;
    }
    if (header.statementPeriodStart === undefined && /^statement (?:period|from)\b/i.test(t)) {
      const range = parseDateRange(t);
      if (range) { header.statementPeriodStart = range.start; header.statementPeriodEnd = range.end; }
      continue;
    }
    if (header.statementDate === undefined && /^statement date\b/i.test(t)) {
      const v = valueAfterLabel(t, /^statement date/i);
      const d = v ? firstDate(v) : null;
      if (d) header.statementDate = d;
      continue;
    }
    if (isCard && header.dueDate === undefined && /^payment due(?: date)?\b/i.test(t)) {
      const v = valueAfterLabel(t, /^payment due(?: date)?/i);
      const d = v ? firstDate(v) : null;
      if (d) header.dueDate = d;
      continue;
    }
    if (isCard && header.creditLimit === undefined && /^credit limit\b/i.test(t)) {
      header.creditLimit = moneyOf(valueAfterLabel(t, /^credit limit/i));
      continue;
    }
    if (isCard && header.minimumPayment === undefined && /^minimum (?:payment|repayment)\b/i.test(t)) {
      header.minimumPayment = moneyOf(valueAfterLabel(t, /^minimum (?:payment|repayment)(?: due)?/i));
      continue;
    }
    if (!isCard && header.interestRate === undefined && (m = t.match(/^interest rate\s*:?\s*(\d{1,2}(?:\.\d{1,4})?)\s*%/i))) {
      header.interestRate = Number(m[1]);
      continue;
    }
    if (header.openingBalance === undefined && OPENING_RE.test(t)) {
      header.openingBalance = moneyOf(valueAfterLabel(t, OPENING_RE));
      continue;
    }
    if (header.closingBalance === undefined && CLOSING_RE.test(t)) {
      header.closingBalance = moneyOf(valueAfterLabel(t, CLOSING_RE));
      continue;
    }
  }
  if (header.openingBalance === undefined || header.closingBalance === undefined) return pdfFailure('layout_unsupported', 'balances_not_printed');

  // --- table lines -------------------------------------------------------------------------------------------------
  const activities: LiabilityStatementActivity[] = [];
  const warnings: string[] = [];
  const notes = { summaryLinesExcluded: 0, pageMarkersSkipped: 0 };
  let unread = 0;
  let prevBalanceMinor: number | null = Math.round(header.openingBalance * 100);
  let lastPrintedBalanceMinor: number | null = null;
  const institutionLine = lines[0]?.text;

  for (let i = headerIdx + 1; i < closingIdx; i += 1) {
    const t = lines[i].text;
    if (wantHeader.test(t) || PAGE_MARKER_RE.test(t) || (institutionLine && t === institutionLine) || (TITLE_RE.test(t) && /\(continued\)|continued/i.test(t))) {
      notes.pageMarkersSkipped += 1;
      continue;
    }
    if (/^(?:total|sub-?total|balance (?:brought|carried) forward)\b/i.test(t)) { notes.summaryLinesExcluded += 1; continue; }

    const lead = splitLeadingDate(t);
    if (!lead || !lead.iso) { unread += 1; continue; }
    if (SUMMARY_DESC_RE.test(lead.rest)) { notes.summaryLinesExcluded += 1; continue; }

    const tokens = lead.rest.split(' ');
    if (isCard) {
      let suffix: string | null = null;
      if (tokens.length >= 2 && /^(?:CR|DR)$/i.test(tokens[tokens.length - 1])) suffix = tokens.pop()!.toUpperCase();
      const amountToken = tokens.pop();
      const money = amountToken ? parseMoney(amountToken, { requireDecimals: true }) : null;
      const description = tokens.join(' ').trim();
      if (!money || !description || money.minor === 0) { unread += 1; continue; }
      const credit = suffix === 'CR' || money.negative;
      activities.push({
        activityType: classifyCardActivity(description, credit),
        activityDate: lead.iso,
        amount: minorToNumber(Math.abs(money.minor)),
        descriptionRaw: description,
        sourceRowNumber: activities.length + 1,
      });
    } else {
      const balanceToken = tokens.pop();
      const amountToken = tokens.pop();
      const balance = balanceToken ? parseMoney(balanceToken, { requireDecimals: true }) : null;
      const money = amountToken ? parseMoney(amountToken, { requireDecimals: true }) : null;
      const description = tokens.join(' ').trim();
      if (!money || !balance || !description || money.minor <= 0) { unread += 1; continue; }
      const rowNumber = activities.length + 1;
      let increase: boolean | null = null;
      if (prevBalanceMinor !== null) {
        const delta = balance.minor - prevBalanceMinor;
        if (delta === money.minor) increase = true;
        else if (delta === -money.minor) increase = false;
        else warnings.push(`running_balance_break_row_${rowNumber}`);
      }
      if (increase === null) increase = !/repayment|payment|principal|direct debit/i.test(description);
      const { type, known } = classifyLoanActivity(description, increase);
      if (!known) warnings.push(`loan_line_type_unknown_row_${rowNumber}`);
      activities.push({
        activityType: type,
        activityDate: lead.iso,
        amount: minorToNumber(money.minor),
        descriptionRaw: description,
        sourceRowNumber: rowNumber,
      });
      prevBalanceMinor = balance.minor;
      lastPrintedBalanceMinor = balance.minor;
    }
  }

  if (unread > 0) return pdfFailure('unread_lines', `unread_${unread}`);
  if (activities.length === 0) return pdfFailure('layout_unsupported', 'no_activity_lines');

  if (!isCard && lastPrintedBalanceMinor !== null && lastPrintedBalanceMinor !== Math.round((header.closingBalance ?? 0) * 100)) {
    warnings.push('closing_balance_differs_from_last_running_balance');
  }

  // A printed currency code that is not the declared one is a visible warning (never an automatic conversion).
  const printed = new Set([...text.text.matchAll(CURRENCY_CODE_RE)].map((m) => m[1]));
  if ([...printed].some((c) => c !== input.currencyCode)) warnings.push('printed_currency_differs_from_declared');

  return {
    ok: true,
    layout: isCard ? 'CARD-1' : 'LOAN-1',
    statementType,
    header,
    activities,
    warnings,
    notes,
    parserName: isCard ? FDH_PDF_CARD_PARSER_NAME : FDH_PDF_LOAN_PARSER_NAME,
    parserVersion: FDH_PDF_LIABILITY_PARSER_VERSION,
    extractionConfidence: FDH_PDF_LIABILITY_EXTRACTION_CONFIDENCE,
  };
}

/** Exposed so the service can show the person the facility type they chose; a loan's facility type is NEVER read from the page. */
export type LiabilityPdfFacilityChoice = Exclude<LiabilityFacilityType, 'credit_card'>;
