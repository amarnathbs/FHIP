/**
 * Document2 (4) WP-G (F15) -- reading a LONG bank statement through the AI in PARTS. Pure: no I/O, no AI call.
 *
 * WHY. One AI reading of a whole statement takes time proportional to the lines it must write out (DEV, WP-E: 25 lines 29.6 s,
 * 120 lines 66 s) and is capped at 80 lines per reading (AIE_BANK_STATEMENT_MAX_TRANSACTIONS). Neither fits a 28-second request.
 * The masked page text is therefore cut into PARTS of a few dozen lines (whole pages where they fit, a page split at a line
 * that starts a new dated entry where it does not); each part is one small AI reading with its own cost reservation and its own
 * stored result; the parts are merged, in order, into the SAME reviewable draft a single reading used to produce.
 *
 * WHAT IS NOT CHANGED. The text a part carries was masked by the shared gate before any part existed; the deterministic downstream
 * (fingerprints, duplicate decisions, balance rollforward, certification) still runs on the merged rows exactly as before, and
 * the rollforward is what catches a line lost at a part boundary: a missing or doubled line makes the closing balance disagree
 * and the statement lands in review instead of being certified.
 */

import type { MappedBankStatementDraft } from '@/lib/aie/adapters/bankStatement/mapping';
import type { ReadBankStatementRow } from '../bank-pdf/orchestrator';
import type { PdfStatementMetadata } from '../bank-pdf/metadata';

/** Separator between pages while the text is masked as ONE string (so identifier tokens stay consistent); a form feed never
 * matches a masking rule, and it is split on again straight after masking. */
export const AI_PAGE_SEPARATOR = '\n\f\n';

export interface AiTextPart {
  seq: number;
  pageFrom: number;
  pageTo: number;
  lineCount: number;
  text: string;
}

export interface SplitOptions {
  /** Target text lines per part. A transaction is normally one or two lines, so this is about 12 to 30 transactions. */
  targetLines?: number;
  /** Hard cap on characters per part. */
  maxChars?: number;
}

// MEASURED on DEV with the real provider (scripts/doc2_4_wp_g_ai_timing.ts, 21-10-2026): 10 lines 7 s, 20 lines 11 s, 28 lines 13.5 s
// (14.5 s with four parts at once), 40 lines past the 15 s call bound. About 0.45 s per line plus 2.5 s. 18 lines is about 10.5 s: a
// safe margin under the 15 s bound, and four to six parts in parallel cost no extra wall-clock time.
export const AI_PART_TARGET_LINES = 18;
export const AI_PART_MAX_CHARS = 3_600;

const DATED_LINE = /^\s*(\d{1,2}[/.\-]\d{1,2}([/.\-]\d{2,4})?|\d{1,2}\s+[A-Za-z]{3,9}(\s+\d{2,4})?|[A-Za-z]{3,9}\s+\d{1,2}(,\s*\d{4})?|\d{4}-\d{2}-\d{2})\b/;

function splitOversizedPage(lines: string[], target: number, maxChars: number): string[][] {
  const out: string[][] = [];
  let i = 0;
  while (i < lines.length) {
    // Balanced windows (never more than the target): 20 lines become 10 + 10, not 18 + 2.
    const pieces = Math.ceil((lines.length - i) / target);
    const window = Math.ceil((lines.length - i) / pieces);
    let end = Math.min(lines.length, i + window);
    // Prefer to end just before a line that starts a new dated entry, within the back 40 percent of the window.
    if (end < lines.length) {
      const floor = i + Math.max(1, Math.floor(window * 0.6));
      for (let k = end; k >= floor; k -= 1) {
        if (DATED_LINE.test(lines[k])) {
          end = k;
          break;
        }
      }
    }
    // Respect the character cap.
    let chars = 0;
    let capEnd = i;
    while (capEnd < end && chars + lines[capEnd].length + 1 <= maxChars) {
      chars += lines[capEnd].length + 1;
      capEnd += 1;
    }
    if (capEnd === i) capEnd = i + 1; // a single enormous line still has to go somewhere
    out.push(lines.slice(i, capEnd));
    i = capEnd;
  }
  return out;
}

/** Cuts already-MASKED page texts into parts, in page order. */
export function splitMaskedPagesIntoParts(pages: readonly string[], options: SplitOptions = {}): AiTextPart[] {
  const target = Math.max(8, options.targetLines ?? AI_PART_TARGET_LINES);
  const maxChars = Math.max(1_000, options.maxChars ?? AI_PART_MAX_CHARS);
  const parts: AiTextPart[] = [];

  let cur: string[] = [];
  let curChars = 0;
  let from = 0;
  let to = 0;
  const flush = () => {
    if (cur.length === 0) return;
    parts.push({ seq: parts.length, pageFrom: from + 1, pageTo: to + 1, lineCount: cur.length, text: cur.join('\n') });
    cur = [];
    curChars = 0;
  };

  pages.forEach((page, pageIndex) => {
    const lines = page.split('\n').map((l) => l.replace(/\s+$/g, '')).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return;
    const chars = lines.reduce((sum, l) => sum + l.length + 1, 0);
    const fits = cur.length + lines.length <= target && curChars + chars <= maxChars;
    if (cur.length > 0 && !fits) flush();
    // A page over the target is split (DEV, 21-10-2026: a 27-line part timed out three times; no part may exceed the target).
    if (lines.length > target || chars > maxChars) {
      // A page bigger than one part: split it by lines, each piece its own part (after flushing what came before).
      flush();
      for (const piece of splitOversizedPage(lines, target, maxChars)) {
        from = pageIndex;
        to = pageIndex;
        cur = piece;
        curChars = piece.reduce((sum, l) => sum + l.length + 1, 0);
        flush();
      }
      return;
    }
    if (cur.length === 0) from = pageIndex;
    to = pageIndex;
    cur.push(...lines);
    curChars += chars;
  });
  flush();
  return parts;
}

