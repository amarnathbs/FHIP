/**
 * AIE bank-statement AI-fallback adapter — maps the AI's
 * `BankStatementDocumentFacts` onto the inputs the EXISTING deterministic
 * pipeline already consumes, so that `reconcileBalances`, `decideDedup`,
 * `computeEconomicFingerprint` and `decideCertification` run completely
 * unchanged over an AI-read statement.
 *
 * This file maps and validates. It decides nothing, writes nothing, and calls
 * nothing. `country`/`currencyCode`/account identity are NOT read from the AI
 * response — they are supplied by the caller from context established before
 * the AI was ever asked, matching every other adapter's "identity is never
 * AI-derived" rule.
 */

import type { PdfStatementMetadata } from '@/lib/financial-data-hub/bank-pdf/metadata';
import type { ReadBankStatementRow } from '@/lib/financial-data-hub/bank-pdf/orchestrator';
import type { BankStatementDocumentFacts } from './schema';
import { figureIsPrinted, explicitSignOfPrintedFigure } from '../shared/reviewDraft';
import { isStatementSummaryLine } from '../shared/statementSummaryLines';
import type { BankFactsNormalisationNotes } from './normalise';

export const AIE_BANK_STATEMENT_PARSER_NAME = 'aie_bank_statement_ai_fallback';
export const AIE_BANK_STATEMENT_PARSER_VERSION = '1';

/** Minimum before this adapter will offer a draft for review at all. A
 * statement with no readable transaction line is not usable bank evidence no
 * matter how confidently the header was read — the same "not usable
 * evidence" bar `PAYSLIP_AI_REQUIRED_FIELDS_ANY_OF` sets for payslips. */
export const AIE_BANK_STATEMENT_MIN_TRANSACTIONS = 1;

