/**
 * AIE retirement-statement AI-fallback adapter — public surface.
 *
 * See `featureFlags.ts`'s header for why this adapter's shape (a direct
 * gateway call from inside the native processing service, not the
 * orchestrator/intake/accept pipeline) was chosen, and
 * `docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md` for
 * the full design rationale.
 *
 * SCOPE NOTE, DISCLOSED. The FDH-12 native pipeline is CSV-only: it refuses a
 * PDF outright, before any text extraction, with
 * `failureKind: 'pdf_manual_mapping_required'`. This adapter therefore
 * currently helps only with a CSV whose layout the deterministic parser could
 * not recognise — which is a real and common case, but NOT the case most
 * users would expect ("I have a PDF from my super fund"). Adding PDF text
 * extraction to FDH-12 (the payslip path already does exactly this with
 * `extractPdfPages`) would make this adapter substantially more valuable and
 * is the single highest-value follow-up for this document type. It is out of
 * this dispatch's scope because it changes the native pipeline's accepted
 * input types, not just its failure branch.
 */
export { isAieRetirementAiFallbackEnabled } from './featureFlags';
export {
  retirementDocumentFactsSchema,
  retirementActivitySchema,
  retirementPositionSchema,
  registerRetirementDocumentFactsSchema,
  AIE_RETIREMENT_FACTS_SCHEMA_NAME,
  AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
  AIE_RETIREMENT_MAX_ACTIVITIES,
  AIE_RETIREMENT_MAX_POSITIONS,
  type RetirementDocumentFacts,
  type RetirementActivityFacts,
  type RetirementPositionFacts,
} from './schema';
export { RETIREMENT_FACTS_OPENAI_JSON_SCHEMA } from './openaiSchema';
export {
  mapRetirementFactsToExtraction,
  AIE_RETIREMENT_PARSER_NAME,
  AIE_RETIREMENT_PARSER_VERSION,
  type RetirementMappingContext,
} from './mapping';
export { requestRetirementAiExtraction, RETIREMENT_AI_EXTRACTION_SYSTEM_PROMPT, type RetirementAiExtractionOutcome } from './gateway';
