/**
 * AIE-1.4 — Insurance adapter public surface. One call site (an API route
 * module, or a test's `beforeAll`) calls `registerInsuranceAdapter()` once
 * to make this adapter's parser + AI-fallback schema available to the
 * shared AIE-1.1 orchestrator — nothing else in this module has side
 * effects at import time. Same pattern as AIE-1.2's
 * `lib/aie/adapters/investment-intelligence/index.ts`.
 */
export { registerInsuranceAieParser, insuranceRegisteredParser, sniffInsuranceDocument, parseInsuranceDocument, INSURANCE_ADAPTER_ID, INSURANCE_ADAPTER_VERSION } from './parser';
export { registerInsuranceAdapterSchema, AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME, AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION, ALLOWED_AI_COMPLETABLE_FIELDS } from './schema';
export { InsuranceDocumentCatalogue, isInsuranceDocumentClassCertified, type InsuranceDocumentClassEntry } from './documentCatalogue';
export { buildInsuranceReconciliationRule, INSURANCE_REQUIRED_FIELDS } from './reconciliation';
export { isAieInsuranceAdapterEnabled, isInsuranceAdapterCanonicalWriteEnabled } from './featureFlags';
export {
  acceptAndWriteInsuranceCandidates,
  createDefaultAcceptAndWriteInsuranceDeps,
  buildInsurancePolicyRow,
  type AcceptAndWriteInsuranceInput,
  type AcceptAndWriteInsuranceOutcome,
  type AcceptAndWriteInsuranceDeps,
} from './write';

import { registerInsuranceAieParser } from './parser';
import { registerInsuranceAdapterSchema } from './schema';

/** Idempotent. Registers this adapter's parser + schema against AIE-1.1's
 * shared registries. Call once per process (module-level import in an API
 * route, or a test's `beforeAll`) before running any document through the
 * AIE-1.1 orchestrator that should reach this adapter. */
export function registerInsuranceAdapter(): void {
  registerInsuranceAieParser();
  registerInsuranceAdapterSchema();
}