/** The text one part's AI call is given: the part's masked lines under a one-line note that says which part this is. */
export function aiPartPrompt(part: Pick<AiTextPart, 'seq' | 'pageFrom' | 'pageTo' | 'text'>, totalParts: number): string {
  const pages = part.pageFrom === part.pageTo ? `page ${part.pageFrom}` : `pages ${part.pageFrom} to ${part.pageTo}`;
  const note =
    `[This is part ${part.seq + 1} of ${totalParts} of one bank statement (${pages}). Report only the transaction lines printed in THIS part, in the order printed. ` +
    'Statement header figures (institution, account identifier, period, opening or closing balance) only if they are printed in this part, otherwise null. ' +
    'Set allTransactionsListed to true only if every transaction line in this part is listed.]';
  return `${note}\n${part.text}`;
}

/** One part's reading, after the shared mapping and the printed-figure check. */
export interface MappedPartReading {
  seq: number;
  rows: ReadBankStatementRow[];
  statementMetadata: PdfStatementMetadata;
  allTransactionsListed: boolean;
  institutionName: string | null;
  warnings: string[];
}

/** A part with no transaction lines (a page of terms and conditions) is a valid, empty reading, not a failure. */
export function mappedPartReading(seq: number, mapped: MappedBankStatementDraft | null, fallbackFacts: { allTransactionsListed: boolean; institutionName: string | null; metadata: PdfStatementMetadata }): MappedPartReading {
  if (!mapped) {
    return {
      seq,
      rows: [],
      statementMetadata: fallbackFacts.metadata,
      allTransactionsListed: fallbackFacts.allTransactionsListed,
      institutionName: fallbackFacts.institutionName,
      warnings: [],
    };
  }
  return {
    seq,
    rows: mapped.rows,
    statementMetadata: mapped.statementMetadata,
    allTransactionsListed: mapped.allTransactionsListed,
    institutionName: mapped.institutionName,
    warnings: mapped.warnings,
  };
}

export interface MergedAiReading {
  rows: Array<Omit<ReadBankStatementRow, 'sourceRowNumber'>>;
  institutionName: string | null;
  statementMetadata: PdfStatementMetadata;
  allTransactionsListed: boolean;
  warnings: string[];
  partsRead: number;
}

const MAX_WARNINGS = 40;

/**
 * Merges the parts, in part order, into one reading.
 *   - rows are concatenated in order (the confirm step renumbers them);
 *   - the opening balance and period start come from the FIRST part that prints them, the closing balance and period end from the
 *     LAST (a "balance carried forward" printed at the foot of an earlier page is not the statement's closing balance);
 *   - the reading is "complete" only if every part said it listed every line;
 *   - warnings are kept, prefixed with their part, and bounded.
 */
export function mergePartReadings(parts: readonly MappedPartReading[]): MergedAiReading {
  const ordered = [...parts].sort((a, b) => a.seq - b.seq);
  const rows: MergedAiReading['rows'] = [];
  const warnings: string[] = [];
  for (const p of ordered) {
    for (const r of p.rows) {
      rows.push({
        transactionDate: r.transactionDate,
        descriptionRaw: r.descriptionRaw,
        amountOriginal: r.amountOriginal,
        creditDebit: r.creditDebit,
        balanceAfter: r.balanceAfter,
      });
    }
    for (const w of p.warnings) if (warnings.length < MAX_WARNINGS) warnings.push(`part_${p.seq + 1}:${w}`);
  }
  const firstWith = <K extends keyof PdfStatementMetadata>(key: K): PdfStatementMetadata[K] | null => {
    for (const p of ordered) {
      const v = p.statementMetadata[key];
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  const lastWith = <K extends keyof PdfStatementMetadata>(key: K): PdfStatementMetadata[K] | null => {
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const v = ordered[i].statementMetadata[key];
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  let institutionName: string | null = null;
  for (const p of ordered) {
    if (p.institutionName) {
      institutionName = p.institutionName;
      break;
    }
  }
  const allListed = ordered.length > 0 && ordered.every((p) => p.allTransactionsListed);
  if (!allListed && warnings.length < MAX_WARNINGS) warnings.push('ai_reported_transactions_incomplete');
  return {
    rows,
    institutionName,
    statementMetadata: {
      declaredOpeningBalance: firstWith('declaredOpeningBalance') as number | null,
      declaredClosingBalance: lastWith('declaredClosingBalance') as number | null,
      maskedAccountIdentifier: firstWith('maskedAccountIdentifier') as string | null,
      statementPeriodStart: firstWith('statementPeriodStart') as string | null,
      statementPeriodEnd: lastWith('statementPeriodEnd') as string | null,
    },
    allTransactionsListed: allListed,
    warnings,
    partsRead: ordered.length,
  };
}
