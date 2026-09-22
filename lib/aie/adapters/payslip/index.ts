/**
 * AIE payslip AI-fallback adapter — public surface. See `featureFlags.ts`'s
 * header for why this adapter's shape (a direct gateway call from inside the
 * native processing service, not the orchestrator/intake/accept pipeline)
 * was chosen, and
 * `docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md` for
 * the full design rationale.
 */
export { isAiePayslipAiFallbackEnabled } from './featureFlags';
export { PAYSLIP_AI_COMPLETABLE_FIELDS, PAYSLIP_AI_MONEY_FIELDS, PAYSLIP_AI_REQUIRED_FIELDS_ANY_OF, type PayslipAiCompletableField } from './types';
export { payslipDocumentFactsSchema, registerPayslipDocumentFactsSchema, AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_NAME, AIE_PAYSLIP_DOCUMENT_FACTS_SCHEMA_VERSION, type PayslipDocumentFacts } from './schema';
export { mapPayslipFactsToExtraction, AIE_PAYSLIP_ADAPTER_PARSER_NAME, AIE_PAYSLIP_ADAPTER_PARSER_VERSION } from './mapping';
export { requestPayslipAiExtraction, type PayslipAiExtractionOutcome } from './gateway';
