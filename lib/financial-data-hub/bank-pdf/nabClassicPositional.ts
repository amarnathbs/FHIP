/**
 * NAB statement reader that uses TEXT POSITIONS (30-10-2026).
 *
 * WHY. NAB prints "Date  Particulars  Debits  Credits  Balance" as separate COLUMNS. Flatten the page to text and the column is lost: a
 * 12.34 under Debits and a 12.34 under Credits read the same, so a text reader (or an AI shown the text) has to guess the direction.
 * Here the direction IS the column: an amount whose right edge sits under the Debits heading is a debit, under Credits a credit, and
 * a figure under Balance (with its Cr / Dr suffix) is the running balance. Nothing is guessed.
 *
 * THE LAYOUT (real, read from a real statement; the earlier `au_nab_pdf_v1` adapter was built on an invented one):
 *   - a header line "Date | Particulars | Debits | Credits | Balance" on every page that carries transactions;
 *   - a transaction spans SEVERAL lines of Particulars (type / reference / memo on the first, the other party and a dotted leader
 *     on the last); the amount (one of Debits or Credits) is on the LAST line, and the amount line ends the transaction;
 *   - the date is printed only on the first transaction of a day; the next transactions take it from the line above;
 *   - the running balance is printed only on the last transaction of a day (so most lines have none);
 *   - "Brought forward" / "Carried forward" lines carry the balance across a page break; they are not transactions;
 *   - free-text notices, page footers, the account summary box and the terms are not transactions.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It reads each amount by its column and keeps every balance the statement prints. It does
 * not certify anything: `reconcileWithCheckpoints` (checkpointReconciliation.ts) checks that opening + credits - debits reproduces
 * every printed balance and the closing balance exactly.
 *
 * CONSERVATIVE BY DESIGN. If the columns cannot be located confidently on any table page, or any line has an amount the columns cannot
 * place, or a line is not a shape this reader knows, the result is `not_confident` and the caller falls back to the existing AI path
 * exactly as before. No partial or guessed reading is ever returned.
 *
 * PURE: positioned words in, rows out. No I/O.
 */

import { parseDateWithFormat } from '../bank-csv/dateFormats';
import type { PdfStatementMetadata } from './metadata';
import type { PositionedPage, PositionedWord } from './positionedText';
import type { ReconstructedRow } from './rowReconstruction';
import { cleanStatementDescription } from './descriptionCleanup';

export type NabNotConfidentReason =
  | 'no_table_header'
  | 'header_geometry'
  | 'summary_not_found'
  | 'unexpected_text_in_date_column'
  | 'unplaced_amount'
  | 'amount_not_trailing'
  | 'two_amounts_on_one_line'
  | 'balance_unreadable'
  | 'forward_line_unreadable'
  | 'no_date'
  | 'invalid_date'
  | 'no_transactions'
  | 'opening_balance_not_found';

export interface NabRow extends ReconstructedRow {
  /** True when this transaction's own lines printed a date; false when the date was carried from the line above. */
  datePrinted: boolean;
}

export interface NabCounts {
  pages: number;
  tablePages: number;
  transactions: number;
  debits: number;
  credits: number;
  datesPrinted: number;
  datesCarried: number;
  /** Lines of each excluded kind. */
  excluded: {
    headerLines: number;
    pageFooterLines: number;
    broughtForwardLines: number;
    carriedForwardLines: number;
    noticeLines: number;
    /** Lines of a narrative row (for example a rate note) that prints a balance but no amount: kept only as a balance check. */
    balanceNoteLines: number;
    nonTableTextLines: number;
    beforeTableLines: number;
    leftOverLinesAtEnd: number;
  };
  balancesRead: number;
  /** Lines that were part of a transaction started on one page and finished on the next. */
  transactionsSplitAcrossPages: number;
}

export type NabReadResult =
  | { kind: 'not_confident'; reason: NabNotConfidentReason; page?: number }
  | {
      kind: 'read';
      rows: NabRow[];
      metadata: PdfStatementMetadata;
      /** The balance printed on the first "Brought forward" line: the opening balance the arithmetic starts from. */
      openingBroughtForward: number;
      /** Balances printed on a narrative line with no amount: the running balance after `afterRowCount` transactions must equal it. */
      standaloneBalances: { afterRowCount: number; balance: number; pageNumber: number }[];
      /** Every (page, kind, balance) forward line, in order. */
      forwardLines: { pageNumber: number; kind: 'brought' | 'carried'; balance: number }[];
      summary: { openingBalance: number; closingBalance: number; totalDebits: number | null; totalCredits: number | null };
      counts: NabCounts;
    };

