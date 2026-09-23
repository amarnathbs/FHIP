/**
 * AIE AU investment-statement (FDH-11) AI-fallback adapter — the one call site
 * that reaches the AI provider for this document type.
 *
 * Everything about HOW the provider is called (the one shared gateway, the
 * shared `AIE_AI_FALLBACK_ENABLED` kill switch, the shared cost
 * reserve/settle, the shared format instructions, the re-validation of the
 * response against this adapter's own Zod schema) lives in
 * `lib/aie/adapters/shared/gateway.ts`. This file supplies only what is
 * genuinely investment-statement-specific: the schema identity and the one
 * paragraph of the system prompt that describes the document.
 */

import {
  requestAdapterDocumentFacts,
  buildDocumentFactsSystemPrompt,
  type AieAdapterExtractionOutcome,
} from '../shared/gateway';
import {
  auInvestmentDocumentFactsSchema,
  registerAuInvestmentDocumentFactsSchema,
  AIE_AU_INVESTMENT_FACTS_SCHEMA_NAME,
  AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION,
  AIE_AU_INVESTMENT_MAX_HOLDINGS,
  AIE_AU_INVESTMENT_MAX_TRANSACTIONS,
  type AuInvestmentDocumentFacts,
} from './schema';

export type AuInvestmentAiExtractionOutcome = AieAdapterExtractionOutcome<AuInvestmentDocumentFacts>;

/**
 * Exported (not inlined) so an opt-in live-DEV proof exercises the EXACT
 * production prompt rather than a hand-retyped copy that could silently drift
 * from it — the same discipline `PAYSLIP_AI_EXTRACTION_SYSTEM_PROMPT` and
 * `BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT` established.
 *
 * The paragraph does three jobs beyond describing the document: it tells the
 * model which of the two tables it is looking at (AU broker exports routinely
 * print both a holdings table and an activity table in one file, and putting
 * a holdings row in the activity array would double-count the position), it
 * names `UNKNOWN` as the honest answer for an unclassifiable line rather than
 * letting the closed enum push the model into the nearest-looking type, and it
 * forbids summary/total rows, which are the single most common thing a
 * line-item reader turns into a phantom transaction.
 */
export const AU_INVESTMENT_AI_EXTRACTION_SYSTEM_PROMPT = buildDocumentFactsSystemPrompt(
  'The evidence is an Australian share-broker, share-registry or managed-fund statement export. It may contain a HOLDINGS table (what is owned right now), an ACTIVITY/TRANSACTION table (what happened over a period), or both. ' +
    'Read the statement header (the institution, the statement date, and the period the statement covers). ' +
    'For each HOLDINGS row report the security name exactly as printed, its exchange code if printed, its ISIN if printed, the number of units held, the unit price if printed, the market value if printed, and the valuation date printed for that row if there is one (otherwise null). ' +
    'For each ACTIVITY row report what kind of line it is, the trade date and the settlement date if both are printed (never reuse one as the other), the security name and code if the line names one, the units and unit price if printed, the amount as a positive number, and the brokerage if it is printed as a separate column on that line. ' +
    'If an activity line\'s meaning is not clearly printed, report its type as UNKNOWN rather than choosing the closest-looking type. ' +
    'Never put a holdings row in the activity list or an activity row in the holdings list. ' +
    'Do not report subtotal, total, carried-forward, "opening balance" or "closing balance" summary lines as either a holding or an activity — they are not rows, and including them would double-count. ' +
    `Report at most ${AIE_AU_INVESTMENT_MAX_HOLDINGS} holdings and at most ${AIE_AU_INVESTMENT_MAX_TRANSACTIONS} activities; if the statement prints more than that, report the first of each and set allRowsListed to false. Set allRowsListed to true only if you have listed every holding and every activity printed in the document.`,
);

/**
 * Requests a whole-document extraction of `maskedText` — already masked by
 * the caller. This function never sees raw statement text.
 *
 * `requestId` should be stable per document so a retry reuses the SAME
 * idempotency key and collapses at the gateway's in-flight layer rather than
 * double-billing a statement that is expensive to re-read.
 */
export async function requestAuInvestmentAiExtraction(params: { maskedText: string; requestId?: string }): Promise<AuInvestmentAiExtractionOutcome> {
  registerAuInvestmentDocumentFactsSchema();
  return requestAdapterDocumentFacts({
    schema: auInvestmentDocumentFactsSchema,
    schemaName: AIE_AU_INVESTMENT_FACTS_SCHEMA_NAME,
    schemaVersion: AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION,
    systemPrompt: AU_INVESTMENT_AI_EXTRACTION_SYSTEM_PROMPT,
    maskedText: params.maskedText,
    idempotencyPrefix: 'au-investment-statement-ai-fallback',
    requestId: params.requestId,
    // An investment statement is a line-item document — and one with TWO
    // arrays — so it needs the larger line-item output budget rather than the
    // 512-token scalar default. See
    // `getAieAiMaxOutputTokensPerLineItemDocument()`'s header.
    lineItemDocument: true,
  });
}
