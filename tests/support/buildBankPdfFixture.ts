// FDH-5 test-only helper: builds synthetic, structurally-representative bank
// PDF statement fixtures on top of `buildMinimalTextPdf` (a genuinely valid,
// real PDF — proven against the actual `pdf-parse` library, not mocked).
// EVIDENCE STANDARD (spec 52-54): every line generated here is synthetic —
// built from each bank's documented CONVENTIONS, never from a real customer
// statement. Nothing generated here is, or is derived from, a real bank
// statement.

import { buildMinimalTextPdf } from './buildMinimalPdf';

export interface FixtureTxnLine {
  /** Pre-formatted date text in the adapter's own date format. */
  date: string;
  description: string;
  /** Pre-formatted trailing amount text (with sign, DR/CR suffix, etc. as
   * the adapter under test expects). */
  amount: string;
  balance: string;
  /** Extra description-only continuation lines (spec 33) appended AFTER
   * the date/amount line, before the next transaction. */
  continuationLines?: string[];
}

export interface BankPdfFixtureOptions {
  brandLines: string[];
  columnHeaderLine: string;
  openingBalanceLine?: string;
  closingBalanceLine?: string;
  accountLine?: string;
  transactions: FixtureTxnLine[];
  /** How many transaction lines fit per page before starting a new one —
   * used to exercise page-break/multi-page certification cases (spec 34,
   * 91). Defaults to putting everything on one page. */
  transactionsPerPage?: number;
  footerLine?: string;
}

/** Builds one page's line array for a slice of transactions, in the
 * "DATE <rest of line ending in AMOUNT BALANCE>" + optional continuation
 * lines shape every FDH-5 PDF adapter's `dateLineRegex` expects. */
function transactionLines(txns: FixtureTxnLine[]): string[] {
  const lines: string[] = [];
  for (const t of txns) {
    lines.push(`${t.date}  ${t.description}   ${t.amount}   ${t.balance}`);
    for (const c of t.continuationLines ?? []) lines.push(c);
  }
  return lines;
}

export function buildBankPdfFixture(opts: BankPdfFixtureOptions): Buffer {
  const perPage = opts.transactionsPerPage ?? (opts.transactions.length || 1);
  const pages: string[][] = [];

  const preamble = [
    ...opts.brandLines,
    ...(opts.accountLine ? [opts.accountLine] : []),
    ...(opts.openingBalanceLine ? [opts.openingBalanceLine] : []),
    ...(opts.closingBalanceLine ? [opts.closingBalanceLine] : []),
    opts.columnHeaderLine,
  ];

  for (let i = 0; i < opts.transactions.length; i += perPage) {
    const slice = opts.transactions.slice(i, i + perPage);
    const lines: string[] = i === 0 ? [...preamble] : [opts.columnHeaderLine];
    lines.push(...transactionLines(slice));
    if (opts.footerLine) lines.push(opts.footerLine);
    pages.push(lines);
  }
  if (pages.length === 0) pages.push(preamble);

  return buildMinimalTextPdf(pages);
}
