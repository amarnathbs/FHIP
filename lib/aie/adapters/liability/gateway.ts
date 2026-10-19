/**
 * AIE liability-statement AI-fallback adapter — the one call site that
 * reaches the AI provider for this document type.
 *
 * Everything about HOW the provider is called (the one shared gateway, the
 * shared `AIE_AI_FALLBACK_ENABLED` kill switch, the shared cost
 * reserve/settle, the shared anti-invention preamble and format instructions,
 * the re-validation of the response against this adapter's own Zod schema)
 * lives in `lib/aie/adapters/shared/gateway.ts`. This file supplies only what
 * is genuinely liability-statement-specific: the schema identity and the one
 * paragraph of the system prompt that describes the document.
 */

import {
  requestAdapterDocumentFacts,
  buildDocumentFactsSystemPrompt,
  type AieAdapterExtractionOutcome,
} from '../shared/gateway';
import {
  liabilityStatementDocumentFactsSchema,
  registerLiabilityStatementDocumentFactsSchema,
  AIE_LIABILITY_FACTS_SCHEMA_NAME,
  AIE_LIABILITY_FACTS_SCHEMA_VERSION,
  AIE_LIABILITY_MAX_ACTIVITIES,
  type LiabilityStatementDocumentFacts,
} from './schema';

export type LiabilityAiExtractionOutcome = AieAdapterExtractionOutcome<LiabilityStatementDocumentFacts>;

/**
 * Exported (not inlined) so a live-DEV proof exercises the EXACT production
 * prompt rather than a hand-retyped copy that could silently drift from it —
 * the same discipline `PAYSLIP_AI_EXTRACTION_SYSTEM_PROMPT` and
 * `BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT` established.
 *
 * THE ACTIVITY-TYPE PARAGRAPH IS THE LOAD-BEARING PART. The enum is FDH-10's
 * own DB vocabulary, and the distinctions it draws (a PAYMENT reduces what is
 * owed; a PURCHASE increases it; a REFUND is not a PAYMENT; a LOAN_ADVANCE is
 * not a PURCHASE) are precisely the ones a model gets wrong if it is handed a
 * bare enum with no explanation — and getting one wrong moves real money
 * between the statement's totals, which is then visible to the user as a
 * reconciliation variance rather than being silently wrong. The instruction
 * not to emit opening/closing/subtotal lines matters for the same reason.
 */
function liabilityDocumentDescription(sourceNote: string): string {
  return (
    `The evidence is a credit-card or loan account statement ${sourceNote}. Read the statement header (institution or lender, the masked card/account identifier as printed, the statement period, the statement date, the payment due date, the opening and closing balance, and — only if the document prints them — the credit limit, the minimum payment due, and the interest rate as a percentage) and then every activity line in the transaction table, in the order printed. ` +
    'For each activity report its date, its amount as a positive number, the description and merchant exactly as printed (null if the statement prints none), and its type using exactly one of these meanings: ' +
    'PURCHASE (a card purchase or other spend that increases what is owed), REFUND (money returned by a merchant), PAYMENT (a repayment the account holder made that reduces what is owed), CASH_ADVANCE (cash withdrawn against the facility), INTEREST (interest charged), FEE (a fee or charge), PRINCIPAL (a principal-only reduction line), LOAN_ADVANCE (a further drawdown or redraw that increases the loan), ADJUSTMENT (a correction), OTHER (anything else printed as a line). ' +
    'If, and only if, the statement itself prints a split of a repayment into principal, interest and fee amounts, copy those into principalComponent, interestComponent and feeComponent on that line; never calculate or estimate a split yourself — return null for each component the statement does not print. ' +
    'Do not include opening-balance, closing-balance, balance-carried-forward, subtotal or "total" summary lines as activities — they are not activities, and including them would double-count. ' +
    `Report at most ${AIE_LIABILITY_MAX_ACTIVITIES} activities; if the statement prints more than that, report the first ${AIE_LIABILITY_MAX_ACTIVITIES} and set allActivitiesListed to false. Set allActivitiesListed to true only if you have listed every activity printed in the document.`
  );
}

export const LIABILITY_AI_EXTRACTION_SYSTEM_PROMPT = buildDocumentFactsSystemPrompt(liabilityDocumentDescription('exported as text'));

/**
 * PDF statement route (19/10/2026): the same reading task, told honestly that the text came out of a PDF. Two extra instructions, both
 * about things a flattened PDF text layer loses and a model otherwise guesses: a section heading says which way the lines below it
 * go, and a date printed without a year takes its year from the statement period ONLY where the period makes the year certain.
 * Every other sentence is identical to the CSV prompt. The model, the schema, the cap and the cost ledger are unchanged.
 */
export const LIABILITY_AI_PDF_EXTRACTION_SYSTEM_PROMPT = buildDocumentFactsSystemPrompt(
  liabilityDocumentDescription(
    'whose text was extracted from a PDF (columns may be flattened, and a section heading such as "Payments and credits" or "Purchases and charges" tells you what the lines below it are). If a line prints a date without a year, complete the year from the printed statement period only when the period makes the year certain; otherwise return null for that date',
  ),
);

/**
 * Requests a whole-document extraction of `maskedText` — already masked by
 * the caller. This function never sees raw statement text.
 *
 * `requestId` should be stable per document so a retry reuses the SAME
 * idempotency key and collapses at the gateway's in-flight layer rather than
 * double-billing a statement that is expensive to re-read.
 */
export async function requestLiabilityAiExtraction(params: { maskedText: string; requestId?: string; userId: string; sourceFormat?: 'csv' | 'pdf' }): Promise<LiabilityAiExtractionOutcome> {
  registerLiabilityStatementDocumentFactsSchema();
  return requestAdapterDocumentFacts({
    schema: liabilityStatementDocumentFactsSchema,
    schemaName: AIE_LIABILITY_FACTS_SCHEMA_NAME,
    schemaVersion: AIE_LIABILITY_FACTS_SCHEMA_VERSION,
    systemPrompt: params.sourceFormat === 'pdf' ? LIABILITY_AI_PDF_EXTRACTION_SYSTEM_PROMPT : LIABILITY_AI_EXTRACTION_SYSTEM_PROMPT,
    maskedText: params.maskedText,
    // A distinct prefix per route: the cost ledger's idempotency key then attributes spend to the PDF route (cost attribution).
    idempotencyPrefix: params.sourceFormat === 'pdf' ? 'liability-statement-pdf-ai-fallback' : 'liability-statement-ai-fallback',
    requestId: params.requestId,
    userId: params.userId,
    // A liability statement is a line-item document — see
    // `getAieAiMaxOutputTokensPerLineItemDocument()` for why that needs its
    // own output budget rather than the 512-token scalar default.
    lineItemDocument: true,
  });
}
