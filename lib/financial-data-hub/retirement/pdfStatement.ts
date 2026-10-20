/**
 * Retirement statements (super, pension): the CERTIFIED deterministic PDF layout RET-1 (member or pension statement, summary form)
 * (docs/ai/pdf_routes_liab_ret_auinv/02_SPEC_RETIREMENT.md).
 *
 * The reader runs on the text the local PDF extractor produced. It either returns the whole statement as read, or it returns a typed
 * failure and reads nothing. It never ignores a line that carries an amount, never repairs a line, never guesses a label and never
 * invents a figure (an opening balance that is not printed stays absent, it is never 0). A layout it does not know is
 * `layout_unsupported`; the layout with one money line it cannot place is `unread_lines`; both are the only outcomes after which a
 * model reading may be offered (see `pdf-statements/types.ts`).
 *
 * What it returns is the SAME `RetirementStatementExtraction` the CSV and AI adapters feed `persistRetirementEvidence`: exact decimal
 * strings, `undefined` meaning "not printed". Reconciliation is NOT done here; the existing `reconcileStatement` does it from the
 * printed totals, so a statement that is wrong on the page is stored with a visible variance and can never be certified.
 */

import {
  checkRetirementClass,
  firstDate,
  maskedLastFour,
  minorToDecimalString,
  multiplyToMinor,
  parseDateRange,
  parseExactDecimal,
  parseMoney,
  pdfFailure,
  type PdfReadFailure,
  type PdfStatementText,
} from '../pdf-statements';
import type { RetirementPositionEvidence, RetirementStatementExtraction, RetirementStatementType } from './types';

export const FDH_PDF_RETIREMENT_PARSER_NAME = 'fdh_pdf_retirement_1';
export const FDH_PDF_RETIREMENT_PARSER_VERSION = '1.0.0';
/** The certified layout is exact, so a clean read carries high confidence; recorded, never used to gate anything. */
export const FDH_PDF_RETIREMENT_EXTRACTION_CONFIDENCE = 0.95;

export interface RetirementPdfReadNotes {
  /** Year-to-date amounts that were seen and deliberately NOT read into a period field. */
  ytdFiguresDropped: number;
  /** Printed subtotals (Total contributions, Total fees) that were used instead of re-adding their parts. */
  subtotalsUsed: number;
  pageMarkersSkipped: number;
  optionRows: number;
}

export interface RetirementPdfReadOk {
  ok: true;
  layout: 'RET-1';
  extraction: RetirementStatementExtraction;
  /** Informational counts for the audit trail; NOT persisted as warnings. */
  notes: RetirementPdfReadNotes;
}

export interface RetirementPdfReadInput {
  text: PdfStatementText;
  jurisdiction: 'AU' | 'IN';
  /** The person's declared currency. A different printed currency code is a warning. */
  currencyCode: string;
}

