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
export function mapBankStatementFactsToDraft(facts: BankStatementDocumentFacts): MappedBankStatementDraft | null {
  const rows: ReadBankStatementRow[] = [];
  const warnings: string[] = [];

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
    if (amount < 0) {
      // The schema and the prompt both require a positive magnitude with
      // direction carried separately. A negative here means the model
      // double-encoded the direction; take the magnitude and record it,
      // rather than letting a sign silently invert the rollforward.
      warnings.push(`ai_row_${index + 1}_negative_amount_normalised`);
    }
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
  };
}
