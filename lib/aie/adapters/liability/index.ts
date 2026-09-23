/**
 * AIE liability-statement (credit-card / loan) AI-fallback adapter — public
 * surface.
 *
 * WHAT THIS ADAPTER IS FOR. FDH-10's native liability-statement path
 * (`lib/financial-data-hub/services/liabilityStatementProcessingService.ts`)
 * reads CSV statement exports through a registry of column-mapped adapters.
 * When none of them recognises the export's layout, or two score too closely
 * to choose between, the user's only remaining option today is to type the
 * whole statement in by hand. This adapter offers one middle step: an AI reads
 * the CSV text and proposes a DRAFT, the user reviews it, and only an explicit
 * confirmation writes anything — through the SAME
 * `persistLiabilityStatementEvidence` function a native parse uses.
 *
 * ONE DIVERGENCE FROM THE BANK-STATEMENT REFERENCE, DISCLOSED RATHER THAN
 * PAPERED OVER. Liability statements are CSV-only — there is no PDF/OCR path
 * and therefore no `extractedText` already in hand at the failure branch. The
 * calling service decodes the already-downloaded bytes with the certified
 * `decodeCsvBytes()` (the same decode the native extractor itself uses) purely
 * so that the masking layer has text to work on. No second download, and no
 * second decoding implementation.
 *
 * WHAT IS REUSED RATHER THAN REBUILT, which is the part that matters: the
 * masking layer, the provider gateway, the kill switch, the cost ledger, the
 * shared pilot cohort, the shared Zod field builders, the shared strict
 * JSON-Schema builders — and, downstream, the entire already-certified FDH-10
 * pipeline (reconciliation, totals, bank matching, the canonical write). This
 * adapter contributes only the reading of the page.
 */
export { isAieLiabilityAiFallbackEnabled } from './featureFlags';
export {
  liabilityStatementDocumentFactsSchema,
  liabilityStatementActivitySchema,
  registerLiabilityStatementDocumentFactsSchema,
  AIE_LIABILITY_FACTS_SCHEMA_NAME,
  AIE_LIABILITY_FACTS_SCHEMA_VERSION,
  AIE_LIABILITY_MAX_ACTIVITIES,
  type LiabilityStatementDocumentFacts,
  type LiabilityStatementActivityFacts,
} from './schema';
export { LIABILITY_FACTS_OPENAI_JSON_SCHEMA } from './openaiSchema';
export {
  mapLiabilityStatementFactsToDraft,
  AIE_LIABILITY_PARSER_NAME,
  AIE_LIABILITY_PARSER_VERSION,
  AIE_LIABILITY_MIN_ACTIVITIES,
  AIE_LIABILITY_AI_EXTRACTION_CONFIDENCE,
  type MappedLiabilityStatementDraft,
  type MappedLiabilityStatementHeader,
} from './mapping';
export { requestLiabilityAiExtraction, LIABILITY_AI_EXTRACTION_SYSTEM_PROMPT, type LiabilityAiExtractionOutcome } from './gateway';