function money(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function nullableMoney(value: string | null): number | null {
  const n = money(value);
  return n === undefined ? null : n;
}

export interface MappedBankStatementDraft {
  rows: ReadBankStatementRow[];
  statementMetadata: PdfStatementMetadata;
  /** Surfaced to the review UI so the user is told, in words, that the model
   * said it could not list every line — and so the confirm step can refuse to
   * treat such an extraction as complete. */
  allTransactionsListed: boolean;
  institutionName: string | null;
  warnings: string[];
  /** 28-10-2026: how many KEPT lines had a running balance that was present but unreadable (set to null, line kept). A balance is
   * verification data, so it never discards a line; it makes the import land in review with a plain reason instead. */
  balancesNotRead?: number;
  /** The statement's declared opening / closing balance that was present but unreadable (0, 1 or 2). */
  declaredBalancesNotRead?: number;
  /** Kept lines whose transaction date was missing and was taken from the nearest earlier line (or the date in force at the top of
   * the part). The statement lands in review with a plain reason; the date is never guessed from nothing. */
  datesCarriedForward?: number;
}

/**
 * 2026-09-25 (other-PDF AI proof): keeps only figures the document actually
 * PRINTS. A running balance or a declared opening/closing balance the page
 * does not show is set to null (with a warning the user sees), because the
 * reconciliation that decides certification must never check the model's
 * own arithmetic against itself -- see `figureIsPrinted`. An amount that is
 * not found verbatim is kept (the user reviews every line) but flagged.
 */
export function keepOnlyPrintedBankFigures(mapped: MappedBankStatementDraft, documentText: string): MappedBankStatementDraft {
  const warnings = [...mapped.warnings];
  let signDropped = 0;
  const rows = mapped.rows.map((r) => {
    if (!figureIsPrinted(r.amountOriginal, documentText)) warnings.push(`ai_row_${r.sourceRowNumber}_amount_not_found_in_document`);
    if (r.balanceAfter !== null && !figureIsPrinted(r.balanceAfter, documentText)) {
      warnings.push(`ai_row_${r.sourceRowNumber}_balance_not_printed_dropped`);
      return { ...r, balanceAfter: null };
    }
    // 28-10-2026: the document prints this figure with an explicit sign ("34.15 DR", "(34.15)", "34.15 CR" everywhere it appears)
    // and the reading says the opposite. The sign is never guessed or flipped: the balance is dropped and COUNTED as not read.
    if (r.balanceAfter !== null && r.balanceAfter !== 0 && signContradicted(r.balanceAfter, documentText)) {
      warnings.push(`ai_row_${r.sourceRowNumber}_balance_sign_contradicts_document_dropped`);
      signDropped += 1;
      return { ...r, balanceAfter: null };
    }
    return r;
  });
  let declaredSignDropped = 0;
  const md = { ...mapped.statementMetadata };
  if (md.declaredOpeningBalance !== null && md.declaredOpeningBalance !== undefined && !figureIsPrinted(md.declaredOpeningBalance, documentText)) {
    warnings.push('ai_opening_balance_not_printed_dropped');
    md.declaredOpeningBalance = null;
  }
  if (md.declaredClosingBalance !== null && md.declaredClosingBalance !== undefined && !figureIsPrinted(md.declaredClosingBalance, documentText)) {
    warnings.push('ai_closing_balance_not_printed_dropped');
    md.declaredClosingBalance = null;
  }
  if (md.declaredOpeningBalance !== null && md.declaredOpeningBalance !== undefined && md.declaredOpeningBalance !== 0 && signContradicted(md.declaredOpeningBalance, documentText)) {
    warnings.push('ai_opening_balance_sign_contradicts_document_dropped');
    md.declaredOpeningBalance = null;
    declaredSignDropped += 1;
  }
  if (md.declaredClosingBalance !== null && md.declaredClosingBalance !== undefined && md.declaredClosingBalance !== 0 && signContradicted(md.declaredClosingBalance, documentText)) {
    warnings.push('ai_closing_balance_sign_contradicts_document_dropped');
    md.declaredClosingBalance = null;
    declaredSignDropped += 1;
  }
  const balancesNotRead = (mapped.balancesNotRead ?? 0) + signDropped;
  const declaredBalancesNotRead = (mapped.declaredBalancesNotRead ?? 0) + declaredSignDropped;
  return {
    ...mapped,
    rows,
    statementMetadata: md,
    warnings,
    ...(balancesNotRead > 0 ? { balancesNotRead } : {}),
    ...(declaredBalancesNotRead > 0 ? { declaredBalancesNotRead } : {}),
  };
}

/** True when the document prints this figure with an explicit sign that is the OPPOSITE of the reading's sign. */
function signContradicted(value: number, documentText: string): boolean {
  const printed = explicitSignOfPrintedFigure(value, documentText);
  return (value > 0 && printed === 'negative') || (value < 0 && printed === 'positive');
}

/**
 * Builds the deterministic pipeline's inputs from the AI's facts.
 *
 * Returns `null` when there is no usable transaction line, which is the one
 * "this extraction is not worth showing anyone" judgement this adapter makes.
 * Every other quality question — do the balances roll forward, are these rows
 * duplicates of an existing import, does the statement cover the declared
 * period — is deliberately NOT answered here, because the deterministic
 * pipeline answers all of them better, and answering them twice is how two
 * implementations start disagreeing.
 */
export function mapBankStatementFactsToDraft(facts: BankStatementDocumentFacts, notes?: BankFactsNormalisationNotes): MappedBankStatementDraft | null {
  const rows: ReadBankStatementRow[] = [];
  const warnings: string[] = [];
  const unreadPositions = new Set(notes?.balanceLinesNotRead ?? []);
  let balancesNotRead = 0;
  const carriedPositions = new Set(notes?.datesCarriedForward ?? []);
  let datesCarriedForward = 0;

  facts.transactions.forEach((t, index) => {
    const amount = money(t.amount);
    // A row whose amount could not be read as a number is DROPPED rather than
    // coerced to 0. A zero-amount transaction is a real and different thing
    // from an unreadable one, and silently turning the second into the first
    // would corrupt the balance rollforward that is this path's main
    // correctness check. The drop is recorded as a warning so the user sees
    // that the extraction was incomplete.
    if (amount === undefined) {
      warnings.push(`ai_row_${index + 1}_unreadable_amount`);
      return;
    }
    // A balance / summary line the model reported as a transaction
    // ("Brought forward" in production, 2026-09-26). Dropped, and recorded, so
    // it can neither enter the draft nor double-count in the rollforward.
    if (isStatementSummaryLine(t.descriptionRaw)) {
      warnings.push(`ai_row_${index + 1}_summary_line_dropped`);
      return;
    }
    if (amount < 0) {
      // The schema and the prompt both require a positive magnitude with
      // direction carried separately. A negative here means the model
      // double-encoded the direction; take the magnitude and record it,
      // rather than letting a sign silently invert the rollforward.
      warnings.push(`ai_row_${index + 1}_negative_amount_normalised`);
    }
    if (unreadPositions.has(index + 1)) balancesNotRead += 1;
    if (carriedPositions.has(index + 1)) datesCarriedForward += 1;
    rows.push({
      sourceRowNumber: index + 1,
      transactionDate: t.transactionDate,
      descriptionRaw: t.descriptionRaw,
      amountOriginal: Math.abs(amount),
      creditDebit: t.creditDebit,
      balanceAfter: nullableMoney(t.balanceAfter),
    });
  });

  if (rows.length < AIE_BANK_STATEMENT_MIN_TRANSACTIONS) return null;

  if (!facts.allTransactionsListed) {
    warnings.push('ai_reported_transactions_incomplete');
  }
  if (facts.documentMissingReasonCode) {
    warnings.push(`document_missing_reason:${facts.documentMissingReasonCode}`);
  }
  // One warning per reading (never one per line), so a statement whose every balance was unreadable cannot flood the warning list.
  if (balancesNotRead > 0) warnings.push(`ai_balances_not_read:${balancesNotRead}`);
  if (datesCarriedForward > 0) warnings.push(`ai_dates_taken_from_previous_line:${datesCarriedForward}`);
  const declaredBalancesNotRead = (notes?.declaredOpeningNotRead ? 1 : 0) + (notes?.declaredClosingNotRead ? 1 : 0);
  if (notes?.declaredOpeningNotRead) warnings.push('ai_opening_balance_not_read');
  if (notes?.declaredClosingNotRead) warnings.push('ai_closing_balance_not_read');

  const statementMetadata: PdfStatementMetadata = {
    declaredOpeningBalance: nullableMoney(facts.declaredOpeningBalance.value),
    declaredClosingBalance: nullableMoney(facts.declaredClosingBalance.value),
    maskedAccountIdentifier: facts.maskedAccountIdentifier.value,
    statementPeriodStart: facts.statementPeriodStart.value,
    statementPeriodEnd: facts.statementPeriodEnd.value,
  };

  return {
    rows,
    statementMetadata,
    allTransactionsListed: facts.allTransactionsListed,
    institutionName: facts.institutionName.value,
    warnings,
    ...(balancesNotRead > 0 ? { balancesNotRead } : {}),
    ...(declaredBalancesNotRead > 0 ? { declaredBalancesNotRead } : {}),
    ...(datesCarriedForward > 0 ? { datesCarriedForward } : {}),
  };
}
