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
export { isIiAdapterCanonicalWriteEnabled } from './featureFlags';
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