export const NO_PARTICULARS = '(no particulars printed)';
const Y_TOLERANCE = 3;
const AMOUNT_TOLERANCE = 6;
const FONT_TOLERANCE = 0.75;

// A money token at the END of a string: digits (optionally comma-grouped) and exactly two decimals, standing alone (preceded by
// start, whitespace, a dot leader or a currency sign), never glued to a letter or digit.
const TRAILING_MONEY = /(?:^|[\s.$])((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*$/;
const ANY_MONEY_NOT_PERCENT = /(?:^|[\s.$])(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?![\d%])/;
const DATE_TEXT = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/;
const FORWARD_LINE = /^(brought|carried)\s+forward\b/i;
const FOOTER_LINE = /\bPage\s+\d+\s+of\s+\d+\b|National Australia Bank Limited/i;

interface Line {
  y: number;
  words: PositionedWord[];
}

function groupLines(words: readonly PositionedWord[]): Line[] {
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(w.y - last.y) <= Y_TOLERANCE) last.words.push(w);
    else lines.push({ y: w.y, words: [w] });
  }
  for (const l of lines) l.words.sort((a, b) => a.x - b.x);
  return lines;
}

function joinWords(words: readonly PositionedWord[]): string {
  let out = '';
  let prevRight: number | null = null;
  for (const w of words) {
    const t = w.text.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    out += out === '' ? t : prevRight !== null && w.x - prevRight <= 0.8 ? t : ` ${t}`;
    prevRight = w.right;
  }
  return out;
}

interface Columns {
  dateLeft: number;
  partLeft: number;
  debitRight: number;
  creditRight: number;
  balanceRight: number;
  /** Words whose right edge is at or beyond this belong to the Balance cell. */
  balanceCellFrom: number;
  fontHeight: number;
  headerY: number;
}

function findHeader(lines: readonly Line[]): { index: number; columns: Columns } | 'geometry' | null {
  for (let i = 0; i < lines.length; i += 1) {
    const found = new Map<string, PositionedWord>();
    let dup = false;
    for (const w of lines[i].words) {
      const k = w.text.trim().toLowerCase();
      if (['date', 'particulars', 'debits', 'credits', 'balance'].includes(k)) {
        if (found.has(k)) dup = true;
        found.set(k, w);
      }
    }
    if (found.size !== 5 || dup) continue;
    const date = found.get('date')!;
    const part = found.get('particulars')!;
    const deb = found.get('debits')!;
    const cred = found.get('credits')!;
    const bal = found.get('balance')!;
    const ordered = date.x < part.x && part.x < deb.right && deb.right < cred.right && cred.right < bal.right;
    if (!ordered || cred.right - deb.right < 30 || bal.right - cred.right < 30 || part.x - date.x < 20) return 'geometry';
    return {
      index: i,
      columns: {
        dateLeft: date.x,
        partLeft: part.x,
        debitRight: deb.right,
        creditRight: cred.right,
        balanceRight: bal.right,
        balanceCellFrom: (cred.right + bal.right) / 2,
        fontHeight: part.height,
        headerY: lines[i].y,
      },
    };
  }
  return null;
}

function parseMoney(text: string): number {
  return Number(text.replace(/,/g, ''));
}

/** "1,234.56 Cr" -> 1234.56, "1,234.56 Dr" -> -1234.56, "0.00" -> 0, otherwise null. */
function parseBalanceCell(text: string): { value: number; raw: string } | null {
  // A zero balance is printed with no Cr / Dr (it has no side); any other figure without one is ambiguous and is refused.
  if (/^\$?\s*0\.00$/.test(text.trim())) return { value: 0, raw: '0.00' };
  const m = /^\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*(Cr|Dr)$/i.exec(text.trim());
  if (!m) return null;
  const value = parseMoney(m[1]);
  return { value: m[2].toLowerCase() === 'dr' ? -value : value, raw: `${m[2].toLowerCase() === 'dr' ? '-' : ''}${m[1]}` };
}

function parseSummaryDate(text: string): string | null {
  const parsed = parseDateWithFormat(text.replace(/\s+/g, ' ').trim(), 'D MMMM YYYY');
  if (parsed.ok && parsed.iso) return parsed.iso;
  const short = parseDateWithFormat(text.replace(/\s+/g, ' ').trim(), 'DD Mon YYYY');
  return short.ok && short.iso ? short.iso : null;
}

