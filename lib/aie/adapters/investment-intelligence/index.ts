/**
 * AIE-1.2 — Investment Intelligence adapter public surface. One call site
 * (an API route module, or a test's `beforeAll`) calls
 * `registerInvestmentIntelligenceAdapter()` once to make the wrapped CAS/
 * KFintech/Folio-statement parser and the adapter's own AI-fallback schema
 * available to the shared AIE-1.1 orchestrator — nothing else in this
 * module has side effects at import time.
 */
export { registerInvestmentIntelligenceAieParser, investmentIntelligenceRegisteredParser, II_ADAPTER_ID, II_ADAPTER_VERSION, toAieCandidates, candidatesByRecordType, parsedMetadataFromCandidates } from './parserAdapter';
export { registerInvestmentAdapterSchema, AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME, AIE_II_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION, ALLOWED_AI_COMPLETABLE_FIELDS } from './schema';
export { IiAdapterDocumentCatalogue, isDocumentClassCertified } from './documentCatalogue';
export { matchAccountsReadOnly, type AccountMatchOutcome, type AccountMatchingResult, type ExistingAccountForMatching } from './accountMatching';
export { matchInstrumentsReadOnly, schemeKey } from './instrumentMatching';
export { checkStatementPeriod } from './statementMatching';
export { unresolvedItemsForAccountMatches, unresolvedItemForOwnerUnresolved, unresolvedItemsForInstrumentMatches, unresolvedItemForStatementPeriod } from './unresolvedItems';
export { buildInvestmentReconciliationRule, type InvestmentReconciliationContext } from './reconciliationRule';
export { isIiAdapterCanonicalWriteEnabled, isAieIiAdapterEnabled } from './featureFlags';
// M3 (Phase 4) — the I.1 dispatch path and the pieces it needed.
export { dispatchInvestmentDocument, type DispatchParams, type DispatchOutcome } from './dispatch';
export { buildInvestmentReconciliationContext, type BuildContextParams } from './context';
export {
  registerInvestmentDocumentFactsSchema,
  investmentDocumentFactsSchema,
  AIE_II_DOCUMENT_FACTS_SCHEMA_NAME,
  AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION,
  II_MISSING_REASON_CODES,
  II_AI_TRANSACTION_TYPE_CANDIDATES,
  type InvestmentDocumentFacts,
} from './documentFactsSchema';
export {
  compareFieldEvidence,
  unresolvedItemsForDisagreements,
  objectiveResolutionsForAudit,
  isMaterialFinancialField,
  MATERIAL_FINANCIAL_FIELDS,
  type FieldComparison,
  type FieldDisagreementInput,
  type CandidateEvidence,
  type RollForwardTieBreak,
} from './disagreement';
export { acceptAndWriteInvestmentCandidates, createDefaultAcceptAndWriteDeps, type AcceptAndWriteInput, type AcceptAndWriteOutcome, type AcceptAndWriteDeps } from './write';

import { registerInvestmentIntelligenceAieParser } from './parserAdapter';
import { registerInvestmentAdapterSchema } from './schema';

/** Idempotent. Registers this adapter's parser + schema against AIE-1.1's
 * shared registries. Call once per process (module-level import in an API
 * route, or a test's `beforeAll`) before running any document through the
 * AIE-1.1 orchestrator that should reach this adapter. */
export function registerInvestmentIntelligenceAdapter(): void {
  registerInvestmentIntelligenceAieParser();
  registerInvestmentAdapterSchema();
}
