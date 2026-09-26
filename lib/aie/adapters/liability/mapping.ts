/**
 * AIE liability-statement AI-fallback adapter — maps the AI's
 * `LiabilityStatementDocumentFacts` onto the SAME shapes the existing FDH-10
 * pipeline already consumes: `LiabilityStatementActivity[]` (exactly what
 * `extractLiabilityStatement()` produces natively) plus the header values that
 * `UploadLiabilityStatementMetadata` carries.
 *
 * Because the output is the native shape, the whole downstream —
 * `reconcileCreditCardStatement` / `reconcileLoanStatement`, the per-type
 * totals arithmetic, `matchBankPayment` over every PAYMENT line, the review
 * status decision — runs completely unchanged over an AI-read statement.
 *
 * This file maps and validates. It decides nothing, writes nothing, and calls
 * nothing. `statementType` / `countryCode` / `currencyCode` / `facilityType`
 * are NOT read from the AI response — they are the caller's own context,
 * established before the AI was ever asked (and, for `facilityType`, chosen
 * explicitly by the user at the confirm step; see `schema.ts`'s header for why
 * that one is singled out).
 */

import { roundToMoneyScale } from '@/lib/financial-data-hub/bank-csv/amount';
import type { LiabilityStatementActivity } from '@/lib/financial-data-hub/liability/types';
import type { LiabilityStatementDocumentFacts } from './schema';

export const AIE_LIABILITY_PARSER_NAME = 'aie_liability_statement_ai_fallback';
export const AIE_LIABILITY_PARSER_VERSION = '1';

/**
 * The `extraction_confidence` an AI-read statement is persisted with.
 *
 * THIS IS NOT A MODEL CONFIDENCE. This adapter deliberately never asks the
 * model how sure it is (P4/REC-04 — a self-reported certainty is not
 * evidence), so there is no per-document number to record. It is a FIXED
 * PROVENANCE MARKER, chosen to sit strictly below both values the native CSV
 * extractor can emit (0.95 clean / 0.7 with warnings, see
 * `liability/csvExtraction.ts`) so that any downstream read, report or future
 * query that ranks evidence by confidence can never mistake an AI-read
 * statement for a natively-parsed one. `parser_name` carries the same fact
 * unambiguously; this is belt-and-braces for consumers that only look at the
 * number.
 */
export const AIE_LIABILITY_AI_EXTRACTION_CONFIDENCE = 0.5;

/** Minimum before this adapter will offer a draft for review at all. A
 * statement with no readable activity line is not usable liability evidence no
 * matter how confidently the header was read — the same "not usable evidence"
 * bar the payslip and bank-statement adapters set. */
export const AIE_LIABILITY_MIN_ACTIVITIES = 1;