const PAGE_MARKER_RE = /^(?:page \d+(?: of \d+)?|continued(?: on next page| from previous page| overleaf)?|\(?continued\)?|.*\(continued\))$/i;
const TITLE_RE = /\bstatement\b/i;
const IDENTIFIER_RE = /^(?:member (?:number|no\.?)|account (?:number|no\.?))\s*:?\s*(.+)$/i;
const YTD_HEADER_RE = /^this period\s+year to date$/i;
const OPTION_HEADER_RE = /^option\s+units\s+unit price\s+balance$/i;
const CURRENCY_CODE_RE = /\b(AUD|INR|USD|NZD|GBP|EUR|CAD|SGD)\b/g;
/** A token that only prefixes the amount after it (`Rs.`, `AUD`, `$`, a bare minus or bracket). */
const AMOUNT_PREFIX_RE = /^(?:\(|-|\$|₹|Rs\.?|AUD|INR)+$/i;

type LabelKey =
  | 'opening' | 'closing'
  | 'employer' | 'personal' | 'salarySacrifice' | 'government' | 'rolloversIn' | 'rolloversOut'
  | 'withdrawals' | 'pensionPayments' | 'earnings' | 'fees' | 'insurance' | 'tax'
  | 'totalContributions' | 'totalFees';

/** Order matters only where two patterns could share a start; every pattern is anchored and must be followed by a non-letter. */
const LABELS: ReadonlyArray<{ key: LabelKey; re: RegExp }> = ([
  ['opening', 'opening balance'],
  ['closing', 'closing balance'],
  ['totalContributions', 'total contributions?'],
  ['totalFees', 'total fees?'],
  ['employer', 'employer contributions?'],
  ['personal', 'personal contributions?|member contributions?'],
  ['salarySacrifice', 'salary sacrifice(?:\\s+contributions?)?'],
  ['government', 'government\\s+co-?contributions?|government contributions?'],
  ['rolloversIn', 'rollovers? in|transfers? in'],
  ['rolloversOut', 'rollovers? out|transfers? out'],
  ['withdrawals', 'withdrawals?'],
  ['pensionPayments', 'pension payments?|pension paid|income payments?'],
  ['earnings', 'investment earnings|net investment returns?|investment returns?|earnings'],
  ['fees', '(?:(?:administration|investment|management)\\s+)?fees?'],
  ['insurance', 'insurance(?:\\s+premiums?)?'],
  ['tax', 'tax on contributions|income tax|contributions tax|tax'],
] as const).map(([key, alt]) => ({ key: key as LabelKey, re: new RegExp(`^(?:${alt})(?![A-Za-z])\\s*:?\\s*(.*)$`, 'i') }));

/** One money token. Two decimals, or a whole amount carrying a currency symbol; CR/DR suffixes are not placed (null). */
function parseAmountToken(raw: string): { minor: number; negative: boolean } | null {
  const m = parseMoney(raw);
  if (!m || m.suffix !== null) return null;
  const decimals = raw.trim().match(/\.(\d+)\s*\)?$/);
  if (decimals ? decimals[1].length !== 2 : !/[$₹]/.test(raw)) return null;
  return { minor: m.minor, negative: m.negative };
}

function tokenise(rest: string): string[] {
  const out: string[] = [];
  for (const tok of rest.split(' ').filter(Boolean)) {
    const last = out.length - 1;
    if (last >= 0 && AMOUNT_PREFIX_RE.test(out[last])) out[last] = `${out[last]} ${tok}`;
    else out.push(tok);
  }
  return out;
}

function carriesAmount(t: string): boolean {
  return tokenise(t).some((tok) => parseAmountToken(tok) !== null);
}

function matchLabel(t: string): { key: LabelKey; rest: string } | null {
  for (const { key, re } of LABELS) {
    const m = t.match(re);
    if (m) return { key, rest: m[1] };
  }
  return null;
}

type Kind = 'balance' | 'credit' | 'cost' | 'earnings';
const KIND: Record<LabelKey, Kind> = {
  opening: 'balance', closing: 'balance',
  employer: 'credit', personal: 'credit', salarySacrifice: 'credit', government: 'credit', rolloversIn: 'credit', totalContributions: 'credit',
  rolloversOut: 'cost', withdrawals: 'cost', pensionPayments: 'cost', fees: 'cost', insurance: 'cost', tax: 'cost', totalFees: 'cost',
  earnings: 'earnings',
};

function decimal(minor: number | undefined): string | undefined {
  return minor === undefined ? undefined : minorToDecimalString(minor);
}

