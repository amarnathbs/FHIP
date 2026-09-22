/**
 * AIE payslip AI-fallback adapter — feature flags.
 *
 * DESIGN NOTE (see docs/aie-programme/AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md
 * for the full rationale). This adapter deliberately follows the ONE
 * AI-fallback shape in this codebase that has ever actually been reachable
 * from a live upload UI — Investment Intelligence's
 * `lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts`
 * ("mechanism A": call the shared `AieDocumentAiGateway` directly from
 * inside the existing native processing service's own failure branch) —
 * rather than the heavier `lib/aie/orchestrator.ts` intake/run/accept
 * pipeline the Insurance, FDH-bank and Investment-Intelligence-adapter
 * ("mechanism B") adapters use, which the design document's own discovery
 * pass found has ZERO frontend callers for any of the three existing
 * adapters that use it.
 *
 * Matches this codebase's established convention exactly (explicit `'true'`
 * required; anything else stays OFF). ONE flag for the whole mechanism —
 * matching `lib/services/investment-intelligence/aiFallbackFeatureFlag.ts`'s
 * own explicit reasoning ("never become two independently-configurable
 * flags that could drift out of sync") — rather than a separate flag per
 * failure-reason. Pilot-cohort gating deliberately reuses AIE-1 core's
 * SHARED `isAiePilotCohortEnforced()`/`isUserInAiePilotCohort()`
 * (`lib/aie/featureFlags.ts`) instead of cloning a third, adapter-local
 * allowlist the way the II mechanism did — one shared pilot mechanism for
 * every document type is exactly what the design doc recommends going
 * forward.
 */

export function isAiePayslipAiFallbackEnabled(): boolean {
  return process.env.AIE_PAYSLIP_AI_FALLBACK_ENABLED === 'true';
}
