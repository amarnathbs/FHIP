/**
 * AIE bank-statement AI-fallback adapter — public surface.
 *
 * RELATIONSHIP TO `lib/aie/adapters/fdhBankStatement/`, STATED EXPLICITLY SO
 * THE DUPLICATION IS A DECISION RATHER THAN A DISCOVERY.
 *
 * That adapter is an AIE-1.3 intake/orchestrator/accept-shaped adapter for
 * the same documents. It is complete and unit-tested, and it is UNREACHABLE:
 * its route `app/api/aie/fdh-bank/intake` has zero frontend callers, as do
 * the insurance and investment-intelligence intake routes — three for three,
 * which is the evidence the design document uses to conclude that the
 * orchestrator shape is not the one that ships here.
 *
 * This adapter is deliberately NOT built on it, for three concrete reasons
 * beyond that:
 *   - it explicitly forbids transaction-level AI ("AIE13-AI-06 forbids AI
 *     from inventing exactly these"), declaring exactly one narrow
 *     AI-completable gap — an institution hint. Transaction-level reading is
 *     precisely what a bank-statement fallback has to do to be worth
 *     anything;
 *   - its own parser collapses the PDF to a single page and always reports
 *     `sourcePage: 1`;
 *   - its commit path calls back into `processBankPdfDocument`, i.e. re-runs
 *     the native parse that already failed.
 *
 * WHAT IS REUSED RATHER THAN REBUILT, which is the part that matters: the
 * masking layer, the provider gateway, the kill switch, the cost ledger, the
 * pilot cohort, and — through `runBankPdfPipelineFromReadRows` — the entire
 * deterministic downstream (fingerprinting, dedupe, reconciliation,
 * certification) and the native canonical write. This adapter contributes
 * only the reading of the page.
 *
 * The recommendation on what to do with the unreached adapter is a decision
 * for the Product Owner and is recorded in the dispatch report, not actioned
 * here.
 */
export { isAieBankStatementAiFallbackEnabled } from './featureFlags';
export {
  bankStatementDocumentFactsSchema,
  bankStatementTransactionSchema,
  registerBankStatementDocumentFactsSchema,
  AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
  AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
  AIE_BANK_STATEMENT_MAX_TRANSACTIONS,
  BANK_STATEMENT_CREDIT_DEBIT,
  type BankStatementDocumentFacts,
  type BankStatementTransactionFacts,
} from './schema';
export { BANK_STATEMENT_FACTS_OPENAI_JSON_SCHEMA } from './openaiSchema';
export {
  mapBankStatementFactsToDraft,
  keepOnlyPrintedBankFigures,
  AIE_BANK_STATEMENT_PARSER_NAME,
  AIE_BANK_STATEMENT_PARSER_VERSION,
  AIE_BANK_STATEMENT_MIN_TRANSACTIONS,
  type MappedBankStatementDraft,
} from './mapping';
export { requestBankStatementAiExtraction, BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT, type BankStatementAiExtractionOutcome } from './gateway';