function isNoticeText(text: string): boolean {
  if (/\.{3,}/.test(text) || ANY_MONEY_NOT_PERCENT.test(text)) return false;
  // NAB prints its interest-rate notice in Title Case ("Please Note From 11 Aug 2025 Your Debit Int Rate Is 15.41%") on the DATE line of the next
  // transaction, so the lower-case test below misses it and the notice was glued onto that transaction's description. A sentence that opens
  // "Please note" and carries no amount and no dotted leader is a notice whatever its capitalisation.
  if (/^please note\b/i.test(text.trim())) return true;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 5) return false;
  const alphabetic = words.filter((w) => /^[A-Za-z]/.test(w));
  if (alphabetic.length < 4) return false;
  const lower = alphabetic.filter((w) => /^[a-z]/.test(w)).length;
  return lower / alphabetic.length >= 0.6;
}

interface Summary {
  openingBalance: number | null;
  closingBalance: number | null;
  totalDebits: number | null;
  totalCredits: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  maskedAccount: string | null;
}

function readSummary(lines: readonly Line[], into: Summary): void {
  const signed = (amount: string, side: string | undefined) => (side && side.toLowerCase() === 'dr' ? -parseMoney(amount) : parseMoney(amount));
  for (const line of lines) {
    const text = joinWords(line.words);
    let m: RegExpExecArray | null;
    if (into.openingBalance === null && (m = /\bOpening balance\s+\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*(Cr|Dr)?/i.exec(text))) into.openingBalance = signed(m[1], m[2]);
    if (into.closingBalance === null && (m = /\bClosing balance\s+\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})\s*(Cr|Dr)?/i.exec(text))) into.closingBalance = signed(m[1], m[2]);
    if (into.totalDebits === null && (m = /\bTotal debits\s+\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})/i.exec(text))) into.totalDebits = parseMoney(m[1]);
    if (into.totalCredits === null && (m = /\bTotal credits\s+\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})/i.exec(text))) into.totalCredits = parseMoney(m[1]);
    if (into.periodStart === null && (m = /\bStatement starts\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i.exec(text))) into.periodStart = parseSummaryDate(m[1]);
    if (into.periodEnd === null && (m = /\bStatement ends\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i.exec(text))) into.periodEnd = parseSummaryDate(m[1]);
    if (into.maskedAccount === null && (m = /\bAccount number\s+([\d][\d\s-]*\d)/i.exec(text))) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length >= 4) into.maskedAccount = `****${digits.slice(-4)}`;
    }
  }
}

