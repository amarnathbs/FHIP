/**
 * AIE AU investment-statement (FDH-11) AI-fallback adapter — public surface.
 *
 * WHICH "INVESTMENT" THIS IS, AND WHY IT IS A SEPARATE ADAPTER RATHER THAN A
 * REUSE — stated here so the separation is a decision rather than a discovery.
 *
 * This adapter serves FDH-11: the AU broker/fund CSV statement pipeline behind
 * the Investments tab, whose evidence lands in `fdh_investment_statements` /
 * `_positions` / `_activities` and only ever reaches canonical Investment
 * Intelligence through the explicit, user-pressed "Apply" bridge.
 *
 * `lib/aie/adapters/investment-intelligence/` is a DIFFERENT module's adapter
 * for a different document family (Indian CAS/folio statements) with a
 * different canonical destination (`ii_*` tables). Its
 * `documentFactsSchema.ts` is additionally the schema design-document §6.1
 * records as having been unusable in production for want of a `KNOWN_SCHEMAS`
 * registration. Reusing it here would be wrong on domain grounds alone — and
 * it would also break the two isolation suites (`tests/unit/
 * fdh11Isolation.test.ts`, `tests/unit/fdh1Isolation.test.ts`) that
 * mechanically enforce that FDH-11 code never imports Investment Intelligence
 * code. Nothing in this directory imports from either
 * `lib/services/investment-intelligence/**` or
 * `lib/aie/adapters/investment-intelligence/**`.
 *
 * WHAT IS REUSED RATHER THAN REBUILT, which is the part that matters: the
 * masking layer, the shared provider gateway, the shared kill switch, the
 * shared cost ledger, the shared pilot cohort, the shared Zod field builders
 * and the shared strict-JSON-Schema builders — and, on the far side of the
 * user's confirmation, FDH-11's OWN canonical evidence write
 * (`persistAuInvestmentEvidence`), security matching, holdings reconciliation
 * and bank matching. This adapter contributes only the reading of the page.
 */
export { isAieInvestmentStatementAiFallbackEnabled } from './featureFlags';
export {
  auInvestmentDocumentFactsSchema,
  auInvestmentHoldingSchema,
  auInvestmentActivitySchema,
  registerAuInvestmentDocumentFactsSchema,
  AIE_AU_INVESTMENT_FACTS_SCHEMA_NAME,
  AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION,
  AIE_AU_INVESTMENT_MAX_HOLDINGS,
  AIE_AU_INVESTMENT_MAX_TRANSACTIONS,
  type AuInvestmentDocumentFacts,
  type AuInvestmentHoldingFacts,
  type AuInvestmentActivityFacts,
} from './schema';
export { AU_INVESTMENT_FACTS_OPENAI_JSON_SCHEMA } from './openaiSchema';
export {
  mapAuInvestmentFactsToExtraction,
  AIE_AU_INVESTMENT_PARSER_NAME,
  AIE_AU_INVESTMENT_PARSER_VERSION,
  AIE_AU_INVESTMENT_MIN_ROWS,
  AIE_AU_INVESTMENT_EXTRACTION_CONFIDENCE,
  type AuInvestmentMappingContext,
} from './mapping';
export { requestAuInvestmentAiExtraction, AU_INVESTMENT_AI_EXTRACTION_SYSTEM_PROMPT, type AuInvestmentAiExtractionOutcome } from './gateway';