function money(value: string | null): number | undefined {
  // `Number('')` is 0, so a blank string must be caught before the parse or it
  // becomes exactly the coerced zero the comments below rule out.
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** A nullable component amount. Unreadable is treated as ABSENT, never as
 * zero: `persistLiabilityStatementEvidence` sums these into the statement's
 * interest/fees/principal totals, and a coerced 0 would be silently claimed as
 * "the statement disclosed no interest on this line" when the truth is "we
 * could not read it". Absent leaves the total short, which the reconciliation
 * arithmetic then reports as a variance — a visible outcome rather than a
 * confident wrong one. */
function componentMoney(value: string | null): number | undefined {
  const n = money(value);
  return n === undefined ? undefined : Math.abs(n);
}

function textOrUndefined(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The masked card/account identifier, defended twice over.
 *
 * The model is told never to copy a `[MASKED:type:id]` token into a value
 * field, and the statement's own account number should already have been
 * tokenised before the model ever saw it — but "told not to" is not a
 * guarantee, and both failure modes here are cheap to eliminate:
 *   - a masking TOKEN copied through would be persisted as though it were the
 *     user's real card suffix, and would also blow FDH-10's own 40-character
 *     limit at the API boundary, producing a confusing 422 at the very last
 *     step of an otherwise successful review;
 *   - a genuine FULL account number (7+ consecutive digits) is exactly what
 *     `chk_fdh_liability_statements_masked_identifier` and the upload
 *     validation both exist to refuse, and it must not reach either.
 * In both cases the value is DROPPED, not truncated or rewritten: a
 * hand-mangled identifier is worse than none, and the user can type the real
 * last-4 themselves at the review step.
 */
function maskedIdentifierOrUndefined(value: string | null): string | undefined {
  const text = textOrUndefined(value);
  if (!text) return undefined;
  if (text.includes('[MASKED:')) return undefined;
  if (/[0-9]{7,}/.test(text)) return undefined;
  if (text.length > 40) return undefined;
  return text;
}

/** The header facts an AI read off the statement, in the same units and the
 * same optionality as `UploadLiabilityStatementMetadata`'s own fields. Every
 * one of these is shown to the user for confirmation before it is written;
 * none is applied silently. */
export interface MappedLiabilityStatementHeader {
  institutionName?: string;
  maskedIdentifier?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  statementDate?: string;
  dueDate?: string;
  openingBalance?: number;
  closingBalance?: number;
  creditLimit?: number;
  minimumPayment?: number;
  interestRate?: number;
}

export interface MappedLiabilityStatementDraft {
  activities: LiabilityStatementActivity[];
  header: MappedLiabilityStatementHeader;
  /** Surfaced to the review UI so the user is told, in words, that the model
   * said it could not list every line — and so the confirm step records the
   * incompleteness as a warning rather than quietly accepting it. */
  allActivitiesListed: boolean;
  warnings: string[];
}

/**
 * Builds the native pipeline's inputs from the AI's facts.
 *
 * Returns `null` when there is no usable activity line, which is the one
 * "this extraction is not worth showing anyone" judgement this adapter makes.
 * Every other quality question — does the statement add up, does a payment
 * match a bank transaction, does this facility already exist in the user's
 * liabilities — is deliberately NOT answered here, because the already-
 * certified FDH-10 code answers all of them better, and answering them twice
 * is how two implementations start disagreeing.
 */
export function mapLiabilityStatementFactsToDraft(facts: LiabilityStatementDocumentFacts): MappedLiabilityStatementDraft | null {
  const activities: LiabilityStatementActivity[] = [];
  const warnings: string[] = [];

  facts.activities.forEach((a, index) => {
    const amount = money(a.amount);
    // A row whose amount could not be read as a number is DROPPED rather than
    // coerced to 0. A zero-amount activity is a real and different thing from
    // an unreadable one, and silently turning the second into the first would
    // corrupt the reconciliation arithmetic that is this path's main
    // correctness check. The drop is recorded as a warning so the user sees
    // that the extraction was incomplete.
    if (amount === undefined) {
      warnings.push(`ai_activity_${index + 1}_unreadable_amount`);
      return;
    }
    // A zero-amount line moves no money and is not activity evidence; the
    // native CSV path excludes it the same way (`row_N_zero_amount`). Letting
    // it through would only fail later, at confirm time, on
    // `fdh_liability_statement_activities`' `CHECK (amount > 0)`.
    if (roundToMoneyScale(Math.abs(amount)) === 0) {
      warnings.push(`ai_activity_${index + 1}_zero_amount`);
      return;
    }
    if (amount < 0) {
      // The schema and the prompt both require a positive magnitude, with
      // meaning carried by `activityType`. A negative here means the model
      // double-encoded the direction; take the magnitude and record it,
      // rather than letting a sign silently invert a statement total.
      warnings.push(`ai_activity_${index + 1}_negative_amount_normalised`);
    }
    activities.push({
      activityType: a.activityType,
      activityDate: a.activityDate,
      amount: Math.abs(amount),
      descriptionRaw: textOrUndefined(a.descriptionRaw),
      merchantRaw: textOrUndefined(a.merchantRaw),
      principalComponent: componentMoney(a.principalComponent),
      interestComponent: componentMoney(a.interestComponent),
      feeComponent: componentMoney(a.feeComponent),
      sourceRowNumber: index + 1,
    });
  });

  if (activities.length < AIE_LIABILITY_MIN_ACTIVITIES) return null;

  if (!facts.allActivitiesListed) {
    warnings.push('ai_reported_activities_incomplete');
  }
  if (facts.documentMissingReasonCode) {
    warnings.push(`document_missing_reason:${facts.documentMissingReasonCode}`);
  }

  const maskedIdentifier = maskedIdentifierOrUndefined(facts.maskedIdentifier.value);
  if (facts.maskedIdentifier.value && !maskedIdentifier) {
    // Recorded, not silent: the user sees that the identifier we read was
    // refused, so "why is the card number blank" has a visible answer and
    // they can type the last four digits themselves.
    warnings.push('ai_masked_identifier_rejected');
  }

  return {
    activities,
    header: {
      institutionName: textOrUndefined(facts.institutionName.value),
      maskedIdentifier,
      statementPeriodStart: textOrUndefined(facts.statementPeriodStart.value),
      statementPeriodEnd: textOrUndefined(facts.statementPeriodEnd.value),
      statementDate: textOrUndefined(facts.statementDate.value),
      dueDate: textOrUndefined(facts.dueDate.value),
      openingBalance: money(facts.openingBalance.value),
      closingBalance: money(facts.closingBalance.value),
      creditLimit: money(facts.creditLimit.value),
      minimumPayment: money(facts.minimumPayment.value),
      interestRate: money(facts.interestRate.value),
    },
    allActivitiesListed: facts.allActivitiesListed,
    warnings,
  };
}
