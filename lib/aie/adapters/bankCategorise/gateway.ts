/**
 * AIE bank-line categorisation -- the one call site that reaches the AI provider for this feature.
 *
 * Everything about HOW the provider is called (the one shared gateway, the shared AIE_AI_FALLBACK_ENABLED kill switch, the per-user daily cap, the
 * shared cost reserve/settle against the global ledger, the re-validation of the answer against ./schema.ts) lives in
 * lib/aie/adapters/shared/gateway.ts. This file supplies only the feature-specific part: the prompt and the schema identity.
 *
 * `maskedText` MUST already have been through evaluateAiFallbackGate (the shared masking gate); this function never sees raw text.
 */
import { requestAdapterDocumentFacts, AIE_DOCUMENT_FACTS_BASE_PROMPT, type AieAdapterExtractionOutcome } from '../shared/gateway';
import {
  AIE_BANK_CATEGORISE_MAX_PAYEES_PER_CALL,
  AIE_BANK_CATEGORISE_SCHEMA_NAME,
  AIE_BANK_CATEGORISE_SCHEMA_VERSION,
  bankCategoriseAnswerSchema,
  registerBankCategoriseSchema,
  type BankCategoriseAnswer,
} from './schema';

export type BankCategoriseOutcome = AieAdapterExtractionOutcome<BankCategoriseAnswer>;

/** The prompt names the closed category list, so the model has nothing to invent. Exported so a live proof uses the EXACT production prompt. */
export function buildBankCategoriseSystemPrompt(allowed: ReadonlyArray<{ key: string; label: string }>, opts: { bestGuess?: boolean } = {}): string {
  // Premium automatic mode (PO 05-11-2026): the person will not approve each line first, so the model is asked for its closest category every time and
  // to mark a guess as low. It may still answer "unknown", and the code files that under Other spending rather than inventing a category.
  const uncertainty = opts.bestGuess
    ? 'Always choose the closest category on the list, even when you are unsure; mark a guess with confidence "low". Answer "unknown" only if no category on the list could possibly apply. '
    : 'If you are not sure, or it could reasonably be several categories, or you cannot tell what the business is, answer "unknown" with confidence "low". ';
  return (
    `${AIE_DOCUMENT_FACTS_BASE_PROMPT} ` +
    'The evidence is a numbered list of payee descriptions copied from a bank statement (p1, p2, ...), with numbers removed. ' +
    'For each one choose the single category key that best fits what was bought, from this closed list only: ' +
    allowed.map((c) => `${c.key} (${c.label})`).join('; ') +
    `. ${uncertainty}` +
    'confidence is "high" only when the business is well known and the category is obvious, "medium" when likely, otherwise "low". ' +
    `Return one item for every payee shown (at most ${AIE_BANK_CATEGORISE_MAX_PAYEES_PER_CALL}), using the key shown. Never invent a category key, never answer with anything but the closed list or "unknown", and do not return any text of your own.`
  );
}

export async function requestBankCategorisation(params: {
  maskedText: string;
  allowed: ReadonlyArray<{ key: string; label: string }>;
  userId: string;
  requestId?: string;
  /** Premium automatic mode: ask for the closest category every time (see buildBankCategoriseSystemPrompt). */
  bestGuess?: boolean;
  timeoutMs?: number;
  maxTransientRetries?: number;
}): Promise<BankCategoriseOutcome> {
  registerBankCategoriseSchema();
  return requestAdapterDocumentFacts<typeof bankCategoriseAnswerSchema>({
    schema: bankCategoriseAnswerSchema,
    schemaName: AIE_BANK_CATEGORISE_SCHEMA_NAME,
    schemaVersion: AIE_BANK_CATEGORISE_SCHEMA_VERSION,
    systemPrompt: buildBankCategoriseSystemPrompt(params.allowed, { bestGuess: params.bestGuess }),
    maskedText: params.maskedText,
    idempotencyPrefix: 'bank-categorise-ai',
    requestId: params.requestId,
    userId: params.userId,
    // ~40 short items per answer: the larger line-item output budget, not the 512-token scalar one.
    lineItemDocument: true,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.maxTransientRetries !== undefined ? { maxTransientRetries: params.maxTransientRetries } : {}),
  });
}
