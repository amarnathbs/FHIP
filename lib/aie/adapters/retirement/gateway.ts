/**
 * AIE retirement-statement AI-fallback adapter — the one call site that
 * reaches the AI provider for this document type.
 *
 * Everything about HOW the provider is called lives in
 * `lib/aie/adapters/shared/gateway.ts` (the one shared gateway, the shared
 * `AIE_AI_FALLBACK_ENABLED` kill switch, the shared cost reserve/settle, the
 * shared format instructions, and the re-validation of the response against
 * this adapter's own Zod schema). This file supplies only what is genuinely
 * retirement-specific: the schema identity and the paragraph of the system
 * prompt that describes the document.
 */

import { requestAdapterDocumentFacts, buildDocumentFactsSystemPrompt, type AieAdapterExtractionOutcome } from '../shared/gateway';
import {
  retirementDocumentFactsSchema,
  registerRetirementDocumentFactsSchema,
  AIE_RETIREMENT_FACTS_SCHEMA_NAME,
  AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
  AIE_RETIREMENT_MAX_ACTIVITIES,
  type RetirementDocumentFacts,
} from './schema';

export type RetirementAiExtractionOutcome = AieAdapterExtractionOutcome<RetirementDocumentFacts>;

/**
 * Exported (not inlined) so the live-DEV proof exercises the EXACT production
 * prompt rather than a hand-retyped copy that could silently drift from it.
 *
 * The summary-total and year-to-date instructions are the
 * retirement-specific part that matters most. A super member statement
 * routinely prints BOTH each individual contribution AND a "Total
 * contributions this year" line; treating the latter as another movement
 * would double-count the year's contributions, which is precisely the kind of
 * plausible-looking error a reviewer would not catch by eye.
 */
export const RETIREMENT_AI_EXTRACTION_SYSTEM_PROMPT = buildDocumentFactsSystemPrompt(
  'The evidence is a retirement account statement — an Australian superannuation or account-based pension statement, or an Indian EPF passbook or NPS transaction statement. ' +
    'Read the statement header (fund name, the account identifier as printed, the statement date and the period it covers), the summary figures the statement declares (opening and closing balance, and the totals it prints for contributions, rollovers, withdrawals, pension payments, earnings, fees, insurance premiums and tax), each individual activity line, and each investment option holding. ' +
    'For every activity report its type from the given list, its amount as a positive number, and its date if printed. ' +
    'CRITICALLY: set isSummaryTotal to true for any line that is a TOTAL or SUBTOTAL of other lines rather than an individual movement, and set isYearToDate to true for any line labelled year-to-date, financial-year-to-date or similar. Many statements print both the individual contributions AND a total of them; mark the total so it is not counted twice. ' +
    `Report at most ${AIE_RETIREMENT_MAX_ACTIVITIES} activity lines. ` +
    'Do not report the member number, tax file number, UAN, PRAN, date of birth or address as any value — they are not fields in this schema.',
);

/**
 * Requests a whole-document extraction of `maskedText` — already masked by
 * the caller. This function never sees raw statement text.
 */
export async function requestRetirementAiExtraction(params: { maskedText: string; requestId?: string }): Promise<RetirementAiExtractionOutcome> {
  registerRetirementDocumentFactsSchema();
  return requestAdapterDocumentFacts({
    schema: retirementDocumentFactsSchema,
    schemaName: AIE_RETIREMENT_FACTS_SCHEMA_NAME,
    schemaVersion: AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
    systemPrompt: RETIREMENT_AI_EXTRACTION_SYSTEM_PROMPT,
    maskedText: params.maskedText,
    idempotencyPrefix: 'retirement-statement-ai-fallback',
    requestId: params.requestId,
    // Activities and positions are arrays — see
    // `getAieAiMaxOutputTokensPerLineItemDocument()` for why that needs its
    // own output budget rather than the 512-token scalar default.
    lineItemDocument: true,
  });
}
