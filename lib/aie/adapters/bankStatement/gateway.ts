/**
 * AIE bank-statement AI-fallback adapter — the one call site that reaches the
 * AI provider for this document type.
 *
 * Everything about HOW the provider is called (the one shared gateway, the
 * shared `AIE_AI_FALLBACK_ENABLED` kill switch, the shared cost
 * reserve/settle, the shared format instructions, the re-validation of the
 * response against this adapter's own Zod schema) lives in
 * `lib/aie/adapters/shared/gateway.ts`. This file supplies only what is
 * genuinely bank-statement-specific: the schema identity and the one
 * paragraph of the system prompt that describes the document.
 */

import {
  requestAdapterDocumentFacts,
  buildDocumentFactsSystemPrompt,
  type AieAdapterExtractionOutcome,
} from '../shared/gateway';
import {
  bankStatementDocumentFactsSchema,
  registerBankStatementDocumentFactsSchema,
  AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
  AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
  AIE_BANK_STATEMENT_MAX_TRANSACTIONS,
  type BankStatementDocumentFacts,
} from './schema';

export type BankStatementAiExtractionOutcome = AieAdapterExtractionOutcome<BankStatementDocumentFacts>;

/**
 * Exported (not inlined) so `tests/live-dev/aieUnifiedFallbackLiveProviderProof.live.test.ts`
 * exercises the EXACT production prompt rather than a hand-retyped copy that
 * could silently drift from it — the same discipline
 * `PAYSLIP_AI_EXTRACTION_SYSTEM_PROMPT` established.
 */
export const BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT = buildDocumentFactsSystemPrompt(
  'The evidence is a bank or credit-card account statement. Read the statement header (institution, account identifier, period, and the opening and closing balances the statement itself declares) and then every transaction line in the transaction table, in the order printed. ' +
    'For each transaction report the date, the description exactly as printed, the amount as a positive number, whether it was money IN to the account (credit) or money OUT of it (debit), and the running balance printed after it if the statement prints one (otherwise null). ' +
    'Do not include opening-balance, closing-balance, subtotal, carried-forward or "total" summary lines as transactions — they are not transactions, and including them would double-count. ' +
    `Report at most ${AIE_BANK_STATEMENT_MAX_TRANSACTIONS} transactions; if the statement prints more than that, report the first ${AIE_BANK_STATEMENT_MAX_TRANSACTIONS} and set allTransactionsListed to false. Set allTransactionsListed to true only if you have listed every transaction printed in the document.`,
);

/**
 * Requests a whole-document extraction of `maskedText` — already masked by
 * the caller. This function never sees raw statement text.
 *
 * `requestId` should be stable per document so a retry reuses the SAME
 * idempotency key and collapses at the gateway's in-flight layer rather than
 * double-billing a statement that is expensive to re-read.
 */
export async function requestBankStatementAiExtraction(params: { maskedText: string; requestId?: string }): Promise<BankStatementAiExtractionOutcome> {
  registerBankStatementDocumentFactsSchema();
  return requestAdapterDocumentFacts({
    schema: bankStatementDocumentFactsSchema,
    schemaName: AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
    schemaVersion: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
    systemPrompt: BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT,
    maskedText: params.maskedText,
    idempotencyPrefix: 'bank-statement-ai-fallback',
    requestId: params.requestId,
    // A statement is a line-item document — see
    // `getAieAiMaxOutputTokensPerLineItemDocument()` for why that needs its
    // own output budget rather than the 512-token scalar default.
    lineItemDocument: true,
  });
}