export function readRetirementPdf(input: RetirementPdfReadInput): RetirementPdfReadOk | PdfReadFailure {
  const { text } = input;

  if (!checkRetirementClass(text.text).ok) return pdfFailure('not_this_class');

  const lines = text.lines;

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

  // --- no certified India layout exists ---------------------------------------------------------------------------
  if (input.jurisdiction === 'IN') return pdfFailure('layout_unsupported', 'no_certified_india_layout');

  // --- one pass over the lines ------------------------------------------------------------------------------------
  const notes: RetirementPdfReadNotes = { ytdFiguresDropped: 0, subtotalsUsed: 0, pageMarkersSkipped: 0, optionRows: 0 };
  const warnings: string[] = [];
  const single: Partial<Record<LabelKey, number>> = {};
  const feeParts: number[] = [];
  const taxParts: number[] = [];
  const positions: RetirementPositionEvidence[] = [];
  const optionMinors: Array<{ units: string; price: string; balance: number }> = [];

  let unread = 0;
  let movementLines = 0;
  let twoColumn = false;
  let inOptions = false;
  let maskedAccountIdentifier: string | undefined;
  let periodStart: string | undefined;
  let periodEnd: string | undefined;
  let statementDate: string | undefined;
  let titleLine: string | undefined;
  const first = lines[0]?.text;

  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i].text;
    const page = lines[i].page;

    if (titleLine === undefined && i <= 5 && TITLE_RE.test(t) && !t.includes(':') && !carriesAmount(t)) {
      titleLine = t;
      continue;
    }
    if (PAGE_MARKER_RE.test(t) || (page > 1 && (t === first || t === titleLine))) {
      notes.pageMarkersSkipped += 1;
      continue;
    }
    if (YTD_HEADER_RE.test(t)) {
      if (twoColumn) notes.pageMarkersSkipped += 1;
      twoColumn = true;
      continue;
    }
    if (OPTION_HEADER_RE.test(t)) {
      if (inOptions) notes.pageMarkersSkipped += 1;
      inOptions = true;
      continue;
    }

    // Header fields (none of them carries an amount).
    const id = t.match(IDENTIFIER_RE);
    if (id) {
      const masked = maskedLastFour(id[1]);
      if (maskedAccountIdentifier === undefined && masked) maskedAccountIdentifier = masked;
      continue;
    }
    if (/^statement period\b/i.test(t)) {
      const range = parseDateRange(t);
      if (!range) { unread += 1; continue; }
      if (periodStart === undefined) { periodStart = range.start; periodEnd = range.end; }
      continue;
    }
    if (/^statement date\b/i.test(t)) {
      const d = firstDate(t);
      if (!d) { unread += 1; continue; }
      if (statementDate === undefined) statementDate = d;
      continue;
    }

    // Known label with one amount (two in the This period / Year to date form).
    const label = matchLabel(t);
    if (label) {
      const tokens = tokenise(label.rest);
      const parsed = tokens.map(parseAmountToken);
      if (tokens.length >= 1 && tokens.length <= 2 && parsed.every((p) => p !== null)) {
        const key = label.key;
        const kind = KIND[key];
        const isBalance = kind === 'balance';
        const wanted = !isBalance && twoColumn ? 2 : 1;
        const money = parsed[0];
        if (tokens.length !== wanted || !money) { unread += 1; continue; }
        if (wanted === 2) notes.ytdFiguresDropped += 1;

        let minor: number;
        if (kind === 'cost') minor = Math.abs(money.minor);
        else if (kind === 'earnings') minor = money.minor;
        else if (money.negative) { unread += 1; continue; } // a balance or a credit printed negative cannot be placed
        else minor = money.minor;

        if (key === 'fees') feeParts.push(minor);
        else if (key === 'tax') taxParts.push(minor);
        else if (single[key] !== undefined) { unread += 1; continue; } // the same label twice is not placed
        else single[key] = minor;

        if (!isBalance) movementLines += 1;
        if (key === 'totalContributions' || key === 'totalFees') notes.subtotalsUsed += 1;
        continue;
      }
    }

    // Investment options table: `<name> <units> <unit price> <balance>`.
    if (inOptions) {
      const toks = t.split(' ').filter(Boolean);
      if (toks.length >= 4) {
        const balance = parseAmountToken(toks[toks.length - 1]);
        const priceTok = toks[toks.length - 2];
        const unitsTok = toks[toks.length - 3];
        const price = /^[($-]/.test(priceTok) ? null : parseExactDecimal(priceTok);
        const units = /^[($-]/.test(unitsTok) ? null : parseExactDecimal(unitsTok);
        const name = toks.slice(0, -3).join(' ');
        if (balance && !balance.negative && price !== null && units !== null && /[A-Za-z]/.test(name)) {
          notes.optionRows += 1;
          optionMinors.push({ units, price, balance: balance.minor });
          positions.push({
            optionNameRaw: name,
            units,
            unitPrice: price,
            marketValue: minorToDecimalString(balance.minor),
            currencyCode: input.currencyCode,
            sourceRowNumber: positions.length + 1,
          });
          continue;
        }
      }
    }

    // Anything else that carries an amount is a line the reader cannot place: never ignored.
    if (carriesAmount(t)) unread += 1;
  }

  // --- the layout must match before any line is judged ------------------------------------------------------------
  if (single.opening === undefined || single.closing === undefined) return pdfFailure('layout_unsupported', 'balances_not_printed');
  if (movementLines === 0) return pdfFailure('layout_unsupported', 'no_movement_lines');
  if (unread > 0) return pdfFailure('unread_lines', `unread_${unread}`);

  // --- subtotals: used instead of their parts, and the parts must sum to them --------------------------------------
  const contributionParts = [single.employer, single.personal, single.salarySacrifice, single.government].filter((v): v is number => v !== undefined);
  if (single.totalContributions !== undefined) {
    if (contributionParts.length === 0) return pdfFailure('unread_lines', 'contributions_subtotal_without_parts');
    if (contributionParts.reduce((a, b) => a + b, 0) !== single.totalContributions) warnings.push('subtotal_mismatch_contributions');
  }
  let fees: number | undefined;
  if (single.totalFees !== undefined) {
    fees = single.totalFees;
    if (feeParts.length > 0 && feeParts.reduce((a, b) => a + b, 0) !== single.totalFees) warnings.push('subtotal_mismatch_fees');
  } else if (feeParts.length > 0) {
    fees = feeParts.reduce((a, b) => a + b, 0);
  }
  const tax = taxParts.length > 0 ? taxParts.reduce((a, b) => a + b, 0) : undefined;

  // --- PDF-only checks (warnings force review; they do not stop the read) ------------------------------------------
  optionMinors.forEach((o, idx) => {
    if (Math.abs(multiplyToMinor(o.units, o.price) - o.balance) > 1) warnings.push(`value_not_units_times_price_row_${idx + 1}`);
  });
  if (optionMinors.length > 0 && optionMinors.reduce((a, o) => a + o.balance, 0) !== single.closing) warnings.push('options_do_not_sum_to_closing');
  const printed = new Set([...text.text.matchAll(CURRENCY_CODE_RE)].map((m) => m[1]));
  if ([...printed].some((c) => c !== input.currencyCode)) warnings.push('printed_currency_differs_from_declared');

  for (const p of positions) p.valuationDate = periodEnd;

  // --- header ------------------------------------------------------------------------------------------------------
  let fundName: string | undefined;
  if (first && first.length >= 2 && first.length <= 80 && !TITLE_RE.test(first) && !/^\d/.test(first) && !IDENTIFIER_RE.test(first) && !carriesAmount(first)) fundName = first;

  let statementType: RetirementStatementType = 'super_member_statement';
  if (titleLine && /pension/i.test(titleLine)) statementType = 'account_based_pension_statement';
  else if (titleLine && /annual/i.test(titleLine)) statementType = 'super_annual_statement';

  const extraction: RetirementStatementExtraction = {
    statementType,
    jurisdiction: input.jurisdiction,
    // Never read from the page: it is decided by the existing account-matching step.
    accountType: 'unknown',
    fundName,
    maskedAccountIdentifier,
    currencyCode: input.currencyCode,
    statementDate,
    statementStartDate: periodStart,
    statementEndDate: periodEnd,
    openingBalance: decimal(single.opening),
    closingBalance: decimal(single.closing),
    employerContributions: decimal(single.employer),
    personalContributions: decimal(single.personal),
    salarySacrifice: decimal(single.salarySacrifice),
    governmentContributions: decimal(single.government),
    rolloversIn: decimal(single.rolloversIn),
    rolloversOut: decimal(single.rolloversOut),
    withdrawals: decimal(single.withdrawals),
    pensionPayments: decimal(single.pensionPayments),
    investmentEarnings: decimal(single.earnings),
    fees: decimal(fees),
    insurancePremiums: decimal(single.insurance),
    tax: decimal(tax),
    activities: [],
    positions,
    parserName: FDH_PDF_RETIREMENT_PARSER_NAME,
    parserVersion: FDH_PDF_RETIREMENT_PARSER_VERSION,
    extractionConfidence: FDH_PDF_RETIREMENT_EXTRACTION_CONFIDENCE,
    warnings,
  };

  return { ok: true, layout: 'RET-1', extraction, notes };
}