export function readNabClassicStatement(pages: readonly PositionedPage[]): NabReadResult {
  const counts: NabCounts = {
    pages: pages.length,
    tablePages: 0,
    transactions: 0,
    debits: 0,
    credits: 0,
    datesPrinted: 0,
    datesCarried: 0,
    excluded: { headerLines: 0, pageFooterLines: 0, broughtForwardLines: 0, carriedForwardLines: 0, noticeLines: 0, balanceNoteLines: 0, nonTableTextLines: 0, beforeTableLines: 0, leftOverLinesAtEnd: 0 },
    balancesRead: 0,
    transactionsSplitAcrossPages: 0,
  };
  const summary: Summary = { openingBalance: null, closingBalance: null, totalDebits: null, totalCredits: null, periodStart: null, periodEnd: null, maskedAccount: null };
  const rows: NabRow[] = [];
  const forwardLines: { pageNumber: number; kind: 'brought' | 'carried'; balance: number }[] = [];
  const standaloneBalances: { afterRowCount: number; balance: number; pageNumber: number }[] = [];

  let dateInForce: { raw: string } | null = null;
  let pending: { text: string; pageNumber: number }[] = [];
  let datePrintedInTransaction = false;
  let previousLineWasNotice = false;

  for (const page of pages) {
    const lines = groupLines(page.words);
    const header = findHeader(lines);
    if (header === 'geometry') return { kind: 'not_confident', reason: 'header_geometry', page: page.pageNumber };
    if (header === null) {
      // A page with no table (the last, a terms page). Its text is not transactions; the summary may still be on it.
      readSummary(lines, summary);
      counts.excluded.nonTableTextLines += lines.length;
      continue;
    }
    counts.tablePages += 1;
    const { columns: c } = header;
    // Text in the margins outside the table (a vertical reference code down the left edge, for one) is not part of any line of it;
    // left in, it would put a differently-sized word on a transaction's line and the whole line would be lost. Lines are therefore
    // rebuilt from the words inside the table's horizontal extent.
    const inside = groupLines(page.words.filter((w) => w.x >= c.dateLeft - 4 && w.right <= c.balanceRight + 25));
    const headerAt = inside.findIndex((l) => Math.abs(l.y - c.headerY) <= Y_TOLERANCE);
    if (headerAt < 0) return { kind: 'not_confident', reason: 'header_geometry', page: page.pageNumber };
    readSummary(inside.slice(0, headerAt), summary);
    counts.excluded.beforeTableLines += headerAt;
    counts.excluded.headerLines += 1;
    if (pending.length > 0) counts.transactionsSplitAcrossPages += 1;

    for (const line of inside.slice(headerAt + 1)) {
      const lineText = joinWords(line.words);
      if (FOOTER_LINE.test(lineText)) {
        counts.excluded.pageFooterLines += 1;
        continue;
      }
      // Terms, outlet details and the like are set smaller than the table; transaction lines are the header's size.
      if (line.words.some((w) => Math.abs(w.height - c.fontHeight) > FONT_TOLERANCE)) {
        counts.excluded.nonTableTextLines += 1;
        continue;
      }

      const wasNotice = previousLineWasNotice;
      previousLineWasNotice = false;
      const dateWords: PositionedWord[] = [];
      const balanceWords: PositionedWord[] = [];
      const bodyWords: PositionedWord[] = [];
      for (const w of line.words) {
        if (w.right <= c.partLeft - 2) dateWords.push(w);
        else if (w.x >= c.creditRight + 5 && w.right >= c.balanceCellFrom) balanceWords.push(w);
        else bodyWords.push(w);
      }

      let printedDate: string | null = null;
      if (dateWords.length > 0) {
        const t = joinWords(dateWords);
        if (!DATE_TEXT.test(t)) return { kind: 'not_confident', reason: 'unexpected_text_in_date_column', page: page.pageNumber };
        printedDate = t.replace(/\s+/g, ' ');
      }

      // Amounts, placed by the column their right edge sits under.
      const amounts: { side: 'debit' | 'credit'; text: string }[] = [];
      const particulars: PositionedWord[] = [];
      for (const w of bodyWords) {
        const money = TRAILING_MONEY.exec(w.text);
        const nearDebit = Math.abs(w.right - c.debitRight) <= AMOUNT_TOLERANCE;
        const nearCredit = Math.abs(w.right - c.creditRight) <= AMOUNT_TOLERANCE;
        if (money && (nearDebit || nearCredit)) {
          amounts.push({ side: nearDebit ? 'debit' : 'credit', text: money[1] });
          const trimmed = w.text.trimEnd();
          particulars.push({ ...w, text: trimmed.slice(0, trimmed.length - money[1].length) });
          continue;
        }
        if (money && w.right > c.debitRight + AMOUNT_TOLERANCE) return { kind: 'not_confident', reason: 'unplaced_amount', page: page.pageNumber };
        if (!money && (nearDebit || nearCredit) && ANY_MONEY_NOT_PERCENT.test(w.text)) return { kind: 'not_confident', reason: 'amount_not_trailing', page: page.pageNumber };
        particulars.push(w);
      }
      if (amounts.length > 1) return { kind: 'not_confident', reason: 'two_amounts_on_one_line', page: page.pageNumber };

      const particularsText = cleanStatementDescription(joinWords(particulars));
      const balanceText = joinWords(balanceWords);

      // Brought forward / Carried forward: a balance carried across a page break, not a transaction.
      const forward = FORWARD_LINE.exec(particularsText);
      if (forward) {
        const kind = forward[1].toLowerCase() === 'brought' ? 'brought' : 'carried';
        const bal = parseBalanceCell(balanceText);
        if (!bal || amounts.length > 0) return { kind: 'not_confident', reason: 'forward_line_unreadable', page: page.pageNumber };
        forwardLines.push({ pageNumber: page.pageNumber, kind, balance: bal.value });
        if (kind === 'brought') counts.excluded.broughtForwardLines += 1;
        else counts.excluded.carriedForwardLines += 1;
        if (printedDate) dateInForce = { raw: printedDate };
        continue;
      }

      if (amounts.length === 0) {
        if (balanceText !== '') {
          // A narrative row (no amount) that prints the running balance: not a transaction, but the balance is evidence, so it is
          // kept as a check. Any lines gathered since the last transaction belong to this narrative row.
          const bal = parseBalanceCell(balanceText);
          if (!bal) return { kind: 'not_confident', reason: 'balance_unreadable', page: page.pageNumber };
          if (printedDate) dateInForce = { raw: printedDate };
          standaloneBalances.push({ afterRowCount: rows.length, balance: bal.value, pageNumber: page.pageNumber });
          counts.excluded.balanceNoteLines += pending.length + 1;
          counts.balancesRead += 1;
          pending = [];
          datePrintedInTransaction = false;
          continue;
        }
        if (particularsText === '' && !printedDate) continue;
        // A free-text notice wraps over several lines: the first reads as a sentence; the lines after it are single runs of text with no
        // columns, no date and no leader (a transaction's own first line is laid out in columns: type, reference, memo).
        const continuesNotice = wasNotice && !printedDate && particulars.length === 1 && !/\.{3,}/.test(joinWords(particulars));
        if (isNoticeText(particularsText) || continuesNotice) {
          // Its date (when it has one) still sets the date in force, it is not part of a transaction.
          counts.excluded.noticeLines += 1;
          if (printedDate) dateInForce = { raw: printedDate };
          previousLineWasNotice = true;
          continue;
        }
        if (printedDate) {
          dateInForce = { raw: printedDate };
          datePrintedInTransaction = true;
        }
        if (particularsText !== '') pending.push({ text: particularsText, pageNumber: page.pageNumber });
        continue;
      }

      // An amount line: it ends a transaction.
      if (printedDate) {
        dateInForce = { raw: printedDate };
        datePrintedInTransaction = true;
      }
      if (!dateInForce) return { kind: 'not_confident', reason: 'no_date', page: page.pageNumber };
      let balanceRaw: string | null = null;
      if (balanceText !== '') {
        const bal = parseBalanceCell(balanceText);
        if (!bal) return { kind: 'not_confident', reason: 'balance_unreadable', page: page.pageNumber };
        balanceRaw = bal.raw;
        counts.balancesRead += 1;
      }
      // A line that printed no particulars at all keeps a plain statement of that, never an empty description.
      const description = cleanStatementDescription([...pending.map((p) => p.text), particularsText].filter((t) => t !== '').join(' ')) || NO_PARTICULARS;
      const side = amounts[0].side;
      rows.push({
        pageNumber: pending[0]?.pageNumber ?? page.pageNumber,
        rowIndex: rows.length + 1,
        dateRaw: dateInForce.raw,
        descriptionRaw: description,
        amountRaw: amounts[0].text,
        directionMarkerRaw: side === 'debit' ? 'DR' : 'CR',
        balanceRaw,
        numbersOnContinuationLine: false,
        datePrinted: datePrintedInTransaction,
      });
      counts.transactions += 1;
      if (side === 'debit') counts.debits += 1;
      else counts.credits += 1;
      if (datePrintedInTransaction) counts.datesPrinted += 1;
      else counts.datesCarried += 1;
      pending = [];
      datePrintedInTransaction = false;
    }
  }

  counts.excluded.leftOverLinesAtEnd = pending.length;

  if (counts.tablePages === 0) return { kind: 'not_confident', reason: 'no_table_header' };
  if (summary.openingBalance === null || summary.closingBalance === null) return { kind: 'not_confident', reason: 'summary_not_found' };
  if (rows.length === 0) return { kind: 'not_confident', reason: 'no_transactions' };
  const firstBrought = forwardLines.find((f) => f.kind === 'brought');
  if (!firstBrought) return { kind: 'not_confident', reason: 'opening_balance_not_found' };
  for (const r of rows) {
    const d = parseDateWithFormat(r.dateRaw, 'DD Mon YYYY');
    if (!d.ok) return { kind: 'not_confident', reason: 'invalid_date', page: r.pageNumber };
  }

  return {
    kind: 'read',
    rows,
    metadata: {
      declaredOpeningBalance: summary.openingBalance,
      declaredClosingBalance: summary.closingBalance,
      maskedAccountIdentifier: summary.maskedAccount,
      statementPeriodStart: summary.periodStart,
      statementPeriodEnd: summary.periodEnd,
    },
    openingBroughtForward: firstBrought.balance,
    forwardLines,
    standaloneBalances,
    summary: { openingBalance: summary.openingBalance, closingBalance: summary.closingBalance, totalDebits: summary.totalDebits, totalCredits: summary.totalCredits },
    counts,
  };
}
