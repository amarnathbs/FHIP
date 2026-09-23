/**
 * AIE bank-statement AI-fallback adapter — feature flags.
 *
 * DESIGN NOTE (see docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md).
 * This adapter follows the payslip pattern: call the shared
 * `AieDocumentAiGateway` DIRECTLY from inside the native processing service's
 * own failure branch, rather than the heavier
 * `lib/aie/orchestrator.ts` intake/run/accept pipeline.
 *
 * THAT CHOICE MATTERS PARTICULARLY HERE, because a bank-statement adapter
 * for the heavier pipeline ALREADY EXISTS and is unreachable:
 * `lib/aie/adapters/fdhBankStatement/` is a complete AIE-1.3 intake adapter
 * whose route (`app/api/aie/fdh-bank/intake`) has zero frontend callers, as
 * the design document's own repo-wide grep established for all three
 * orchestrator-shaped adapters. Building a second adapter rather than wiring
 * that one up is a deliberate, disclosed decision, not an oversight — see
 * this directory's `index.ts` header for what is reused from it and what is
 * not, and the dispatch report for the recommendation on its future.
 *
 * ONE flag for the whole mechanism, matching the payslip adapter and
 * `aiFallbackFeatureFlag.ts`'s own explicit reasoning ("never become two
 * independently-configurable flags that could drift out of sync"). Explicit
 * `'true'` required; anything else — unset, empty, `'1'`, `'TRUE'` — stays
 * OFF. Pilot-cohort gating reuses AIE-1 core's SHARED cohort via
 * `lib/aie/adapters/shared/fallbackGate.ts`; this adapter adds no second
 * allowlist.
 */

export function isAieBankStatementAiFallbackEnabled(): boolean {
  return process.env.AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED === 'true';
}
