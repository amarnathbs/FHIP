/**
 * AIE retirement-statement AI-fallback adapter — feature flags.
 *
 * DESIGN NOTE (see docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md).
 * Follows the payslip pattern: call the shared `AieDocumentAiGateway` DIRECTLY
 * from inside the native processing service's own failure branch, rather than
 * the `lib/aie/orchestrator.ts` intake/run/accept pipeline whose three
 * existing adapters were all found to have zero frontend callers.
 *
 * ONE flag for the whole mechanism, matching the payslip and bank-statement
 * adapters. Explicit `'true'` required; anything else — unset, empty, `'1'`,
 * `'TRUE'` — stays OFF. Pilot-cohort gating reuses AIE-1 core's SHARED cohort
 * via `lib/aie/adapters/shared/fallbackGate.ts`; this adapter adds no second
 * allowlist.
 */

export function isAieRetirementAiFallbackEnabled(): boolean {
  return process.env.AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED === 'true';
}
